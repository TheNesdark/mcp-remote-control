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
import { logger } from "./log.ts";

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
  ok: boolean;
  exitCode?: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: string;
}

interface OutputStream {
  chunks: string[];
  bytes: number;
}

interface PendingJob {
  agentId: string;
  timeoutMs: number;
  resolve: (outcome: JobOutcome) => void;
  timeoutTimer: Timer;
  graceTimer?: Timer;
  streams: { stdout: OutputStream; stderr: OutputStream };
  truncated: boolean;
  startedAt: number;
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
  token: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  defaultJobTimeoutMs: number;
  maxJobOutputBytes: number;
}

export class Hub {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly bySocket = new Map<AgentSocket, AgentRecord>();
  private readonly pending = new Map<string, PendingJob>();
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
      case "heartbeat":
        return; // lastSeen was already refreshed
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
      this.rejectHello(ws, "protocol_mismatch", `server speaks protocol v${PROTOCOL_VERSION}, agent speaks v${hello.proto}`);
      return;
    }
    if (hello.token !== this.opts.token) {
      logger.warn("rejected agent: invalid token", { name: hello.name, remote: ws.remoteAddress });
      this.rejectHello(ws, "auth_failed", "invalid token");
      return;
    }

    let record: AgentRecord | undefined;
    if (hello.agentId) {
      record = this.agents.get(hello.agentId);
      if (record?.online) {
        this.rejectHello(ws, "already_connected", `agent id '${hello.agentId}' is already connected`);
        return;
      }
    }
    if (!record) {
      const agentId = hello.agentId ?? `ag_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
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

  /**
   * Send a job to an agent and wait for its result.
   * Rejects with HubError for routing problems, or resolves with `ok:false`
   * for remote failures/timeouts (partial output included).
   */
  async request(agentIdOrName: string, jobType: JobType, params: unknown, timeoutMs?: number): Promise<JobOutcome> {
    const record = this.resolve(agentIdOrName);
    this.assertAgentReady(record);

    const effectiveTimeout = timeoutMs ?? this.opts.defaultJobTimeoutMs;
    const jobId = crypto.randomUUID();
    let resolveFn!: (outcome: JobOutcome) => void;
    const promise = new Promise<JobOutcome>((resolve) => {
      resolveFn = resolve;
    });

    const job: PendingJob = {
      agentId: record.agentId,
      timeoutMs: effectiveTimeout,
      resolve: resolveFn,
      timeoutTimer: setTimeout(() => this.onJobTimeout(jobId), effectiveTimeout),
      streams: { stdout: { chunks: [], bytes: 0 }, stderr: { chunks: [], bytes: 0 } },
      truncated: false,
      startedAt: Date.now(),
    };
    this.pending.set(jobId, job);

    this.send(record.ws!, { type: "job.request", jobId, jobType, params, timeoutMs: effectiveTimeout });
    logger.debug("job sent", { agentId: record.agentId, jobId, jobType, timeoutMs: effectiveTimeout });
    return promise;
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
    });
  }

  private finalizeJob(jobId: string, job: PendingJob, outcome: JobOutcome): void {
    if (!this.pending.delete(jobId)) return;
    clearTimeout(job.timeoutTimer);
    if (job.graceTimer) clearTimeout(job.graceTimer);
    job.resolve(outcome);
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
