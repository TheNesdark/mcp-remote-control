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
}

export async function runCommand(cmd: string[], opts: RunCommandOptions = {}): Promise<CommandResult> {
  const env = snapshotEnv(opts.env);

  const proc = Bun.spawn({
    cmd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
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
