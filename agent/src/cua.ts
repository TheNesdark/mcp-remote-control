/**
 * Cua Driver provisioning (the `cua` capability).
 *
 * The GUI stack is not ours: we ship and supervise Cua Driver (trycua/cua,
 * MIT). The hub serves the official release zip (the Dockerfile downloads it
 * at build time, MRC_CUA_DRIVER_PATH) and announces {version, sha256, url} in
 * `welcome`; this module keeps a verified copy under
 * %LOCALAPPDATA%\mcp-remote-control\cua so LAN machines provision themselves
 * without internet access. Only the Windows exe matters here — Linux/macOS
 * agents never advertise `cua` and never run any of this.
 *
 * Official *-windows-x86_64-binary.zip layout: cua-driver.exe,
 * cua-driver-uia.exe, cua-cursor-theme.exe, cua_driver_sdk.dll and friends —
 * we extract the whole tree and invoke `cua-driver.exe` from that DIRECTORY
 * (the SDK dll lives next to it), never relying on PATH.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "@mrc/shared/log";
import { compareVersions } from "@mrc/shared/version";

/** Where the driver is unpacked (survives agent updates; ours, not the exe's). */
export function defaultDriverDir(): string {
  const root = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Local");
  return join(root, "mcp-remote-control", "cua");
}

export function driverExePath(dir = defaultDriverDir()): string {
  return join(dir, "cua-driver.exe");
}

/** Version line from `cua-driver --version` ("cua-driver 0.36.0"). */
export function parseDriverVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match ? match[1]! : null;
}

/** The exe exists and answers; daemon status is a separate, softer signal. */
export function installedDriverVersion(dir = defaultDriverDir()): string | null {
  const exe = driverExePath(dir);
  if (!existsSync(exe)) return null;
  try {
    const proc = Bun.spawnSync([exe, "--version"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    if ((proc.exitCode ?? 1) !== 0) return null;
    return parseDriverVersion(new TextDecoder().decode(proc.stdout ?? new Uint8Array()));
  } catch {
    return null;
  }
}

/** Extract `zipPath` into `dir` (clean slate) with the PowerShell shell API. */
export function unpackDriverZip(zipPath: string, dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const proc = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      // Unblock-File strips the Mark of the Web the extraction would inherit:
      // without it, SmartScreen/WDAC policies can refuse the unsigned driver exe.
      `Expand-Archive -LiteralPath '${zipPath.replaceAll("'", "''")}' -DestinationPath '${dir.replaceAll("'", "''")}' -Force;` +
      ` Get-ChildItem -LiteralPath '${dir.replaceAll("'", "''")}' -Recurse -File | Unblock-File`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 },
  );
  if ((proc.exitCode ?? 1) !== 0) {
    const err = new TextDecoder().decode(proc.stderr ?? new Uint8Array()).trim().slice(0, 400);
    throw new Error(`could not extract the Cua Driver zip${err ? `: ${err}` : ""}`);
  }
}

export interface CuaAnnouncement {
  version: string;
  sha256: string;
  url: string;
}

export interface ProvisionDeps {
  driverDir?: string;
  fetchFn?: typeof fetch;
  /** Injection points for tests (Windows extraction/autostart cannot run on Linux). */
  unpack?: (zipPath: string, dir: string) => void;
  enableAutostart?: (dir: string) => void;
}

export interface ProvisionResult {
  downloaded: boolean;
  version: string;
}

/**
 * Make sure the driver exists locally and matches the announcement. Throws on
 * sha256 mismatch or a broken download — the hub stays authoritative and a
 * corrupt zip never lands on the desktop.
 */
export async function provisionCuaDriver(
  announce: CuaAnnouncement,
  opts: { hubOrigin: string; token: string },
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  const dir = deps.driverDir ?? defaultDriverDir();
  const current = installedDriverVersion(dir);
  if (current && compareVersions(current, announce.version) >= 0) {
    return { downloaded: false, version: current };
  }

  const fetchFn = deps.fetchFn ?? fetch;
  const url = /^https?:\/\//i.test(announce.url) ? announce.url : `${opts.hubOrigin}${announce.url.startsWith("/") ? "" : "/"}${announce.url}`;
  logger.info("Cua Driver provisioning started", { from: current ?? "none", to: announce.version, url });

  const res = await fetchFn(url, { headers: opts.token ? { authorization: `Bearer ${opts.token}` } : undefined });
  if (!res.ok) throw new Error(`Cua Driver download failed: HTTP ${res.status} from ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (announce.sha256 && sha256 !== announce.sha256.toLowerCase()) {
    throw new Error(
      `Cua Driver rejected: sha256 mismatch (expected ${announce.sha256.slice(0, 16)}…, got ${sha256.slice(0, 16)}…)`,
    );
  }

  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const zipPath = join(parent, `cua-driver-${announce.version}.zip`);
  writeFileSync(zipPath, bytes);
  try {
    (deps.unpack ?? unpackDriverZip)(zipPath, dir);
  } finally {
    rmSync(zipPath, { force: true });
  }

  const installed = (deps.unpack ? announce.version : installedDriverVersion(dir));
  if (!installed) throw new Error("Cua Driver was extracted but does not run (Defender quarantine? missing VC runtime?)");
  logger.info("Cua Driver provisioned", { version: installed, dir });

  // The interactive-session daemon is the point of the driver; try to have it
  // running + autostarted. Failure is non-fatal (agent_cua_status reports it,
  // and a call to `cua-driver call` starts the runtime anyway).
  try {
    (deps.enableAutostart ?? defaultEnableAutostart)(dir);
  } catch {
    logger.warn("Cua Driver autostart could not be enabled");
  }
  return { downloaded: true, version: installed };
}

/** Enable + kick the autostart entry (best effort, see provisionCuaDriver). */
function defaultEnableAutostart(dir: string): void {
  Bun.spawnSync([driverExePath(dir), "autostart", "enable"], { stdout: "ignore", stderr: "ignore", timeout: 30_000 });
  Bun.spawnSync([driverExePath(dir), "autostart", "kick"], { stdout: "ignore", stderr: "ignore", timeout: 30_000 });
}
