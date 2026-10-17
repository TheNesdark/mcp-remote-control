/**
 * Runs a local command and captures its output. Used by the inventory,
 * process-list and screenshot handlers (never exposed to the server directly).
 */
import { snapshotEnv } from "@mrc/shared/env";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /**
   * Windows: let the child create a console and show its first GUI window.
   *
   * `windowsHide: true` (the default) maps to libuv's
   * `UV_PROCESS_WINDOWS_HIDE`, which sets `STARTUPINFO.wShowWindow = SW_HIDE`.
   * That hides the child's FIRST top-level window, which for a PowerShell
   * WinForms dialog is the form itself: the dialog runs but stays invisible.
   * Set this for commands that must show a window (first-run/settings dialogs).
   */
  showWindow?: boolean;
}

export async function runCommand(cmd: string[], opts: RunCommandOptions = {}): Promise<CommandResult> {
  const env = snapshotEnv(opts.env);

  const proc = Bun.spawn({
    cmd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
    windowsHide: !opts.showWindow,
  });

  let timer: Timer | null = null;
  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }, opts.timeoutMs);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
}
