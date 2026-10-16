/**
 * JobManager: dispatches `job.request` messages to the right handler and
 * tracks running jobs so `job.cancel` can kill them.
 */
import { ExecParams as ExecParamsSchema, type AgentMsg, type JobCancelMsg, type JobRequestMsg } from "@mrc/shared";
import { runExec, type RunningExec } from "./exec.ts";

export interface JobManagerOptions {
  send: (msg: AgentMsg) => void;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  maxConcurrent?: number;
}

const DEFAULT_MAX_CONCURRENT = 4;

export class JobManager {
  private readonly running = new Map<string, RunningExec>();
  private readonly maxConcurrent: number;

  constructor(private readonly opts: JobManagerOptions) {
    this.maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  get runningCount(): number {
    return this.running.size;
  }

  handleRequest(msg: JobRequestMsg): void {
    if (this.running.size >= this.maxConcurrent) {
      this.sendResult(msg.jobId, {
        ok: false,
        durationMs: 0,
        error: `agent is busy (${this.running.size} jobs running, max ${this.maxConcurrent})`,
      });
      return;
    }
    switch (msg.jobType) {
      case "exec":
        void this.handleExec(msg);
        return;
      default:
        this.sendResult(msg.jobId, {
          ok: false,
          durationMs: 0,
          error: `unsupported job type '${msg.jobType}'`,
        });
    }
  }

  handleCancel(msg: JobCancelMsg): void {
    const job = this.running.get(msg.jobId);
    if (!job) return; // already finished
    this.opts.log("job cancel requested", { jobId: msg.jobId });
    job.cancel();
  }

  /** Kill every running job (connection lost / agent shutting down). */
  cancelAll(): void {
    for (const job of this.running.values()) job.cancel();
  }

  private async handleExec(msg: JobRequestMsg): Promise<void> {
    const parsed = ExecParamsSchema.safeParse(msg.params);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.sendResult(msg.jobId, {
        ok: false,
        durationMs: 0,
        error: `invalid exec params: ${issue ? `${issue.path.join(".") || "params"}: ${issue.message}` : "validation failed"}`,
      });
      return;
    }

    this.opts.log("exec job started", { jobId: msg.jobId, shell: parsed.data.shell });
    const result = await runExec({ ...parsed.data, jobId: msg.jobId, timeoutMs: msg.timeoutMs }, {
      onOutput: (stream, seq, data) => {
        this.opts.send({ type: "job.output", jobId: msg.jobId, stream, seq, data });
      },
      onHandle: (handle) => {
        this.running.set(msg.jobId, handle);
      },
    });
    this.running.delete(msg.jobId);
    this.opts.log("exec job finished", { jobId: msg.jobId, ok: result.ok, exitCode: result.exitCode ?? null });
    this.sendResult(msg.jobId, result);
  }

  private sendResult(
    jobId: string,
    result: { ok: boolean; exitCode?: number; durationMs: number; error?: string },
  ): void {
    this.opts.send({
      type: "job.result",
      jobId,
      ok: result.ok,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    });
  }
}
