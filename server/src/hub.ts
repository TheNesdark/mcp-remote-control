/**
 * Hub: keeps the registry of connected agents and routes jobs to them.
 *
 * - Agents register with a `hello` frame and get a stable `agentId`.
 * - Jobs are correlated by `jobId` (job.request / job.output* / job.result).
 * - Timeouts send `job.cancel`; a short grace period covers non-cooperative agents.
 * - A sweeper drops sockets that stop sending heartbeats.
 */
import type { ServerWebSocket } from "bun";
import {
  encodeMsg,
  PROTOCOL_VERSION,
  type HelloMsg,
  type JobOutputMsg,
  type JobResultMsg,
  type JobType,
  parseAgentMsg,
  type ServerMsg,
} from "@mrc/shared";
import { compareVersions } from "@mrc/shared/version";
import { appendJobOutcome, appendJobRejection, AuditLog } from "./audit.ts";
import { HubError } from "./hub-error.ts";
import { JobLimiter } from "./job-limits.ts";
import { logger } from "./log.ts";
import type { TokenRegistry } from "./registry.ts";

/** Grace period between `job.cancel` and giving up on a job. */
export const JOB_CANCEL_GRACE_MS = 2_000;
/** Finished async jobs kept in memory (agent_job_status/list) before eviction. */
export const DEFAULT_MAX_RETAINED_JOBS = 100;
/** How long a finished async job stays queryable. */
export const DEFAULT_RETAINED_JOB_TTL_MS = 30 * 60_000;
/** Output kept per stream for a finished async job, so retention stays bounded. */
const RETAINED_OUTPUT_MAX_BYTES = 256 * 1024;

export interface WsData {
  agentId: string | null;
}

export type AgentSocket = ServerWebSocket<WsData>;

export interface AgentRecord {
  agentId: string;
  name: string;
  host: string;
  os: string;
  version: string;
  tags: string[];
  caps: string[];
  paused: boolean;
  online: boolean;
  connectedAt: number | null;
  lastSeen: number | null;
  remoteAddr: string;
  ws: AgentSocket | null;
}

export interface AgentSummary {
  id: string;
  name: string;
  host: string;
  os: string;
  version: string;
  tags: string[];
  caps: string[];
  online: boolean;
  paused: boolean;
  connectedAt: string | null;
  lastSeen: string | null;
}

/** Fleet-wide counters for GET /health (cheap, no job involved). */
export interface HubStats {
  agents: { total: number; online: number; paused: number };
  jobs: { running: number; retained: number };
  /** Most recent heartbeat/connect/disconnect across the fleet, in ms. */
  lastAgentSeenAt: number | null;
}

export interface JobOutcome {
  jobId: string;
  ok: boolean;
  exitCode?: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

/** JobOutcome before the hub stamps it with the jobId. */
type OutcomeData = Omit<JobOutcome, "jobId">;

export type AsyncJobState = "running" | "ok" | "failed";

/** Snapshot of an async (or still running) job, as reported by jobStatus(). */
export interface JobStatusPayload {
  jobId: string;
  agentId: string;
  agentName: string;
  jobType: JobType;
  state: AsyncJobState;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

/** Result of requestAsync(): enough to poll the job later. */
export interface AsyncJobHandle {
  jobId: string;
  agentId: string;
  agentName: string;
  jobType: JobType;
  startedAt: string;
  /** Resolves when the job settles (used to chain follow-up work like downloads). */
  promise: Promise<JobOutcome>;
}

/** A finished (or in-flight) async job kept for agent_jobs status/list. */
interface RetainedJob {
  jobId: string;
  agentId: string;
  agentName: string;
  jobType: JobType;
  startedAt: number;
  finishedAt: number | null;
  outcome: JobOutcome | null;
}

interface OutputStream {
  chunks: string[];
  bytes: number;
}

interface PendingJob {
  agentId: string;
  agentName: string;
  jobType: JobType;
  timeoutMs: number;
  resolve: (outcome: JobOutcome) => void;
  timeoutTimer: Timer;
  graceTimer?: Timer;
  streams: { stdout: OutputStream; stderr: OutputStream };
  /** Per-job output cap (screenshots need more than the text-oriented default). */
  maxOutputBytes: number;
  truncated: boolean;
  startedAt: number;
  audit?: ToolAuditMeta;
}

/** Tool-level context for the audit trail (who ordered what, with which params). */
export interface ToolAuditMeta {
  op: string;
  params?: unknown;
  /**
   * Internal plumbing (transfer chunks): skips rate-limit counting and audit
   * entries. The enclosing tool call is what gets counted and audited.
   */
  internal?: boolean;
}

export interface HubOptions {
  registry: TokenRegistry;
  audit: AuditLog;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  defaultJobTimeoutMs: number;
  maxJobOutputBytes: number;
  /** Max in-flight jobs per agent before new ones are rejected with agent_busy. */
  maxJobsPerAgent: number;
  /** Max accepted jobs per agent in a rolling 60s window (rate_limited above). */
  maxJobsPerMinute: number;
  /** Auto-update: newest published agent build (announced in `welcome`). */
  update?: { latestVersion?: string; binaryUrl?: string; binarySha256?: string };
  /** Finished async jobs kept for agent_jobs status/list (default 100). */
  maxRetainedJobs?: number;
  /** How long a finished async job stays queryable (default 30 min). */
  retainedJobTtlMs?: number;
}

export class Hub {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly bySocket = new Map<AgentSocket, AgentRecord>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly retained = new Map<string, RetainedJob>();
  private readonly limiter: JobLimiter;
  private sweeper: Timer | null = null;

  constructor(private readonly opts: HubOptions) {
    this.limiter = new JobLimiter({
      maxJobsPerAgent: opts.maxJobsPerAgent,
      maxJobsPerMinute: opts.maxJobsPerMinute,
    });
  }

  start(): void {
    this.sweeper = setInterval(() => this.sweep(), Math.min(5_000, this.opts.heartbeatIntervalMs));
  }

  shutdown(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const record of this.agents.values()) {
      try {
        record.ws?.close(1001, "server shutting down");
      } catch {
        // socket already gone
      }
      record.online = false;
      record.ws = null;
    }
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  handleMessage(ws: AgentSocket, raw: string): void {
    const parsed = parseAgentMsg(raw);
    if (!parsed.ok) {
      logger.warn("invalid frame from agent", {
        error: parsed.error,
        agentId: ws.data.agentId ?? null,
      });
      if (!ws.data.agentId) ws.close(4002, "invalid frame");
      return;
    }
    const msg = parsed.msg;

    if (msg.type === "hello") {
      this.handleHello(ws, msg);
      return;
    }

    const record = this.bySocket.get(ws);
    if (!record) {
      logger.warn("message before hello", { type: msg.type });
      ws.close(4002, "hello required first");
      return;
    }
    record.lastSeen = Date.now();

    switch (msg.type) {
      case "heartbeat": {
        this.opts.registry.touch(record.agentId);
        if (this.opts.registry.isRevoked(record.agentId)) {
          logger.warn("agent token was revoked, dropping connection", {
            agentId: record.agentId,
            name: record.name,
          });
          this.opts.audit.append({ actor: "hub", op: "agent:revoked", agent: record.name, ok: false, error: "token revoked" });
          try {
            ws.close(4001, "token revoked");
          } catch {
            // socket already gone
          }
        }
        return;
      }
      case "presence": {
        if (record.paused !== msg.paused) {
          record.paused = msg.paused;
          logger.info(msg.paused ? "agent paused locally" : "agent resumed locally", {
            agentId: record.agentId,
            name: record.name,
          });
        }
        return;
      }
      case "job.output":
        this.handleJobOutput(msg);
        return;
      case "job.result":
        this.handleJobResult(msg);
        return;
    }
  }

  handleClose(ws: AgentSocket): void {
    const record = this.bySocket.get(ws);
    if (!record) return;
    this.bySocket.delete(ws);
    record.online = false;
    record.ws = null;
    record.lastSeen = Date.now();
    logger.info("agent disconnected", { agentId: record.agentId, name: record.name });
    this.opts.registry.touch(record.agentId);
    this.opts.audit.append({ actor: "hub", op: "agent:disconnect", agent: record.name, ok: true });

    for (const [jobId, job] of this.pending) {
      if (job.agentId !== record.agentId) continue;
      this.finalizeJob(jobId, job, {
        ...this.collectOutput(job),
        ok: false,
        durationMs: Date.now() - job.startedAt,
        error: `agent '${record.name}' disconnected during the job`,
      });
    }
  }

  private handleHello(ws: AgentSocket, hello: HelloMsg): void {
    if (ws.data.agentId) {
      ws.close(4003, "duplicate hello");
      return;
    }
    if (hello.proto !== PROTOCOL_VERSION) {
      this.opts.audit.append({
        actor: "hub",
        op: "agent:auth_failed",
        agent: hello.name,
        ok: false,
        error: `protocol mismatch (server v${PROTOCOL_VERSION}, agent v${hello.proto})`,
      });
      this.rejectHello(ws, "protocol_mismatch", `server speaks protocol v${PROTOCOL_VERSION}, agent speaks v${hello.proto}`);
      return;
    }

    const verdict = this.opts.registry.verify(hello.token, hello.agentId ?? null, {
      name: hello.name,
      host: hello.host,
      os: hello.os,
      version: hello.version,
      tags: hello.tags,
    });
    if (verdict.status !== "ok") {
      const message =
        verdict.status === "revoked"
          ? `token revoked for agent '${verdict.agentId}'`
          : verdict.status === "bound-elsewhere"
            ? `token is already bound to agent '${verdict.agentId}'`
            : "invalid token";
      logger.warn("rejected agent", { name: hello.name, remote: ws.remoteAddress, reason: verdict.status });
      this.opts.audit.append({ actor: "hub", op: "agent:auth_failed", agent: hello.name, ok: false, error: message });
      this.rejectHello(ws, "auth_failed", message);
      return;
    }

    const agentId = hello.agentId ?? verdict.agentId ?? `ag_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
    let record: AgentRecord | undefined = this.agents.get(agentId);
    if (record?.online) {
      // A second process claims this agent id (restart race, half-open old
      // socket, or a leftover instance that did not exit). Prefer the newer
      // agent version so an OTA cannot be held hostage by the old process,
      // otherwise last hello wins: adopt the newcomer and kick the previous
      // socket with a terminal code the agent treats as fatal, so the loser
      // exits instead of reconnecting in a loop.
      if (compareVersions(hello.version, record.version) < 0) {
        this.rejectHello(
          ws,
          "superseded",
          `agent '${record.name}' already runs version ${record.version}; this ${hello.version} build was replaced`,
        );
        return;
      }
      const previous = record.ws;
      logger.warn("agent reconnected, taking over the previous connection", {
        agentId,
        name: hello.name,
        from: record.version,
        to: hello.version,
        remote: ws.remoteAddress,
      });
      this.opts.audit.append({
        actor: "hub",
        op: "agent:taken_over",
        agent: record.name,
        params: { agentId, by: ws.remoteAddress },
        ok: true,
      });
      if (previous) {
        this.bySocket.delete(previous);
        try {
          // 4003: agents treat it as fatal (auth-style rejection), which is
          // exactly what a replaced instance should do — old agents from
          // before the takeover code need this too.
          previous.close(4003, "taken_over");
        } catch {
          // socket already gone
        }
        // The old process is gone with it: fail its in-flight jobs now instead
        // of waiting for the timeout (handleClose would, but this socket is no
        // longer mapped by the time its close event fires).
        for (const [jobId, job] of this.pending) {
          if (job.agentId !== record.agentId) continue;
          this.finalizeJob(jobId, job, {
            ...this.collectOutput(job),
            ok: false,
            durationMs: Date.now() - job.startedAt,
            error: `agent '${record.name}' was replaced by a newer connection during the job`,
          });
        }
      }
      record.online = false;
      record.ws = null;
    }
    if (!record) {
      record = {
        agentId,
        name: hello.name,
        host: hello.host,
        os: hello.os,
        version: hello.version,
        tags: hello.tags,
        caps: hello.caps,
        paused: hello.paused,
        online: false,
        connectedAt: null,
        lastSeen: null,
        remoteAddr: ws.remoteAddress,
        ws: null,
      };
      this.agents.set(agentId, record);
    }

    Object.assign(record, {
      name: hello.name,
      host: hello.host,
      os: hello.os,
      version: hello.version,
      tags: hello.tags,
      caps: hello.caps,
      paused: hello.paused,
      online: true,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      remoteAddr: ws.remoteAddress,
      ws,
    });
    ws.data.agentId = record.agentId;
    this.bySocket.set(ws, record);

    this.send(ws, {
      type: "welcome",
      agentId: record.agentId,
      serverTime: Date.now(),
      heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
      ...(this.opts.update?.latestVersion ? { latestAgentVersion: this.opts.update.latestVersion } : {}),
      ...(this.opts.update?.binaryUrl ? { agentBinaryUrl: this.opts.update.binaryUrl } : {}),
      ...(this.opts.update?.binarySha256 ? { agentBinarySha256: this.opts.update.binarySha256 } : {}),
    });
    this.opts.registry.touch(record.agentId, {
      name: hello.name,
      host: hello.host,
      os: hello.os,
      version: hello.version,
      tags: hello.tags,
    });
    this.opts.audit.append({ actor: "hub", op: "agent:connect", agent: record.name, ok: true });
    logger.info("agent connected", {
      agentId: record.agentId,
      name: record.name,
      host: record.host,
      os: record.os,
      paused: record.paused,
      remote: ws.remoteAddress,
    });
  }

  private rejectHello(ws: AgentSocket, code: string, message: string): void {
    try {
      ws.send(encodeMsg({ type: "error", code, message }));
    } catch {
      // socket already closed
    }
    ws.close(code === "auth_failed" ? 4001 : 4003, code);
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  /** Resolve an agent by exact id or case-insensitive name. Throws HubError. */
  resolve(ref: string): AgentRecord {
    const byId = this.agents.get(ref);
    if (byId) return byId;
    const byName = [...this.agents.values()].filter((a) => a.name.toLowerCase() === ref.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new HubError("ambiguous_agent", `Multiple agents are named '${ref}'; use the agent id instead.`);
    }
    throw new HubError("unknown_agent", `Unknown agent '${ref}'. Use agents_list to see the available agents.`);
  }

  private assertAgentReady(record: AgentRecord): void {
    if (!record.online || !record.ws) {
      throw new HubError("agent_offline", `Agent '${record.name}' (${record.agentId}) is offline.`);
    }
    if (record.paused) {
      throw new HubError("agent_paused", `Agent '${record.name}' (${record.agentId}) is paused locally (disabled from the tray).`);
    }
  }

  /** Force-close an agent connection (admin use; the agent may reconnect). */
  disconnect(ref: string): boolean {
    const record = this.resolve(ref);
    if (!record.ws) return false;
    try {
      record.ws.close(4000, "disconnected by server");
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Send a job to an agent and wait for its result.
   * Rejects with HubError for routing problems, or resolves with `ok:false`
   * for remote failures/timeouts (partial output included).
   */
  async request(
    agentIdOrName: string,
    jobType: JobType,
    params: unknown,
    timeoutMs?: number,
    auditMeta?: ToolAuditMeta,
    overrides?: { maxOutputBytes?: number },
  ): Promise<JobOutcome> {
    return this.enqueue(agentIdOrName, jobType, params, timeoutMs, auditMeta, overrides).promise;
  }

  /**
   * Send a job and return as soon as it is dispatched: the "start a long task
   * and poll it" flow behind agent_exec async / agent_jobs. The outcome of an
   * async job stays queryable for `maxRetainedJobs`/`retainedJobTtlMs` through
   * jobStatus() and jobList(), and jobCancel() stops it early.
   */
  requestAsync(
    agentIdOrName: string,
    jobType: JobType,
    params: unknown,
    timeoutMs?: number,
    auditMeta?: ToolAuditMeta,
    overrides?: { maxOutputBytes?: number },
  ): AsyncJobHandle {
    const handle = this.enqueue(agentIdOrName, jobType, params, timeoutMs, auditMeta, overrides);
    this.retained.set(handle.jobId, {
      jobId: handle.jobId,
      agentId: handle.agentId,
      agentName: handle.agentName,
      jobType,
      startedAt: handle.startedAt,
      finishedAt: null,
      outcome: null,
    });
    this.trimRetained();
    void handle.promise.then((outcome) => {
      const current = this.retained.get(handle.jobId);
      if (!current) return;
      current.outcome = clampOutcome(outcome);
      current.finishedAt = Date.now();
      this.trimRetained();
    });
    return {
      jobId: handle.jobId,
      agentId: handle.agentId,
      agentName: handle.agentName,
      jobType,
      startedAt: new Date(handle.startedAt).toISOString(),
      promise: handle.promise,
    };
  }

  /**
   * Shared admission + dispatch for request()/requestAsync(). Routing and limit
   * problems throw HubError (audited as a rejection); remote failures settle the
   * promise with `ok:false`.
   */
  private enqueue(
    agentIdOrName: string,
    jobType: JobType,
    params: unknown,
    timeoutMs?: number,
    auditMeta?: ToolAuditMeta,
    overrides?: { maxOutputBytes?: number },
  ): { jobId: string; agentId: string; agentName: string; startedAt: number; promise: Promise<JobOutcome> } {
    const startedAt = Date.now();
    const internal = auditMeta?.internal === true;

    let record: AgentRecord;
    try {
      record = this.resolve(agentIdOrName);
      this.assertAgentReady(record);
      this.limiter.acquire(record.agentId, record.name, internal);
    } catch (err) {
      if (auditMeta && !internal) {
        appendJobRejection(this.opts.audit, {
          op: auditMeta.op,
          agent: agentIdOrName,
          params: auditMeta.params,
          error: err,
          durationMs: Date.now() - startedAt,
        });
      }
      throw err;
    }

    const effectiveTimeout = timeoutMs ?? this.opts.defaultJobTimeoutMs;
    const jobId = crypto.randomUUID();
    let resolveFn!: (outcome: JobOutcome) => void;
    const promise = new Promise<JobOutcome>((resolve) => {
      resolveFn = resolve;
    });

    const job: PendingJob = {
      agentId: record.agentId,
      agentName: record.name,
      jobType,
      timeoutMs: effectiveTimeout,
      resolve: resolveFn,
      timeoutTimer: setTimeout(() => this.onJobTimeout(jobId), effectiveTimeout),
      streams: { stdout: { chunks: [], bytes: 0 }, stderr: { chunks: [], bytes: 0 } },
      maxOutputBytes: overrides?.maxOutputBytes ?? this.opts.maxJobOutputBytes,
      truncated: false,
      startedAt,
      audit: auditMeta,
    };
    this.pending.set(jobId, job);

    this.send(record.ws!, { type: "job.request", jobId, jobType, params, timeoutMs: effectiveTimeout });
    logger.debug("job sent", { agentId: record.agentId, jobId, jobType, timeoutMs: effectiveTimeout });
    return { jobId, agentId: record.agentId, agentName: record.name, startedAt, promise };
  }

  private onJobTimeout(jobId: string): void {
    const job = this.pending.get(jobId);
    if (!job) return;
    logger.warn("job timed out, sending cancel", { jobId, agentId: job.agentId, timeoutMs: job.timeoutMs });
    this.cancelPending(jobId, `job timed out after ${job.timeoutMs}ms (cancel sent, agent did not confirm)`);
  }

  /**
   * Ask the agent to stop a running job, then give it a grace period before
   * settling the job as failed. Returns false when the job already finished.
   */
  private cancelPending(jobId: string, finalError: string): boolean {
    const job = this.pending.get(jobId);
    if (!job) return false;
    const record = this.agents.get(job.agentId);
    if (record?.ws) this.send(record.ws, { type: "job.cancel", jobId });
    if (job.graceTimer) clearTimeout(job.graceTimer);
    job.graceTimer = setTimeout(() => {
      const still = this.pending.get(jobId);
      if (!still) return;
      this.finalizeJob(jobId, still, {
        ...this.collectOutput(still),
        ok: false,
        durationMs: Date.now() - still.startedAt,
        error: finalError,
      });
    }, JOB_CANCEL_GRACE_MS);
    return true;
  }

  private handleJobOutput(msg: JobOutputMsg): void {
    const job = this.pending.get(msg.jobId);
    if (!job) return; // late output after result/timeout: drop
    const stream = job.streams[msg.stream];
    if (stream.bytes + msg.data.length > job.maxOutputBytes) {
      job.truncated = true;
      return;
    }
    stream.chunks.push(msg.data);
    stream.bytes += msg.data.length;
  }

  private handleJobResult(msg: JobResultMsg): void {
    const job = this.pending.get(msg.jobId);
    if (!job) return;
    this.finalizeJob(msg.jobId, job, {
      ...this.collectOutput(job),
      ok: msg.ok,
      exitCode: msg.exitCode,
      durationMs: msg.durationMs,
      error: msg.error,
      meta: msg.meta,
    });
  }

  private finalizeJob(jobId: string, job: PendingJob, outcome: OutcomeData): void {
    if (!this.pending.delete(jobId)) return;
    clearTimeout(job.timeoutTimer);
    if (job.graceTimer) clearTimeout(job.graceTimer);
    this.limiter.release(job.agentId);
    if (job.audit && !job.audit.internal) {
      appendJobOutcome(this.opts.audit, {
        op: job.audit.op,
        agent: job.agentName,
        params: job.audit.params,
        ok: outcome.ok,
        error: outcome.error,
        durationMs: outcome.durationMs,
        meta: outcome.meta,
      });
    }
    job.resolve({ jobId, ...outcome });
  }

  private collectOutput(job: PendingJob): { stdout: string; stderr: string; truncated: boolean } {
    return {
      stdout: job.streams.stdout.chunks.join(""),
      stderr: job.streams.stderr.chunks.join(""),
      truncated: job.truncated,
    };
  }

  // -------------------------------------------------------------------------
  // Async job inspection (agent_jobs status / list / cancel)
  // -------------------------------------------------------------------------

  /** Snapshot of one job, or null when the id is unknown (never queued or evicted). */
  jobStatus(jobId: string): JobStatusPayload | null {
    const retained = this.retained.get(jobId);
    const live = this.pending.get(jobId);
    if (!retained && !live) return null;
    return this.buildStatus(jobId, retained, live);
  }

  /**
   * Update the retained outcome of a finished async job (e.g. to attach a
   * download path computed after the job itself completed). No-op when the
   * job is unknown or still running.
   */
  updateRetainedOutcome(jobId: string, outcome: JobOutcome): void {
    const retained = this.retained.get(jobId);
    if (!retained || retained.finishedAt === null) return;
    retained.outcome = clampOutcome(outcome);
  }

  /**
   * Jobs, newest first. Running jobs of any kind are included (a synchronous
   * agent_exec shows up while it runs); finished jobs are the retained async ones.
   */
  jobList(filter: { agent?: string; state?: AsyncJobState; limit?: number } = {}): JobStatusPayload[] {
    const limit = Math.min(filter.limit ?? 50, 500);
    const wanted = filter.agent?.toLowerCase();
    const statuses: JobStatusPayload[] = [];
    const seen = new Set<string>();
    for (const [jobId, retained] of this.retained) {
      statuses.push(this.buildStatus(jobId, retained, this.pending.get(jobId)));
      seen.add(jobId);
    }
    for (const [jobId, live] of this.pending) {
      if (seen.has(jobId)) continue;
      statuses.push(this.buildStatus(jobId, undefined, live));
    }
    return statuses
      .filter(
        (status) => !wanted || status.agentId.toLowerCase() === wanted || status.agentName.toLowerCase() === wanted,
      )
      .filter((status) => !filter.state || status.state === filter.state)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit);
  }

  /** Ask the agent to stop a job; `cancelRequested` is false when it already finished. */
  jobCancel(jobId: string): { ok: boolean; jobId: string; cancelRequested: boolean; status: JobStatusPayload | null } {
    if (!this.retained.has(jobId) && !this.pending.has(jobId)) {
      throw new HubError("unknown_job", `Unknown job '${jobId}'.`);
    }
    const cancelRequested = this.cancelPending(
      jobId,
      `job cancelled by request (agent did not confirm within ${JOB_CANCEL_GRACE_MS}ms)`,
    );
    return { ok: true, jobId, cancelRequested, status: this.jobStatus(jobId) };
  }

  private buildStatus(jobId: string, retained: RetainedJob | undefined, live: PendingJob | undefined): JobStatusPayload {
    const outcome = retained?.outcome ?? null;
    const base: Pick<JobStatusPayload, "jobId" | "agentId" | "agentName" | "jobType" | "startedAt"> = retained
      ? {
          jobId,
          agentId: retained.agentId,
          agentName: retained.agentName,
          jobType: retained.jobType,
          startedAt: new Date(retained.startedAt).toISOString(),
        }
      : {
          jobId,
          agentId: live!.agentId,
          agentName: live!.agentName,
          jobType: live!.jobType,
          startedAt: new Date(live!.startedAt).toISOString(),
        };

    if (retained && outcome) {
      return {
        ...base,
        state: outcome.ok ? "ok" : "failed",
        finishedAt: retained.finishedAt ? new Date(retained.finishedAt).toISOString() : null,
        durationMs: outcome.durationMs,
        exitCode: outcome.exitCode ?? null,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        truncated: outcome.truncated,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.meta ? { meta: outcome.meta } : {}),
      };
    }

    const output = live ? this.collectOutput(live) : { stdout: "", stderr: "", truncated: false };
    return {
      ...base,
      state: "running",
      finishedAt: null,
      durationMs: Date.now() - (retained?.startedAt ?? live!.startedAt),
      exitCode: null,
      ...output,
    };
  }

  /** Drop expired/oldest retained jobs; running ones are only dropped as a last resort. */
  private trimRetained(): void {
    const max = this.opts.maxRetainedJobs ?? DEFAULT_MAX_RETAINED_JOBS;
    const cutoff = Date.now() - (this.opts.retainedJobTtlMs ?? DEFAULT_RETAINED_JOB_TTL_MS);
    for (const [jobId, record] of this.retained) {
      if (record.finishedAt !== null && record.finishedAt < cutoff) this.retained.delete(jobId);
    }
    while (this.retained.size > max) {
      let victim: string | null = null;
      for (const [jobId, record] of this.retained) {
        if (record.finishedAt !== null) {
          victim = jobId;
          break;
        }
      }
      if (victim === null) {
        const oldest = this.retained.keys().next();
        if (oldest.done) break;
        victim = oldest.value;
      }
      this.retained.delete(victim);
    }
  }

  // -------------------------------------------------------------------------
  // Listing / liveness
  // -------------------------------------------------------------------------

  list(): AgentSummary[] {
    return [...this.agents.values()]
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name))
      .map((a) => ({
        id: a.agentId,
        name: a.name,
        host: a.host,
        os: a.os,
        version: a.version,
        tags: a.tags,
        caps: a.caps,
        online: a.online,
        paused: a.paused,
        connectedAt: a.connectedAt ? new Date(a.connectedAt).toISOString() : null,
        lastSeen: a.lastSeen ? new Date(a.lastSeen).toISOString() : null,
      }));
  }

  /** Counters for GET /health: fleet size, jobs in flight, last agent activity. */
  stats(): HubStats {
    let online = 0;
    let paused = 0;
    let lastAgentSeenAt: number | null = null;
    for (const record of this.agents.values()) {
      if (record.online) online += 1;
      if (record.paused) paused += 1;
      const seen = record.lastSeen ?? record.connectedAt;
      if (seen !== null && (lastAgentSeenAt === null || seen > lastAgentSeenAt)) lastAgentSeenAt = seen;
    }
    return {
      agents: { total: this.agents.size, online, paused },
      jobs: { running: this.pending.size, retained: this.retained.size },
      lastAgentSeenAt,
    };
  }

  private sweep(): void {
    const now = Date.now();
    for (const record of this.agents.values()) {
      if (!record.online || !record.ws) continue;
      const last = record.lastSeen ?? record.connectedAt ?? now;
      if (now - last > this.opts.heartbeatTimeoutMs) {
        logger.warn("agent heartbeat timeout", {
          agentId: record.agentId,
          name: record.name,
          silentMs: now - last,
        });
        this.opts.audit.append({
          actor: "hub",
          op: "agent:heartbeat_timeout",
          agent: record.name,
          ok: false,
          error: `no heartbeat for ${now - last}ms`,
        });
        try {
          record.ws.close(4000, "heartbeat timeout");
        } catch {
          // socket already gone
        }
      }
    }
  }

  private send(ws: AgentSocket, msg: ServerMsg): void {
    try {
      ws.send(encodeMsg(msg));
    } catch (err) {
      logger.error("websocket send failed", { error: String(err) });
    }
  }
}

/** Bound the output kept for a finished async job (the live buffer is already capped). */
function clampOutcome(outcome: JobOutcome): JobOutcome {
  const stdout = clampText(outcome.stdout);
  const stderr = clampText(outcome.stderr);
  if (stdout === outcome.stdout && stderr === outcome.stderr) return outcome;
  return { ...outcome, stdout, stderr, truncated: true };
}

function clampText(text: string): string {
  if (text.length <= RETAINED_OUTPUT_MAX_BYTES) return text;
  return `${text.slice(0, RETAINED_OUTPUT_MAX_BYTES)}\n...(output truncated by the job history)`;
}
