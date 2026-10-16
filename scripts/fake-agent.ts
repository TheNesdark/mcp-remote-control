#!/usr/bin/env bun
/**
 * Fake agent: a minimal websocket client that behaves like rc-agent.exe
 * (hello / heartbeat / presence / job echo) but runs anywhere.
 *
 * Used by the test suite and for local development without Windows.
 *
 * CLI:
 *   bun run agent:fake -- --server ws://127.0.0.1:8787 --token dev-token --name FAKE-01 [--paused] [--tags a,b]
 *   stdin commands: pause | resume | quit
 */
import {
  encodeMsg,
  HEARTBEAT_INTERVAL_MS,
  normalizeAgentUrl,
  parseServerMsg,
  PROTOCOL_VERSION,
  type JobCancelMsg,
  type JobRequestMsg,
  type ServerErrorMsg,
  type WelcomeMsg,
} from "@mrc/shared";
import { argFlag, argString, parseArgv } from "@mrc/shared/args";

export interface FakeAgentOptions {
  url: string;
  token: string;
  name?: string;
  host?: string;
  os?: string;
  version?: string;
  tags?: string[];
  caps?: string[];
  paused?: boolean;
  agentId?: string;
  /** Do not send heartbeats (used to test the server-side liveness sweeper). */
  silent?: boolean;
  onLog?: (line: string) => void;
}

export interface FakeJobParams {
  echo?: string;
  sleepMs?: number;
  fail?: boolean;
}

export class FakeAgent {
  agentId: string | null = null;
  welcome: WelcomeMsg | null = null;
  connected = false;
  lastError: ServerErrorMsg | null = null;
  jobsSeen: string[] = [];
  cancelledJobs: string[] = [];

  private ws: WebSocket | null = null;
  private heartbeat: Timer | null = null;
  private jobTimers = new Map<string, Timer>();

  constructor(readonly opts: FakeAgentOptions) {}

  get name(): string {
    return this.opts.name ?? "FAKE-01";
  }

  async start(timeoutMs = 5_000): Promise<WelcomeMsg> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(normalizeAgentUrl(this.opts.url));
      this.ws = ws;

      const timer = setTimeout(() => reject(new Error("timed out waiting for welcome")), timeoutMs);

      ws.addEventListener("open", () => {
        this.send({
          type: "hello",
          proto: PROTOCOL_VERSION,
          token: this.opts.token,
          ...(this.opts.agentId ? { agentId: this.opts.agentId } : {}),
          name: this.name,
          host: this.opts.host ?? "fake-host",
          os: this.opts.os ?? "Linux (fake agent)",
          version: this.opts.version ?? "0.0.0",
          tags: this.opts.tags ?? [],
          caps: this.opts.caps ?? ["exec", "fs", "ps", "screenshot", "info"],
          paused: this.opts.paused ?? false,
        });
      });

      ws.addEventListener("message", (event) => {
        const parsed = parseServerMsg(String(event.data));
        if (!parsed.ok) {
          this.log(`invalid server message: ${parsed.error}`);
          return;
        }
        const msg = parsed.msg;
        switch (msg.type) {
          case "welcome": {
            clearTimeout(timer);
            this.agentId = msg.agentId;
            this.welcome = msg;
            this.connected = true;
            if (!this.opts.silent) this.startHeartbeat(msg.heartbeatIntervalMs);
            this.log(`connected as ${msg.agentId}`);
            resolve(msg);
            return;
          }
          case "job.request":
            this.handleJob(msg);
            return;
          case "job.cancel":
            this.handleCancel(msg);
            return;
          case "ping":
            return;
          case "error":
            this.lastError = msg;
            this.log(`server error: ${msg.code} (${msg.message})`);
            return;
        }
      });

      ws.addEventListener("close", (event) => {
        clearTimeout(timer);
        this.connected = false;
        this.clearHeartbeat();
        for (const t of this.jobTimers.values()) clearTimeout(t);
        this.jobTimers.clear();
        if (!this.welcome) {
          reject(new Error(`connection closed before welcome: ${event.code} ${event.reason}`));
        }
        this.log(`disconnected (code ${event.code}${event.reason ? `, ${event.reason}` : ""})`);
      });

      ws.addEventListener("error", () => {
        // the close event carries the useful details
      });
    });
  }

  pause(): void {
    this.setPaused(true);
  }

  resume(): void {
    this.setPaused(false);
  }

  setPaused(paused: boolean): void {
    this.send({ type: "presence", paused });
    this.log(paused ? "presence: paused" : "presence: resumed");
  }

  stop(): void {
    this.clearHeartbeat();
    this.ws?.close(1000, "client stop");
    this.ws = null;
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

  private send(msg: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeMsg(msg as never));
  }

  private handleJob(msg: JobRequestMsg): void {
    this.jobsSeen.push(msg.jobId);
    const params = (msg.params ?? {}) as FakeJobParams;
    const startedAt = Date.now();
    this.log(`job ${msg.jobId} (${msg.jobType}) received`);

    this.send({ type: "job.output", jobId: msg.jobId, stream: "stdout", seq: 1, data: `${params.echo ?? ""}\n` });

    const finish = (): void => {
      this.jobTimers.delete(msg.jobId);
      this.send({
        type: "job.result",
        jobId: msg.jobId,
        ok: !params.fail,
        exitCode: params.fail ? 1 : 0,
        durationMs: Date.now() - startedAt,
        ...(params.fail ? { error: "requested failure" } : {}),
      });
    };

    if (params.sleepMs && params.sleepMs > 0) {
      this.jobTimers.set(msg.jobId, setTimeout(finish, params.sleepMs));
    } else {
      finish();
    }
  }

  private handleCancel(msg: JobCancelMsg): void {
    this.cancelledJobs.push(msg.jobId);
    const timer = this.jobTimers.get(msg.jobId);
    if (timer) {
      clearTimeout(timer);
      this.jobTimers.delete(msg.jobId);
    }
    this.send({ type: "job.result", jobId: msg.jobId, ok: false, durationMs: 0, error: "cancelled" });
    this.log(`job ${msg.jobId} cancelled`);
  }

  log(line: string): void {
    this.opts.onLog?.(line);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = parseArgv(process.argv.slice(2));
  const name = argString(args, "name") ?? "FAKE-01";
  const agent = new FakeAgent({
    url: argString(args, "server") ?? process.env.MRC_SERVER ?? "ws://127.0.0.1:8787",
    token: argString(args, "token") ?? process.env.MRC_TOKEN ?? "dev-token",
    name,
    agentId: argString(args, "id"),
    tags: (argString(args, "tags") ?? "").split(",").filter(Boolean),
    paused: argFlag(args, "paused"),
    onLog: (line) => console.log(`${new Date().toISOString()} [fake-agent] ${line}`),
  });

  const welcome = await agent.start();
  console.log(`${new Date().toISOString()} [fake-agent] ${name} ready (id=${welcome.agentId})`);
  console.log("[fake-agent] stdin commands: pause | resume | quit");

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    for (const raw of String(chunk).split("\n")) {
      const cmd = raw.trim().toLowerCase();
      if (cmd === "pause") agent.pause();
      else if (cmd === "resume") agent.resume();
      else if (cmd === "quit") {
        agent.stop();
        process.exit(0);
      } else if (cmd) {
        console.log(`[fake-agent] unknown command '${cmd}'`);
      }
    }
  });

  await new Promise(() => {}); // run until killed
}
