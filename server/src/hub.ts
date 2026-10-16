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
import { AuditLog, pickResultBytes, sanitizeParams } from "./audit.ts";
import { logger } from "./log.ts";
import type { TokenRegistry } from "./registry.ts";

/** Grace period between `job.cancel` and giving up on a job. */
export const JOB_CANCEL_GRACE_MS = 2_000;

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

interface OutputStream {
  chunks: string[];
  bytes: number;
}

interface PendingJob {
  agentId: string;
  agentName: string;
  timeoutMs: number;
  resolve: (outcome: JobOutcome) => void;
  timeoutTimer: Timer;
  graceTimer?: Timer;
  streams: { stdout: OutputStream; stderr: OutputStream };
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

export class HubError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
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
}

export class Hub {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly bySocket = new Map<AgentSocket, AgentRecord>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly inflight = new Map<string, number>();
  private readonly jobStamps = new Map<string, number[]>();
  private sweeper: Timer | null = null;

  constructor(private readonly opts: HubOptions) {}

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
      this.rejectHello(ws, "already_connected", `agent id '${agentId}' is already connected`);
      return;
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
  ): Promise<JobOutcome> {
    const startedAt = Date.now();
    const auditFailure = (error: unknown): void => {
      if (!auditMeta || auditMeta.internal) return;
      this.opts.audit.append({
        actor: "tool",
        op: auditMeta.op,
        agent: agentIdOrName,
        params: sanitizeParams(auditMeta.params),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
    };

    let record: AgentRecord;
    try {
      record = this.resolve(agentIdOrName);
      this.assertAgentReady(record);
      this.checkLimits(record, auditMeta?.internal === true);
    } catch (err) {
      auditFailure(err);
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
      timeoutMs: effectiveTimeout,
      resolve: resolveFn,
      timeoutTimer: setTimeout(() => this.onJobTimeout(jobId), effectiveTimeout),
      streams: { stdout: { chunks: [], bytes: 0 }, stderr: { chunks: [], bytes: 0 } },
      truncated: false,
      startedAt,
      audit: auditMeta,
    };
    this.pending.set(jobId, job);
    this.inflight.set(record.agentId, (this.inflight.get(record.agentId) ?? 0) + 1);

    this.send(record.ws!, { type: "job.request", jobId, jobType, params, timeoutMs: effectiveTimeout });
    logger.debug("job sent", { agentId: record.agentId, jobId, jobType, timeoutMs: effectiveTimeout });
    return promise;
  }

  /** Reject when the agent is saturated (concurrency) or too chatty (rate). */
  private checkLimits(record: AgentRecord, internal: boolean): void {
    const running = this.inflight.get(record.agentId) ?? 0;
    if (running >= this.opts.maxJobsPerAgent) {
      throw new HubError(
        "agent_busy",
        `Agent '${record.name}' already runs ${running} jobs (max ${this.opts.maxJobsPerAgent}); try again later.`,
      );
    }
    if (internal) return;
    const now = Date.now();
    const stamps = (this.jobStamps.get(record.agentId) ?? []).filter((stamp) => now - stamp < 60_000);
    if (stamps.length >= this.opts.maxJobsPerMinute) {
      throw new HubError(
        "rate_limited",
        `Agent '${record.name}' exceeded ${this.opts.maxJobsPerMinute} jobs/min; slow down.`,
      );
    }
    stamps.push(now);
    this.jobStamps.set(record.agentId, stamps);
  }

  private onJobTimeout(jobId: string): void {
    const job = this.pending.get(jobId);
    if (!job) return;
    const record = this.agents.get(job.agentId);
    logger.warn("job timed out, sending cancel", { jobId, agentId: job.agentId, timeoutMs: job.timeoutMs });
    if (record?.ws) this.send(record.ws, { type: "job.cancel", jobId });
    job.graceTimer = setTimeout(() => {
      const still = this.pending.get(jobId);
      if (!still) return;
      this.finalizeJob(jobId, still, {
        ...this.collectOutput(still),
        ok: false,
        durationMs: Date.now() - still.startedAt,
        error: `job timed out after ${still.timeoutMs}ms (cancel sent, agent did not confirm)`,
      });
    }, JOB_CANCEL_GRACE_MS);
  }

  private handleJobOutput(msg: JobOutputMsg): void {
    const job = this.pending.get(msg.jobId);
    if (!job) return; // late output after result/timeout: drop
    const stream = job.streams[msg.stream];
    if (stream.bytes + msg.data.length > this.opts.maxJobOutputBytes) {
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
    this.inflight.set(job.agentId, Math.max(0, (this.inflight.get(job.agentId) ?? 1) - 1));
    if (job.audit && !job.audit.internal) {
      const entry: Parameters<AuditLog["append"]>[0] = {
        actor: "tool",
        op: job.audit.op,
        agent: job.agentName,
        params: sanitizeParams(job.audit.params),
        ok: outcome.ok,
        durationMs: outcome.durationMs,
      };
      if (outcome.error) entry.error = outcome.error;
      const bytes = pickResultBytes(outcome.meta);
      if (bytes !== undefined) entry.bytes = bytes;
      this.opts.audit.append(entry);
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
