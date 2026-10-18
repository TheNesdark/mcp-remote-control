/**
 * Agent auto-update (pull model).
 *
 * The server announces its published build in `welcome`
 * (`latestAgentVersion`, `agentBinaryUrl`, `agentBinarySha256`). On every
 * connect the agent compares that against its own version and, when the
 * server is ahead, downloads the binary, verifies its sha256 and defers to
 * the same detached swap+relaunch used by `agent_restart`.
 *
 * Pull (agent asks on connect) instead of push (server tells everyone at
 * startup) is what makes this survive redeploys: at server start no agent is
 * connected yet, while every agent asks exactly when it reconnects.
 *
 * Guards:
 * - only standalone executables update themselves (a dev `bun run` agent has
 *   no single file to swap);
 * - disabled by --no-auto-update / MRC_AUTO_UPDATE=0;
 * - never downgrade: the published version must be strictly newer;
 * - sha256 must match when the server sends one;
 * - the previous binary is kept as `<exe>.old` (rollback by renaming it back).
 */
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WelcomeMsg } from "@mrc/shared";
import { compareVersions } from "@mrc/shared/version";
import { restartAgent } from "./restart.ts";

export { compareVersions };

export interface AutoUpdateOptions {
  /** The agent's own version (VERSION in index.ts). */
  currentVersion: string;
  /** Disable entirely (--no-auto-update). */
  enabled?: boolean;
  /** Running executable, defaults to process.execPath. */
  execPath?: string;
  platform?: NodeJS.Platform;
  standalone?: boolean;
  /** Origin used to resolve relative binary URLs (ws url of the server). */
  serverUrl?: string;
  log?: (line: string, fields?: Record<string, unknown>) => void;
  /** Injected for tests. */
  download?: (url: string, dest: string) => Promise<string>;
  relaunch?: typeof restartAgent;
}

export type AutoUpdateDecision =
  | { action: "none"; reason: string }
  | { action: "update"; version: string; url: string }
  | { action: "skip"; reason: string };

/** Resolve a possibly relative binary URL against the hub's http(s) origin. */
export function resolveBinaryUrl(raw: string, serverUrl: string | undefined): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!serverUrl) throw new Error("cannot resolve a relative agent binary URL without the server URL");
  const scheme = serverUrl.startsWith("wss:") ? "https:" : "http:";
  const origin = serverUrl.replace(/^wss?:/i, scheme).replace(/\/agent.*$/, "").replace(/\/+$/, "");
  return `${origin}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

/**
 * Decide from a `welcome` frame whether this agent should update. Pure: no
 * I/O, so the policy is unit-testable.
 */
export function decideAutoUpdate(welcome: WelcomeMsg, opts: AutoUpdateOptions): AutoUpdateDecision {
  if (opts.enabled === false) return { action: "none", reason: "auto-update disabled" };
  if (opts.standalone === false) return { action: "none", reason: "not a standalone executable" };
  const latest = welcome.latestAgentVersion;
  if (!latest) return { action: "none", reason: "server publishes no agent build" };
  if (compareVersions(latest, opts.currentVersion) <= 0) {
    return { action: "none", reason: `up to date (${opts.currentVersion})` };
  }
  if (!welcome.agentBinaryUrl) return { action: "skip", reason: "server announced a version without a binary URL" };
  return {
    action: "update",
    version: latest,
    // resolved lazily so an unusable URL only fails the update step, not the decision
    url: welcome.agentBinaryUrl,
  };
}

async function defaultDownload(url: string, dest: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} from ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await Bun.write(dest, bytes);
  const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return hash;
}

/**
 * Full flow: decide, download next to the exe, verify, swap+relaunch.
 * Returns what happened; throws only on real failures (bad hash, download).
 */
export async function handleAutoUpdate(
  welcome: WelcomeMsg,
  opts: AutoUpdateOptions,
): Promise<{ decision: AutoUpdateDecision; updated?: boolean; sha256?: string }> {
  const decision = decideAutoUpdate(welcome, opts);
  const log = opts.log ?? (() => {});
  if (decision.action !== "update") {
    if (decision.action === "skip") log("auto-update skipped", { reason: decision.reason });
    return { decision };
  }

  const execPath = opts.execPath ?? process.execPath;
  const platform = opts.platform ?? process.platform;
  const url = resolveBinaryUrl(decision.url, opts.serverUrl);
  const staged = join(
    execPath.slice(0, Math.max(execPath.lastIndexOf("/"), execPath.lastIndexOf("\\"))) || ".",
    `${basename(execPath, platform === "win32" ? ".exe" : undefined)}.new${platform === "win32" ? ".exe" : ""}`,
  );

  log("auto-update downloading", { version: decision.version, url, staged });
  const sha256 = await (opts.download ?? defaultDownload)(url, staged);

  const expected = welcome.agentBinarySha256?.toLowerCase();
  if (expected && expected !== sha256) {
    await rename(staged, `${staged}.bad`).catch(() => {});
    throw new Error(`auto-update rejected: sha256 mismatch (expected ${expected.slice(0, 16)}…, got ${sha256.slice(0, 16)}…)`);
  }
  if (!existsSync(staged)) throw new Error("auto-update failed: the downloaded binary is missing");

  log("auto-update swapping and relaunching", { from: opts.currentVersion, to: decision.version });
  await (opts.relaunch ?? restartAgent)({ updatePath: staged }, { platform, execPath });
  return { decision, updated: true, sha256 };
}
