import {
  DEFAULT_WS_PORT,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_JOB_OUTPUT_BYTES,
} from "@mrc/shared";
import { statSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@mrc/shared/version";
import { DEFAULT_MAX_RETAINED_JOBS, DEFAULT_RETAINED_JOB_TTL_MS } from "./hub.ts";
import type { LogLevel } from "./log.ts";

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  /** True when MRC_TOKEN was not set and the insecure development token is in use. */
  usingDefaultToken: boolean;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  defaultJobTimeoutMs: number;
  maxJobOutputBytes: number;
  /** Where agent_screenshot saves images pulled from remote agents. */
  screenshotDir: string;
  /** Newest screenshots to keep on disk (MRC_SCREENSHOT_KEEP, 0 = keep everything). */
  screenshotKeep: number;
  /** Directory holding mcp.db and audit.jsonl (MRC_DATA_DIR). */
  dataDir: string;
  /** SQLite registry path (MRC_DB_PATH, default <dataDir>/mcp.db). */
  dbPath: string;
  /** Audit trail path (MRC_AUDIT_PATH, default <dataDir>/audit.jsonl). */
  auditPath: string;
  /** When true the shared MRC_TOKEN is rejected; only enrolled per-agent tokens work. */
  requireDbTokens: boolean;
  /** Max in-flight jobs per agent (MRC_MAX_JOBS_PER_AGENT, default 8). */
  maxJobsPerAgent: number;
  /** Max accepted jobs per agent in a rolling 60s window (MRC_MAX_JOBS_PER_MIN, default 120). */
  maxJobsPerMinute: number;
  /** Finished async jobs kept for agent_jobs status/list (MRC_JOB_HISTORY_MAX, default 100). */
  maxRetainedJobs: number;
  /** How long a finished async job stays queryable (MRC_JOB_HISTORY_TTL_MS, default 30 min). */
  retainedJobTtlMs: number;
  /** Serve MCP over Streamable HTTP on the hub port (MRC_MCP_HTTP_PORT, 0 = disabled). */
  mcpHttpPort: number;
  /** Public base URL of the MCP HTTP face (MRC_PUBLIC_URL), e.g. http://192.168.1.192:8788. */
  publicUrl: string;
  /** Auto-update: newest agent build announced in `welcome` (empty = off). */
  agentLatestVersion: string;
  /** Auto-update: binary URL (relative resolves against the hub origin). */
  agentBinaryUrl: string;
  /**
   * Auto-update: Windows UNC path (or template) to the build, e.g.
   * \\192.168.1.191\Hermes\rc-agent-{version}.exe. `{version}` is replaced
   * with the announced version at runtime, so one env var covers every release.
   * Agents on the same LAN copy it directly; the hub only forwards the path
   * (it cannot read the share itself).
   */
  agentBinaryUnc: string;
  /** Auto-update: expected sha256 of that binary (optional but recommended). */
  agentBinarySha256: string;
  /** Auto-update: local file served at /agent/latest.exe (empty = not served). */
  agentBinaryPath: string;
  /** TLS material for both faces (MRC_TLS_CERT/MRC_TLS_KEY); ws://+http:// when unset. */
  tlsCertPath: string;
  tlsKeyPath: string;
  logLevel: LogLevel;
}

const DEV_TOKEN = "dev-token";
const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`);
  }
  return value;
}

/** Port where 0 means "disabled" (MRC_MCP_HTTP_PORT). */
function portOrZero(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${name} must be a TCP port or 0 to disable, got '${raw}'`);
  }
  return value;
}

/**
 * Where the Docker image puts the agent build; absent in dev checkouts, where
 * OTA stays off unless MRC_AGENT_BINARY_PATH points at a binary.
 */
function defaultAgentBinaryPath(dataDir: string): string {
  const candidate = join(dataDir, "..", "..", "agent", "rc-agent.exe");
  try {
    return statSync(candidate).isFile() ? candidate : "";
  } catch {
    return "";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const token = env.MRC_TOKEN?.trim() || DEV_TOKEN;
  const port = Number(env.MRC_PORT ?? DEFAULT_WS_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`MRC_PORT must be a valid TCP port, got '${env.MRC_PORT}'`);
  }
  const logLevel = (env.MRC_LOG_LEVEL?.trim() || "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`MRC_LOG_LEVEL must be one of ${LOG_LEVELS.join("|")}, got '${env.MRC_LOG_LEVEL}'`);
  }
  const dataDir = env.MRC_DATA_DIR?.trim() || join(import.meta.dir, "..", "data");
  return {
    host: env.MRC_HOST?.trim() || "127.0.0.1",
    port,
    token,
    usingDefaultToken: token === DEV_TOKEN,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    defaultJobTimeoutMs: positiveInt(env.MRC_JOB_TIMEOUT_MS, "MRC_JOB_TIMEOUT_MS", 30_000),
    maxJobOutputBytes: MAX_JOB_OUTPUT_BYTES,
    screenshotDir: env.MRC_SCREENSHOT_DIR?.trim() || join(dataDir, "screenshots"),
    screenshotKeep: positiveInt(env.MRC_SCREENSHOT_KEEP, "MRC_SCREENSHOT_KEEP", 200),
    dataDir,
    dbPath: env.MRC_DB_PATH?.trim() || join(dataDir, "mcp.db"),
    auditPath: env.MRC_AUDIT_PATH?.trim() || join(dataDir, "audit.jsonl"),
    requireDbTokens: ["1", "true", "yes"].includes((env.MRC_REQUIRE_DB_TOKENS ?? "").trim().toLowerCase()),
    maxJobsPerAgent: positiveInt(env.MRC_MAX_JOBS_PER_AGENT, "MRC_MAX_JOBS_PER_AGENT", 8),
    maxJobsPerMinute: positiveInt(env.MRC_MAX_JOBS_PER_MIN, "MRC_MAX_JOBS_PER_MIN", 120),
    maxRetainedJobs: positiveInt(env.MRC_JOB_HISTORY_MAX, "MRC_JOB_HISTORY_MAX", DEFAULT_MAX_RETAINED_JOBS),
    retainedJobTtlMs: positiveInt(env.MRC_JOB_HISTORY_TTL_MS, "MRC_JOB_HISTORY_TTL_MS", DEFAULT_RETAINED_JOB_TTL_MS),
    mcpHttpPort: portOrZero(env.MRC_MCP_HTTP_PORT, "MRC_MCP_HTTP_PORT", 0),
    publicUrl: (env.MRC_PUBLIC_URL?.trim() ?? "").replace(/\/+$/, ""),
    agentLatestVersion: VERSION,
    agentBinaryUrl: env.MRC_AGENT_BINARY_URL?.trim() ?? "",
    agentBinaryUnc: env.MRC_AGENT_BINARY_UNC?.trim() ?? "",
    agentBinarySha256: env.MRC_AGENT_BINARY_SHA256?.trim().toLowerCase() ?? "",
    // Default to the build shipped in the image (see Dockerfile), so a deploy
    // publishes the agent automatically without any environment variable.
    agentBinaryPath: env.MRC_AGENT_BINARY_PATH?.trim() || defaultAgentBinaryPath(dataDir),
    tlsCertPath: env.MRC_TLS_CERT?.trim() ?? "",
    tlsKeyPath: env.MRC_TLS_KEY?.trim() ?? "",
    logLevel,
  };
}

/**
 * Base URL a client should use to download screenshots: `MRC_PUBLIC_URL` when
 * set, otherwise derived from a concrete bind host + MCP HTTP port. Empty when
 * it cannot be determined (bind address is 0.0.0.0 / ::), so callers fall back
 * to returning only the relative `/screenshots/<file>` path.
 */
export function screenshotBaseUrl(config: ServerConfig): string {
  if (config.publicUrl) return config.publicUrl;
  const host = config.host;
  if (!host || host === "0.0.0.0" || host === "::" || config.mcpHttpPort <= 0) return "";
  const scheme = config.tlsCertPath && config.tlsKeyPath ? "https" : "http";
  return `${scheme}://${host}:${config.mcpHttpPort}`;
}
