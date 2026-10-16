/**
 * Wire protocol shared by the central server and the remote agents.
 *
 * One WebSocket text frame carries exactly one JSON message (see PLAN.md §2.3).
 * All protocol strings are English.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const DEFAULT_WS_PORT = 8787;
export const AGENT_PATH = "/agent";
export const HEARTBEAT_INTERVAL_MS = 10_000;
/** A socket is considered dead after 3 missed heartbeats. */
export const HEARTBEAT_TIMEOUT_MS = 3 * HEARTBEAT_INTERVAL_MS;
/** Refuse frames larger than this. */
export const MAX_FRAME_BYTES = 1_048_576;
/** Job output kept in memory per stream before truncating. */
export const MAX_JOB_OUTPUT_BYTES = 1_048_576;

export const JOB_TYPES = [
  "exec",
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.upload",
  "fs.download",
  "info",
  "ps.list",
  "ps.kill",
  "screenshot",
] as const;
export const JobType = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobType>;

// ---------------------------------------------------------------------------
// Job parameters
// ---------------------------------------------------------------------------

/** Shell used for `exec` jobs. `native` = cmd.exe on Windows, sh on POSIX. */
export const ShellType = z.enum(["native", "cmd", "powershell"]);
export type ShellType = z.infer<typeof ShellType>;

export const ExecParams = z.object({
  command: z.string().min(1),
  shell: ShellType.default("native"),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  stdin: z.string().optional(),
});
export type ExecParams = z.infer<typeof ExecParams>;

// ---------------------------------------------------------------------------
// Agent -> Server
// ---------------------------------------------------------------------------

export const HelloMsg = z.object({
  type: z.literal("hello"),
  proto: z.number().int().positive(),
  token: z.string().min(1),
  agentId: z.string().min(1).optional(),
  name: z.string().min(1).max(64),
  host: z.string().min(1),
  os: z.string().min(1),
  version: z.string().min(1),
  tags: z.array(z.string()).default([]),
  caps: z.array(z.string()).default([]),
  paused: z.boolean().default(false),
});

export const HeartbeatMsg = z.object({
  type: z.literal("heartbeat"),
  ts: z.number(),
  metrics: z
    .object({
      cpuPercent: z.number().optional(),
      memPercent: z.number().optional(),
      uptimeSec: z.number().optional(),
    })
    .optional(),
});

export const PresenceMsg = z.object({
  type: z.literal("presence"),
  paused: z.boolean(),
});

export const JobOutputMsg = z.object({
  type: z.literal("job.output"),
  jobId: z.string().min(1),
  stream: z.enum(["stdout", "stderr"]),
  seq: z.number().int().nonnegative(),
  data: z.string(),
});

export const JobResultMsg = z.object({
  type: z.literal("job.result"),
  jobId: z.string().min(1),
  ok: z.boolean(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});

export const AgentMsg = z.discriminatedUnion("type", [
  HelloMsg,
  HeartbeatMsg,
  PresenceMsg,
  JobOutputMsg,
  JobResultMsg,
]);
export type AgentMsg = z.infer<typeof AgentMsg>;
export type HelloMsg = z.infer<typeof HelloMsg>;
export type HeartbeatMsg = z.infer<typeof HeartbeatMsg>;
export type PresenceMsg = z.infer<typeof PresenceMsg>;
export type JobOutputMsg = z.infer<typeof JobOutputMsg>;
export type JobResultMsg = z.infer<typeof JobResultMsg>;

// ---------------------------------------------------------------------------
// Server -> Agent
// ---------------------------------------------------------------------------

export const WelcomeMsg = z.object({
  type: z.literal("welcome"),
  agentId: z.string().min(1),
  serverTime: z.number(),
  heartbeatIntervalMs: z.number().int().positive(),
});

export const JobRequestMsg = z.object({
  type: z.literal("job.request"),
  jobId: z.string().min(1),
  jobType: JobType,
  params: z.unknown(),
  timeoutMs: z.number().int().positive(),
});

export const JobCancelMsg = z.object({
  type: z.literal("job.cancel"),
  jobId: z.string().min(1),
});

export const PingMsg = z.object({
  type: z.literal("ping"),
  ts: z.number(),
});

export const ServerErrorMsg = z.object({
  type: z.literal("error"),
  code: z.string().min(1),
  message: z.string(),
});

export const ServerMsg = z.discriminatedUnion("type", [
  WelcomeMsg,
  JobRequestMsg,
  JobCancelMsg,
  PingMsg,
  ServerErrorMsg,
]);
export type ServerMsg = z.infer<typeof ServerMsg>;
export type WelcomeMsg = z.infer<typeof WelcomeMsg>;
export type JobRequestMsg = z.infer<typeof JobRequestMsg>;
export type JobCancelMsg = z.infer<typeof JobCancelMsg>;
export type PingMsg = z.infer<typeof PingMsg>;
export type ServerErrorMsg = z.infer<typeof ServerErrorMsg>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; msg: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const res = schema.safeParse(json);
  if (!res.success) {
    const issue = res.error.issues[0];
    return {
      ok: false,
      error: issue ? `${issue.path.join(".") || "message"}: ${issue.message}` : "schema validation failed",
    };
  }
  return { ok: true, msg: res.data };
}

export function parseAgentMsg(raw: string): ParseResult<AgentMsg> {
  return parseWith(AgentMsg, raw);
}

export function parseServerMsg(raw: string): ParseResult<ServerMsg> {
  return parseWith(ServerMsg, raw);
}

export function encodeMsg(msg: AgentMsg | ServerMsg): string {
  return JSON.stringify(msg);
}

/** ws://host:8787 -> ws://host:8787/agent (custom paths are kept untouched). */
export function normalizeAgentUrl(raw: string): string {
  const url = new URL(raw);
  if (url.pathname === "" || url.pathname === "/") url.pathname = AGENT_PATH;
  return url.toString();
}
