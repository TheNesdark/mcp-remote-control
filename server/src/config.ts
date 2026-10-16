import {
  DEFAULT_WS_PORT,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_JOB_OUTPUT_BYTES,
} from "@mrc/shared";
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
  logLevel: LogLevel;
}

const DEV_TOKEN = "dev-token";
const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

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
  return {
    host: env.MRC_HOST?.trim() || "127.0.0.1",
    port,
    token,
    usingDefaultToken: token === DEV_TOKEN,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    defaultJobTimeoutMs: Number(env.MRC_JOB_TIMEOUT_MS ?? 30_000),
    maxJobOutputBytes: MAX_JOB_OUTPUT_BYTES,
    logLevel,
  };
}
