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
 * The job result is sent *before* the process dies (the caller sees "ok" even
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
  spawnDetached?: (scriptPath: string) => void;
}

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
      `move /y "${updatePath}" "${exe}" >nul || exit /b 1`,
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
  spawn(scriptPath);
  return { meta: { ok: true, platform, execPath, updating: Boolean(params.updatePath), script: basename(scriptPath) } };
}

function defaultSpawnDetached(scriptPath: string): void {
  // wmic spawns the cmd fully detached from this process' job; when wmic is
  // absent (future Windows), fall back to a `start` from cmd which detaches
  // from the agent process but not fully from its console session.
  let wmicOk = false;
  try {
    const wmic = Bun.spawnSync(["wmic", "process", "call", "create", scriptPath], { timeout: 10_000 });
    wmicOk = (wmic.exitCode ?? 1) === 0 && String(wmic.stdout ?? "").includes("ReturnValue = 0");
  } catch {
    // wmic.exe was removed in Windows 11 21H2+; fall through to cmd /c start.
  }
  if (!wmicOk) {
    try {
      Bun.spawnSync(["cmd.exe", "/c", "start", "", "/min", scriptPath], { timeout: 10_000 });
    } catch {
      // Best-effort: the detached script may not survive the agent exit, but
      // the swap still happened and the user can relaunch manually.
    }
  }
}
