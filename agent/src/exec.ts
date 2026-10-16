/**
 * Command execution for the agent.
 *
 * - Streams stdout/stderr through callbacks (each read becomes a chunk).
 * - Enforces the job timeout by itself (belt and braces: the server also
 *   cancels) and kills the whole process tree:
 *     Windows -> `taskkill /PID <pid> /T /F`
 *     POSIX   -> SIGKILL to the process group (spawned detached)
 * - Supports cancellation via `job.cancel` from the server.
 */
import { spawn, type Subprocess } from "bun";
import type { ExecParams } from "@mrc/shared";

export interface ExecRequest extends ExecParams {
  jobId: string;
  timeoutMs: number;
}

export type OutputStreamName = "stdout" | "stderr";

export interface RunningExec {
  cancel: () => void;
}

export interface ExecHooks {
  onOutput: (stream: OutputStreamName, seq: number, data: string) => void;
  /** Called right after spawn so the caller can cancel the job mid-flight. */
  onHandle?: (handle: RunningExec) => void;
}

export interface ExecResult {
  ok: boolean;
  exitCode?: number;
  durationMs: number;
  error?: string;
}

/** Hard cap for agent-side timeouts (the server caps too). */
export const MAX_EXEC_TIMEOUT_MS = 3_600_000;

type SpawnedProcess = Subprocess<"ignore", "pipe", "pipe">;

export function buildCommand(shell: ExecParams["shell"], command: string): string[] {
  const isWindows = process.platform === "win32";
  if (shell === "powershell") {
    return isWindows
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
      : ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command];
  }
  // `cmd` and `native` both mean the platform shell.
  return isWindows ? ["cmd.exe", "/d", "/s", "/c", command] : ["sh", "-c", command];
}

function killProcessTree(pid: number, isWindows: boolean, proc: SpawnedProcess): void {
  if (isWindows) {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
      return;
    } catch {
      // fall through to a plain kill
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL"); // whole process group
      return;
    } catch {
      // fall through to a plain kill
    }
  }
  try {
    proc.kill(9);
  } catch {
    // already gone
  }
}

export async function runExec(req: ExecRequest, hooks: ExecHooks): Promise<ExecResult> {
  const startedAt = Date.now();
  const isWindows = process.platform === "win32";
  const timeoutMs = Math.min(req.timeoutMs, MAX_EXEC_TIMEOUT_MS);

  let proc: SpawnedProcess;
  try {
    proc = spawn({
      cmd: buildCommand(req.shell, req.command),
      ...(req.cwd ? { cwd: req.cwd } : {}),
      env: { ...process.env, ...req.env } as Record<string, string>,
      stdin: req.stdin != null ? new TextEncoder().encode(req.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Own process group on POSIX so the whole tree can be killed.
      detached: !isWindows,
    }) as SpawnedProcess;
  } catch (err) {
    return { ok: false, durationMs: Date.now() - startedAt, error: `failed to start command: ${String(err)}` };
  }

  let settled = false;
  let killReason: string | null = null;

  const requestKill = (reason: string): void => {
    if (settled || killReason) return;
    killReason = reason;
    if (proc.pid) killProcessTree(proc.pid, isWindows, proc);
  };

  const timer = setTimeout(() => requestKill(`timed out after ${timeoutMs}ms`), timeoutMs);
  hooks.onHandle?.({ cancel: () => requestKill("cancelled") });

  const decoderOut = new TextDecoder();
  const decoderErr = new TextDecoder();

  const pump = async (stream: ReadableStream<Uint8Array>, name: OutputStreamName, decoder: TextDecoder): Promise<void> => {
    let seq = 0;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          const text = decoder.decode(value, { stream: true });
          if (text) hooks.onOutput(name, seq++, text);
        }
      }
      const tail = decoder.decode();
      if (tail) hooks.onOutput(name, seq++, tail);
    } catch {
      // stream aborted by the kill; nothing left to drain
    }
  };

  const pumps = [pump(proc.stdout, "stdout", decoderOut), pump(proc.stderr, "stderr", decoderErr)];
  const exitCode = await proc.exited;
  settled = true;
  clearTimeout(timer);
  await Promise.all(pumps);

  const durationMs = Date.now() - startedAt;
  if (killReason) {
    return {
      ok: false,
      exitCode: typeof exitCode === "number" ? exitCode : undefined,
      durationMs,
      error: killReason,
    };
  }
  return { ok: exitCode === 0, exitCode, durationMs };
}
