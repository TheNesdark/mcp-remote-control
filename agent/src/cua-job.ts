/**
 * `cua` job handler: the thin bridge between the hub and Cua Driver.
 *
 * The agent never interprets the driver protocol. `call` runs exactly
 * `cua-driver.exe call <tool>` with the tool's JSON on stdin (fixed argv:
 * the exe path comes from our own directory and the tool name is matched
 * against ^[a-z0-9_]+$ so it cannot smuggle flags), and returns the driver's
 * own stdout/stderr/exit code as the job meta. With `screenshot:true` the
 * CLI's `--screenshot-out-file` image is reported as `meta.screenshotPath`
 * and the hub pulls it via the chunked fs transfer; the agent keeps the PNG
 * on disk (short-lived shots dir) until the server fetches it, pruning older
 * files. `setup` (re)downloads the announced driver; `status` reports the
 * local install plus the daemon state.
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CuaParams } from "@mrc/shared";
import type { ShortJobResult } from "./job-result.ts";
import {
  defaultDriverDir,
  driverExePath,
  installedDriverVersion,
  provisionCuaDriver,
  type CuaAnnouncement,
} from "./cua.ts";

/** Announced driver (from `welcome`), provided by index.ts for setup calls. */
export interface CuaBridge {
  announcement: () => CuaAnnouncement | null;
  hubOrigin: () => string;
  token: () => string;
}

/** Tool names come from the hub manifest; keep the argv boring. */
const SAFE_TOOL_NAME = /^[a-z0-9_]{1,64}$/;

export async function runCuaJob(params: CuaParams, bridge: CuaBridge): Promise<ShortJobResult> {
  if (params.action === "status") {
    const version = installedDriverVersion();
    return {
      meta: {
        installed: version !== null,
        version,
        dir: defaultDriverDir(),
        daemon: version ? daemonStatus() : null,
        announced: bridge.announcement()?.version ?? null,
      },
    };
  }

  if (params.action === "setup") {
    const announce = bridge.announcement();
    if (!announce) {
      return { meta: { ok: false, error: "the server announced no Cua Driver build" } };
    }
    try {
      const result = await provisionCuaDriver(announce, { hubOrigin: bridge.hubOrigin(), token: bridge.token() });
      return { meta: { ok: true, ...result } };
    } catch (err) {
      return { meta: { ok: false, error: `setup failed: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  /** Per-call shot files live here so the hub can fs.transfer them after the job. */
  const SHOT_KEEP_MS = 10 * 60_000;

  function shotDirPath(): string {
    return join(defaultDriverDir(), "shots");
  }

  function pruneShotDir(): void {
    const dir = shotDirPath();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // dir missing is fine
    }
    const now = Date.now();
    for (const name of names) {
      try {
        if (now - statSync(join(dir, name)).mtimeMs > SHOT_KEEP_MS) unlinkSync(join(dir, name));
      } catch {
        // a racing delete or an unreadable entry is not worth failing the job
      }
    }
  }

  // action === "call" from here on
  const exe = driverExePath();
  if (!existsSync(exe)) {
    return { meta: { ok: false, error: "cua driver is not installed on this agent; the hub announces it in welcome and the agent provisions it automatically" } };
  }
  if (!params.tool || !SAFE_TOOL_NAME.test(params.tool)) {
    return { meta: { ok: false, error: `invalid cua tool name '${params.tool ?? ""}'` } };
  }

  const args = [exe, "call", params.tool];
  // pass the path as a CLI flag AND inside the JSON args, so either channel
  // the driver honors produces the same on-disk PNG the hub later transfers
  const shotFile = params.screenshot
    ? join(shotDirPath(), `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${params.tool}.png`)
    : null;
  if (shotFile) {
    mkdirSync(shotDirPath(), { recursive: true });
    args.push("--screenshot-out-file", shotFile);
    params.args = { ...(params.args ?? {}), screenshot_out_file: shotFile };
  }

  try {
    const proc = Bun.spawn(args, {
      stdin: params.args ? Buffer.from(JSON.stringify(params.args), "utf8") : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000,
    });
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    const exitCode = await proc.exited;

    const meta: Record<string, unknown> = { exitCode, stdout, stderr: stderr.slice(0, 4_000) };
    if (shotFile && existsSync(shotFile)) {
      meta.screenshotPath = shotFile;
      try { meta.screenshotBytes = Bun.file(shotFile).size; } catch { /* fine */ }
      pruneShotDir(); // drop shots older than SHOT_KEEP_MS, keep this one
    }
    if (exitCode !== 0) {
      meta.ok = false;
      meta.error = stderr.trim().slice(0, 800) || `cua-driver exited ${exitCode}`;
    } else {
      meta.ok = true;
    }
    return { meta };
  } catch (err) {
    return { meta: { ok: false, error: `cua-driver call failed: ${String(err)}` } };
  }
}

/** One-line daemon state from `cua-driver status`; null when it does not answer. */
function daemonStatus(): string | null {
  try {
    const proc = Bun.spawnSync([driverExePath(), "status"], { stdout: "pipe", stderr: "pipe", timeout: 15_000 });
    const out = new TextDecoder().decode(proc.stdout ?? new Uint8Array()).trim();
    return out ? out.split("\n")[0]! : null;
  } catch {
    return null;
  }
}
