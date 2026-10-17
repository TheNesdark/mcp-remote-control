/**
 * AgentConnection: keeps a websocket link to the central server alive.
 *
 * - Sends `hello` (token auth) and waits for `welcome`.
 * - Heartbeats on the interval the server dictates.
 * - Reconnects with exponential backoff + jitter (1s -> 60s cap).
 * - Fatal server rejects (auth, protocol, duplicate) stop the process and
 *   surface a clear error instead of retrying forever.
 */
import {
  encodeMsg,
  HEARTBEAT_INTERVAL_MS,
  normalizeAgentUrl,
  parseServerMsg,
  PROTOCOL_VERSION,
  type AgentMsg,
  type JobCancelMsg,
  type JobRequestMsg,
  type WelcomeMsg,
} from "@mrc/shared";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "paused";

export type AgentLogFn = (level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;

export interface AgentConnectionOptions {
  serverUrl: string;
  token: string;
  name: string;
  agentId?: string;
  host: string;
  os: string;
  version: string;
  tags: string[];
  caps: string[];
  paused?: boolean;
  onJobRequest: (msg: JobRequestMsg) => void;
  onJobCancel: (msg: JobCancelMsg) => void;
  onStateChange?: (state: ConnectionState) => void;
  /** Called for non-retryable rejects (bad token, protocol mismatch...). */
  onFatal?: (reason: string) => void;
  /** Called every time the server assigns/confirms our agent id. */
  onIdAssigned?: (agentId: string) => void;
  /** Called on every welcome, before anything else runs (auto-update hook). */
  onWelcome?: (msg: WelcomeMsg) => void;
  log?: AgentLogFn;
}

interface CloseInfo {
  code: number;
  reason: string;
  hadWelcome: boolean;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

export function backoffDelay(attempt: number): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

export class AgentConnection {
  private ws: WebSocket | null = null;
  private heartbeat: Timer | null = null;
  private connected = false;
  private stopped = false;
  private paused: boolean;
  private currentAgentId: string | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly opts: AgentConnectionOptions) {
    this.paused = opts.paused ?? false;
  }

  get agentId(): string | null {
    return this.currentAgentId;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    try {
      this.ws?.close(1000, "agent stopping");
    } catch {
      // already closed
    }
    this.ws = null;
  }

  /** Drop the current socket (if any) and skip the pending backoff sleep. */
  reconnectNow(): void {
    this.log("info", "reconnect requested");
    try {
      this.ws?.close(4000, "reconnect requested");
    } catch {
      // already closed
    }
    this.wake?.();
  }

  pause(): void {
    this.setPaused(true);
  }

  resume(): void {
    this.setPaused(false);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.send({ type: "presence", paused });
    if (this.connected) this.emit(paused ? "paused" : "connected");
    this.log("info", paused ? "agent paused locally" : "agent resumed locally");
  }

  /** Queue a protocol message (hello/heartbeat/presence/job.*). */
  send(msg: AgentMsg): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(encodeMsg(msg));
    } catch (err) {
      this.log("warn", "websocket send failed", { error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async loop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      this.emit("connecting");
      const close = await this.connectOnce();
      if (this.stopped) return;
      this.connected = false;
      this.emit("disconnected");

      if (close.hadWelcome) {
        this.log("warn", "connection lost", { code: close.code, reason: close.reason || null });
        // treat as a fresh failure: short first retry
        attempt = Math.min(attempt, 1);
      } else {
        this.log("warn", "connection failed", { code: close.code, reason: close.reason || null });
      }

      if (close.code === 4001) {
        this.opts.onFatal?.("authentication failed: check the token (auth_failed)");
        return;
      }
      if (close.code === 4003 && close.reason !== "heartbeat timeout") {
        this.opts.onFatal?.(`server rejected this agent: ${close.reason || "unknown reason"}`);
        return;
      }

      const delay = backoffDelay(attempt);
      attempt++;
      this.log("info", "reconnecting", { inMs: delay, attempt });
      await this.waitBackoff(delay);
    }
  }

  /** Sleep for `ms`, but return early when reconnectNow() asks for it. */
  private waitBackoff(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private connectOnce(): Promise<CloseInfo> {
    return new Promise((resolve) => {
      let hadWelcome = false;
      let settled = false;

      const ws = new WebSocket(normalizeAgentUrl(this.opts.serverUrl));
      this.ws = ws;

      const settle = (info: CloseInfo): void => {
        if (settled) return;
        settled = true;
        this.clearHeartbeat();
        this.ws = null;
        resolve(info);
      };

      ws.addEventListener("open", () => {
        const agentId = this.opts.agentId ?? this.currentAgentId;
        this.send({
          type: "hello",
          proto: PROTOCOL_VERSION,
          token: this.opts.token,
          ...(agentId ? { agentId } : {}),
          name: this.opts.name,
          host: this.opts.host,
          os: this.opts.os,
          version: this.opts.version,
          tags: this.opts.tags,
          caps: this.opts.caps,
          paused: this.paused,
        });
      });

      ws.addEventListener("message", (event) => {
        const parsed = parseServerMsg(String(event.data));
        if (!parsed.ok) {
          this.log("warn", "invalid server message", { error: parsed.error });
          return;
        }
        const msg = parsed.msg;
        switch (msg.type) {
          case "welcome":
            hadWelcome = true;
            this.currentAgentId = msg.agentId;
            this.connected = true;
            this.startHeartbeat(msg.heartbeatIntervalMs);
            this.opts.onWelcome?.(msg);
            this.emit(this.paused ? "paused" : "connected");
            this.opts.onIdAssigned?.(msg.agentId);
            this.log("info", "connected", { agentId: msg.agentId, server: this.opts.serverUrl });
            return;
          case "job.request":
            this.opts.onJobRequest(msg);
            return;
          case "job.cancel":
            this.opts.onJobCancel(msg);
            return;
          case "ping":
            this.send({ type: "heartbeat", ts: Date.now() });
            return;
          case "error":
            this.log("warn", `server error: ${msg.code}`, { message: msg.message });
            return;
        }
      });

      ws.addEventListener("close", (event) => {
        settle({ code: event.code, reason: event.reason, hadWelcome });
      });

      ws.addEventListener("error", () => {
        // the close event carries the useful details
      });
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    const every = intervalMs || HEARTBEAT_INTERVAL_MS;
    this.heartbeat = setInterval(() => this.send({ type: "heartbeat", ts: Date.now() }), every);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private emit(state: ConnectionState): void {
    this.opts.onStateChange?.(state);
  }

  private log(level: "debug" | "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>): void {
    this.opts.log?.(level, msg, fields);
  }
}
