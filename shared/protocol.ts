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
  "fs.hash",
  "info",
  "ps.list",
  "ps.kill",
  "screenshot",
] as const;
export const JobType = z.enum(JOB_TYPES);
export type JobType = z.infer<typeof JobType>;

// ---------------------------------------------------------------------------
// File transfer limits
// ---------------------------------------------------------------------------

/** Hard cap for a single fs.read/fs.write chunk (base64 stays under the frame limit). */
export const FS_MAX_CHUNK_BYTES = 512 * 1024;
/** Default chunk used by the upload/download loops. */
export const FS_DEFAULT_CHUNK_BYTES = 256 * 1024;

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

export const FsListParams = z.object({
  path: z.string().min(1),
  limit: z.number().int().positive().max(5_000).default(1_000),
});
export type FsListParams = z.infer<typeof FsListParams>;

export const FsReadParams = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().positive().max(FS_MAX_CHUNK_BYTES).default(FS_DEFAULT_CHUNK_BYTES),
});
export type FsReadParams = z.infer<typeof FsReadParams>;

export const FsWriteParams = z.object({
  path: z.string().min(1),
  /** Payload chunk, always base64. */
  data: z.string(),
  mode: z.enum(["overwrite", "append"]).default("overwrite"),
  /** Create parent directories if missing. */
  mkdirs: z.boolean().default(false),
});
export type FsWriteParams = z.infer<typeof FsWriteParams>;

export const FsHashParams = z.object({
  path: z.string().min(1),
});
export type FsHashParams = z.infer<typeof FsHashParams>;

// ---------------------------------------------------------------------------
// Inventory / processes / screenshot
// ---------------------------------------------------------------------------

export const InfoParams = z.object({});
export type InfoParams = z.infer<typeof InfoParams>;

export const PS_SORTS = ["cpu", "mem", "pid", "name"] as const;
export const PsListParams = z.object({
  /** Case-insensitive substring match on process name or command line. */
  filter: z.string().optional(),
  top: z.number().int().positive().max(5_000).default(100),
  sort: z.enum(PS_SORTS).default("cpu"),
});
export type PsListParams = z.infer<typeof PsListParams>;

export const PsKillParams = z
  .object({
    pid: z.number().int().positive().optional(),
    /** Kill every process whose executable name matches (case-insensitive). */
    name: z.string().min(1).optional(),
    /** true = SIGKILL / taskkill /F; false = SIGTERM / taskkill without /F. */
    force: z.boolean().default(true),
    /** Kill the whole process tree rooted at each target. */
    tree: z.boolean().default(true),
  })
  .refine((value) => (value.pid === undefined) !== (value.name === undefined), {
    message: "provide exactly one of 'pid' or 'name'",
  });
export type PsKillParams = z.infer<typeof PsKillParams>;

export const SCREENSHOT_FORMATS = ["png", "jpeg"] as const;
export const ScreenshotParams = z.object({
  format: z.enum(SCREENSHOT_FORMATS).default("png"),
  /** JPEG quality (1-100); ignored for png. */
  quality: z.number().int().min(1).max(100).default(80),
});
export type ScreenshotParams = z.infer<typeof ScreenshotParams>;

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
  /** How to interpret `data` (default utf8). */
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});

export const JobResultMsg = z.object({
  type: z.literal("job.result"),
  jobId: z.string().min(1),
  ok: z.boolean(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
  /** Structured per-job-type metadata (sizes, hashes, entries...). */
  meta: z.record(z.string(), z.unknown()).optional(),
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
