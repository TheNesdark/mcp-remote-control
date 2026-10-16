/**
 * JobManager: dispatches `job.request` messages to the right handler and
 * tracks running jobs so `job.cancel` can kill them.
 */
import {
  ExecParams as ExecParamsSchema,
  FsHashParams as FsHashSchema,
  FsListParams as FsListSchema,
  FsReadParams as FsReadSchema,
  FsWriteParams as FsWriteSchema,
  InfoParams as InfoSchema,
  PsKillParams as PsKillSchema,
  PsListParams as PsListSchema,
  ScreenshotParams as ScreenshotSchema,
  type AgentMsg,
  type JobCancelMsg,
  type JobRequestMsg,
} from "@mrc/shared";
import { runExec, type RunningExec } from "./exec.ts";
import { fsHash, fsList, fsRead, fsWrite } from "./fs.ts";
import type { ShortJobResult } from "./job-result.ts";
import { killProcesses, listProcesses } from "./ps.ts";
import { takeScreenshot } from "./screenshot.ts";
import { collectInfo, type AgentInfoContext } from "./sysinfo.ts";

export interface JobManagerOptions {
  send: (msg: AgentMsg) => void;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  maxConcurrent?: number;
  /** Static metadata reported by the `info` job. */
  context?: () => AgentInfoContext;
}

const DEFAULT_MAX_CONCURRENT = 4;

/** Job types that are short and handled by a single async function. */
const SHORT_JOB_TYPES = new Set(["fs.list", "fs.read", "fs.write", "fs.hash", "info", "ps.list", "ps.kill", "screenshot"]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
    if (msg.jobType === "exec") {
      if (this.running.size >= this.maxConcurrent) {
        this.sendResult(msg.jobId, {
          ok: false,
          durationMs: 0,
          error: `agent is busy (${this.running.size} jobs running, max ${this.maxConcurrent})`,
        });
        return;
      }
      void this.handleExec(msg);
      return;
    }
    if (SHORT_JOB_TYPES.has(msg.jobType)) {
      this.handleShortJob(msg);
      return;
    }
    this.sendResult(msg.jobId, {
      ok: false,
      durationMs: 0,
      error: `unsupported job type '${msg.jobType}'`,
    });
  }

  handleCancel(msg: JobCancelMsg): void {
    const job = this.running.get(msg.jobId);
    if (!job) return; // already finished (fs jobs are short and not cancellable)
    this.opts.log("job cancel requested", { jobId: msg.jobId });
    job.cancel();
  }

  /** Kill every running job (connection lost / agent shutting down). */
  cancelAll(): void {
    for (const job of this.running.values()) job.cancel();
  }

  // -------------------------------------------------------------------------
  // exec
  // -------------------------------------------------------------------------

  private async handleExec(msg: JobRequestMsg): Promise<void> {
    const parsed = ExecParamsSchema.safeParse(msg.params);
    if (!parsed.success) {
      this.sendResult(msg.jobId, {
        ok: false,
        durationMs: 0,
        error: `invalid exec params: ${firstIssue(parsed.error)}`,
      });
      return;
    }

    this.opts.log("exec job started", { jobId: msg.jobId, shell: parsed.data.shell });
    const result = await runExec({ ...parsed.data, jobId: msg.jobId, timeoutMs: msg.timeoutMs }, {
      onOutput: (stream, seq, data) => {
        this.opts.send({ type: "job.output", jobId: msg.jobId, stream, seq, data, encoding: "utf8" });
      },
      onHandle: (handle) => {
        this.running.set(msg.jobId, handle);
      },
    });
    this.running.delete(msg.jobId);
    this.opts.log("exec job finished", { jobId: msg.jobId, ok: result.ok, exitCode: result.exitCode ?? null });
    this.sendResult(msg.jobId, result);
  }

  // -------------------------------------------------------------------------
  // Short jobs: fs.*, info, ps.*, screenshot
  // -------------------------------------------------------------------------

  private handleShortJob(msg: JobRequestMsg): void {
    const startedAt = Date.now();
    void this.runShortJob(msg)
      .then((result) => {
        let seq = 0;
        for (const output of result.outputs ?? []) {
          this.opts.send({
            type: "job.output",
            jobId: msg.jobId,
            stream: output.stream,
            seq: seq++,
            data: output.data,
            encoding: output.encoding,
          });
        }
        this.sendResult(msg.jobId, { ok: true, durationMs: Date.now() - startedAt }, result.meta);
      })
      .catch((err) => {
        this.sendResult(msg.jobId, { ok: false, durationMs: Date.now() - startedAt, error: errorMessage(err) });
      });
  }

  private async runShortJob(msg: JobRequestMsg): Promise<ShortJobResult> {
    switch (msg.jobType) {
      case "fs.list": {
        const parsed = FsListSchema.safeParse(msg.params);
        if (!parsed.success) throw new Error(`invalid fs.list params: ${firstIssue(parsed.error)}`);
        return fsList(parsed.data);
      }
      case "fs.read": {
        const parsed = FsReadSchema.safeParse(msg.params);
        if (!parsed.success) throw new Error(`invalid fs.read params: ${firstIssue(parsed.error)}`);
        return fsRead(parsed.data);
      }
      case "fs.write": {
        const parsed = FsWriteSchema.safeParse(msg.params);
        if (!parsed.success) throw new Error(`invalid fs.write params: ${firstIssue(parsed.error)}`);
        return fsWrite(parsed.data);
      }
      case "fs.hash": {
        const parsed = FsHashSchema.safeParse(msg.params);
        if (!parsed.success) throw new Error(`invalid fs.hash params: ${firstIssue(parsed.error)}`);
        return fsHash(parsed.data);
      }
      case "info": {
        const parsed = InfoSchema.safeParse(msg.params);
        if (!parsed.success) throw new Error(`invalid info params: ${firstIssue(parsed.error)}`);
        const context = this.opts.context?.();
        if (!context) throw new Error("agent context unavailable");
        return collectInfo(parsed.data, context);
      }
      case "ps.list": {
        const parsed = PsListSchema.safeParse(msg.params);
        if (!parsed.success) throw new Error(`invalid ps.list params: ${firstIssue(parsed.error)}`);
        return listProcesses(parsed.data);
      }
      case "ps.kill": {
        const parsed = PsKillSchema.safeParse(msg.params);
        if (!parsed.success) throw new Error(`invalid ps.kill params: ${firstIssue(parsed.error)}`);
        return killProcesses(parsed.data);
      }
      case "screenshot": {
        const parsed = ScreenshotSchema.safeParse(msg.params);
        if (!parsed.success) throw new Error(`invalid screenshot params: ${firstIssue(parsed.error)}`);
        return takeScreenshot(parsed.data);
      }
      default:
        throw new Error(`unsupported job type '${msg.jobType}'`);
    }
  }

  private sendResult(
    jobId: string,
    result: { ok: boolean; exitCode?: number; durationMs: number; error?: string },
    meta?: Record<string, unknown>,
  ): void {
    this.opts.send({
      type: "job.result",
      jobId,
      ok: result.ok,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
      ...(meta ? { meta } : {}),
    });
  }
}

function firstIssue(error: import("zod").ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "params"}: ${issue.message}` : "validation failed";
}
