/**
 * Agent restart / self-update (`restart` job).
 *
 * Windows compiled executables cannot be overwritten while running, so the
 * update flow is the classic relaunch dance, executed by a detached cmd script
 * that survives the agent being killed:
 *
 *   1. the caller (server tool) uploads the new binary to `updatePath`
 *      (agent_fs_upload) — same directory as the running exe so rename works;
 *   2. `restart` with updatePath: the exe renames itself to <name>.old
 *      (allowed on Windows while running), moves the new file onto its own
 *      name, waits, re-launches itself and deletes <name>.old;
 *   3. `restart` without updatePath: just relaunch the same binary.
 *
 * On Windows this process **exits** shortly after spawning the script: the
 * relaunched instance must be the only one running, otherwise the old process
 * keeps the hub connection (same agent id) and the fresh instance can never
 * log in — which is exactly what happened when applying settings changes. The
 * job result is sent *before* the process dies (the caller sees "ok" even
 * though the websocket drops right after). On POSIX (dev hosts) the job is
 * validated and logged but does not actually kill anything: restarting a dev
 * agent managed by a shell loop is the operator's business.
 */
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ShortJobResult } from "./job-result.ts";

export interface RestartParams {
  /** Staged new binary (uploaded via agent_fs_upload) to swap in before relaunch. */
  updatePath?: string;
  /** Extra CLI args for the relaunched process (defaults to the current argv). */
  args?: string[];
}

export interface RestartDeps {
  platform?: NodeJS.Platform;
  execPath?: string;
  argv?: string[];
  /** Launches the script fully detached; returns false when that failed. */
  spawnDetached?: (scriptPath: string) => boolean;
  /**
   * Arms the process exit once the detached relaunch script is running; the
   * argument is the grace delay in ms (default: `process.exit(0)` after
   * RESTART_EXIT_DELAY_MS). Overridable so unit tests observe the scheduled
   * exit without dying.
   */
  scheduleExit?: (delayMs: number) => void;
}

/** Grace between spawning the script and exiting: enough to flush job.result. */
export const RESTART_EXIT_DELAY_MS = 1_500;

/** cmd script: swap exe (rename self -> .old, stage -> self), wait, relaunch, cleanup. */
export function buildWindowsRestartScript(exe: string, updatePath: string | null, args: string[]): string {
  const quoted = args.map((a) => `"${a.replaceAll('"', '\\"')}"`).join(" ");
  const lines = [
    "@echo off",
    "rem wait so the agent can send its job.result and close sockets",
    "ping -n 6 127.0.0.1 >nul",
  ];
  if (updatePath) {
    lines.push(
      `move /y "${exe}" "${exe}.old" >nul || exit /b 1`,
      // copy + delete instead of move: works across drives (network shares,
      // USB, ...), which a cross-drive `move` does not.
      `copy /y "${updatePath}" "${exe}" >nul || exit /b 1`,
      `del /f /q "${updatePath}" >nul 2>&1`,
    );
  }
  lines.push(`start "" "${exe}" ${quoted}`, `del /f /q "${exe}.old" >nul 2>&1`);
  return `${lines.join("\r\n")}\r\n`;
}

export async function restartAgent(params: RestartParams, deps: RestartDeps = {}): Promise<ShortJobResult> {
  const platform = deps.platform ?? process.platform;
  const execPath = deps.execPath ?? process.execPath;
  // argv[1..] are the agent's own flags; a standalone exe argv is [exe], a dev
  // `bun run index.ts ...` argv would relaunch via bun, which a detached cmd
  // cannot reproduce — so args only apply to standalone exes (isStandaloneExecutable).
  const standalone = Bun.isStandaloneExecutable;
  const args = params.args ?? (standalone && platform === "win32" ? (deps.argv ?? process.argv).slice(1) : []);

  if (params.updatePath && platform !== "win32") {
    throw new Error("restart with updatePath is only supported on Windows agents");
  }

  if (platform !== "win32") {
    return {
      meta: { ok: true, platform, execPath, note: "posix agent: restart requested; relaunch is managed by the supervisor" },
    };
  }

  const dir = dirname(execPath);
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, `mrc-restart-${Date.now()}.bat`);
  await Bun.write(scriptPath, buildWindowsRestartScript(execPath, params.updatePath ?? null, args));

  const spawn = deps.spawnDetached ?? defaultSpawnDetached;
  if (!spawn(scriptPath)) {
    return {
      meta: {
        ok: false,
        platform,
        execPath,
        error: "could not launch the detached relaunch script; restart the agent manually to apply changes",
        script: basename(scriptPath),
      },
    };
  }

  // This process must die or it keeps owning the hub connection (same agent
  // id) and the relaunched instance can never connect. The script waits ~5s
  // before starting the new instance, so exiting after a short grace period
  // is safe; the grace lets the job.result frame flush first.
  const scheduleExit = deps.scheduleExit ?? defaultScheduleExit;
  scheduleExit(RESTART_EXIT_DELAY_MS);
  return { meta: { ok: true, platform, execPath, updating: Boolean(params.updatePath), script: basename(scriptPath), exiting: true } };
}

/** Arm the process exit after `delayMs` (unref'd so it never holds the loop). */
function defaultScheduleExit(delayMs: number): void {
  const timer = setTimeout(() => process.exit(0), delayMs);
  timer.unref?.();
}

function defaultSpawnDetached(scriptPath: string): boolean {
  // wmic spawns the cmd fully detached from this process' job; when wmic is
  // absent (future Windows), fall back to a `start` from cmd which detaches
  // from the agent process but not fully from its console session.
  try {
    const wmic = Bun.spawnSync(["wmic", "process", "call", "create", scriptPath], { timeout: 10_000 });
    if ((wmic.exitCode ?? 1) === 0 && String(wmic.stdout ?? "").includes("ReturnValue = 0")) return true;
  } catch {
    // wmic.exe was removed in Windows 11 21H2+; fall through to cmd /c start.
  }
  try {
    const start = Bun.spawnSync(["cmd.exe", "/c", "start", "", "/min", scriptPath], { timeout: 10_000 });
    return (start.exitCode ?? 1) === 0;
  } catch {
    return false;
  }
}
