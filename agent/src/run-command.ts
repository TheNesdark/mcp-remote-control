/**
 * Runs a local command and captures its output. Used by the inventory,
 * process-list and screenshot handlers (never exposed to the server directly).
 */
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
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

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
