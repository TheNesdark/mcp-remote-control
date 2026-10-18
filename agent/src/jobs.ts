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
  CuaParams,
  RestartParams as RestartSchema,
  ScreenshotParams as ScreenshotSchema,
  type AgentMsg,
  type JobCancelMsg,
  type JobRequestMsg,
} from "@mrc/shared";
import { runCuaJob, type CuaBridge } from "./cua-job.ts";
import { runExec, type RunningExec } from "./exec.ts";
import { fsHash, fsList, fsRead, fsWrite } from "./fs.ts";
import type { ShortJobResult } from "./job-result.ts";
import { killProcesses, listProcesses } from "./ps.ts";
import { restartAgent } from "./restart.ts";
import { takeScreenshot } from "./screenshot.ts";
import { collectInfo, type AgentInfoContext } from "./sysinfo.ts";

export interface JobManagerOptions {
  send: (msg: AgentMsg) => void;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  maxConcurrent?: number;
  /** Static metadata reported by the `info` job. */
  context?: () => AgentInfoContext;
  /** Cua Driver bridge for the `cua` job (agent index.ts). */
  cua?: CuaBridge;
}

const DEFAULT_MAX_CONCURRENT = 4;

interface ShortJobContext {
  agentInfo: () => AgentInfoContext | undefined;
  cua?: CuaBridge;
}

type ShortJobHandler = (params: unknown, ctx: ShortJobContext) => Promise<ShortJobResult>;

function parseOrThrow<T>(
  schema: {
    safeParse(params: unknown): { success: true; data: T } | { success: false; error: import("zod").ZodError };
  },
  jobType: string,
  params: unknown,
): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw new Error(`invalid ${jobType} params: ${firstIssue(parsed.error)}`);
  return parsed.data;
}

/** Short jobs: one chunk in, one result out (exec aside, everything the agent serves). */
const SHORT_JOBS: Record<string, ShortJobHandler> = {
  "fs.list": (params) => fsList(parseOrThrow(FsListSchema, "fs.list", params)),
  "fs.read": (params) => fsRead(parseOrThrow(FsReadSchema, "fs.read", params)),
  "fs.write": (params) => fsWrite(parseOrThrow(FsWriteSchema, "fs.write", params)),
  "fs.hash": (params) => fsHash(parseOrThrow(FsHashSchema, "fs.hash", params)),
  info: (params, ctx) => {
    const context = ctx.agentInfo();
    if (!context) throw new Error("agent context unavailable");
    return collectInfo(parseOrThrow(InfoSchema, "info", params), context);
  },
  "ps.list": (params) => listProcesses(parseOrThrow(PsListSchema, "ps.list", params)),
  "ps.kill": (params) => killProcesses(parseOrThrow(PsKillSchema, "ps.kill", params)),
  screenshot: (params) => takeScreenshot(parseOrThrow(ScreenshotSchema, "screenshot", params)),
  restart: (params) => restartAgent(parseOrThrow(RestartSchema, "restart", params)),
  cua: (params, ctx) => {
    if (!ctx.cua) throw new Error("cua bridge unavailable");
    return runCuaJob(parseOrThrow(CuaParams, "cua", params), ctx.cua);
  },
};

/** Job types handled by a single async function. */
const SHORT_JOB_TYPES = new Set(Object.keys(SHORT_JOBS));

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
    const handler = SHORT_JOBS[msg.jobType];
    if (!handler) throw new Error(`unsupported job type '${msg.jobType}'`);
    return handler(msg.params, { agentInfo: () => this.opts.context?.(), cua: this.opts.cua });
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
