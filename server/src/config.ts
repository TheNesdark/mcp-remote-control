import {
  DEFAULT_WS_PORT,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_JOB_OUTPUT_BYTES,
} from "@mrc/shared";
import { join } from "node:path";
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
  /** Serve MCP over Streamable HTTP on the hub port (MRC_MCP_HTTP_PORT, 0 = disabled). */
  mcpHttpPort: number;
  /** Auto-update: newest agent build announced in `welcome` (empty = off). */
  agentLatestVersion: string;
  /** Auto-update: binary URL (relative resolves against the hub origin). */
  agentBinaryUrl: string;
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
    screenshotDir: env.MRC_SCREENSHOT_DIR?.trim() || join(import.meta.dir, "..", "data", "screenshots"),
    dataDir,
    dbPath: env.MRC_DB_PATH?.trim() || join(dataDir, "mcp.db"),
    auditPath: env.MRC_AUDIT_PATH?.trim() || join(dataDir, "audit.jsonl"),
    requireDbTokens: ["1", "true", "yes"].includes((env.MRC_REQUIRE_DB_TOKENS ?? "").trim().toLowerCase()),
    maxJobsPerAgent: positiveInt(env.MRC_MAX_JOBS_PER_AGENT, "MRC_MAX_JOBS_PER_AGENT", 8),
    maxJobsPerMinute: positiveInt(env.MRC_MAX_JOBS_PER_MIN, "MRC_MAX_JOBS_PER_MIN", 120),
    mcpHttpPort: portOrZero(env.MRC_MCP_HTTP_PORT, "MRC_MCP_HTTP_PORT", 0),
    agentLatestVersion: env.MRC_AGENT_LATEST_VERSION?.trim() ?? "",
    agentBinaryUrl: env.MRC_AGENT_BINARY_URL?.trim() ?? "",
    agentBinarySha256: env.MRC_AGENT_BINARY_SHA256?.trim().toLowerCase() ?? "",
    agentBinaryPath: env.MRC_AGENT_BINARY_PATH?.trim() ?? "",
    tlsCertPath: env.MRC_TLS_CERT?.trim() ?? "",
    tlsKeyPath: env.MRC_TLS_KEY?.trim() ?? "",
    logLevel,
  };
}
