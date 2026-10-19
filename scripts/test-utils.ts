/**
 * Shared helpers for tests and the e2e harness (unit tests must stay fast
 * and hermetic; keep slow/ heavyweight setup in the individual files).
 */
import { snapshotEnv } from "@mrc/shared/env";
import type { ServerConfig } from "../server/src/config.ts";

/** Copy of the process environment as plain string pairs (for child processes). */
/** Environment variables an e2e/test server must not inherit from the operator's .env. */
const MRC_ENV_KEYS = [
  "MRC_TOKEN", "MRC_HOST", "MRC_PORT", "MRC_MCP_HTTP_PORT", "MRC_LOG_LEVEL", "MRC_DATA_DIR",
  "MRC_DB_PATH", "MRC_AUDIT_PATH", "MRC_SCREENSHOT_DIR", "MRC_REQUIRE_DB_TOKENS", "MRC_JOB_TIMEOUT_MS",
  "MRC_MAX_JOBS_PER_AGENT", "MRC_MAX_JOBS_PER_MIN", "MRC_JOB_HISTORY_MAX", "MRC_JOB_HISTORY_TTL_MS",
  "MRC_TLS_CERT", "MRC_TLS_KEY", "MRC_SERVER",
  "MRC_NAME", "MRC_TAGS", "MRC_AUTO_UPDATE", "MRC_AGENT_LATEST_VERSION", "MRC_AGENT_BINARY_URL",
  "MRC_AGENT_BINARY_SHA256", "MRC_AGENT_BINARY_PATH",
];

/**
 * Snapshot of process.env with every agent/server variable removed. Bun loads
 * the operator's `.env` for every command, and an e2e/test server must not
 * silently inherit a real token, port or auto-update source.
 */
export function cleanEnv(extra?: Record<string, string>): Record<string, string> {
  const env = snapshotEnv();
  for (const key of MRC_ENV_KEYS) delete env[key];
  return snapshotEnv({ ...env, ...extra });
}

export interface WaitForOptions {
  timeoutMs?: number;
  /** Label used in the timeout error (e2e readability). */
  label?: string;
}

/**
 * Poll `fn` until it returns neither `undefined` nor `false`.
 * All call sites use the `cond ? true : undefined` shape; `false` is also
 * treated as "not ready yet" for convenience.
 */
export async function waitFor<T>(
  fn: () => T | undefined | false | Promise<T | undefined | false>,
  opts: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor${opts.label ? ` '${opts.label}'` : ""} timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(25);
  }
}

/** Hub test config: in-memory registry, fixed tmp paths, quiet logs. */
export function testServerConfig(token: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token,
    usingDefaultToken: false,
    heartbeatIntervalMs: 300,
    heartbeatTimeoutMs: 1_500,
    defaultJobTimeoutMs: 2_000,
    maxJobOutputBytes: 1_000_000,
    screenshotDir: "/tmp/mrc-test-screenshots",
    screenshotKeep: 0,
    dataDir: "/tmp/mrc-test-data",
    dbPath: ":memory:",
    auditPath: "/tmp/mrc-test-audit.jsonl",
    requireDbTokens: false,
    maxJobsPerAgent: 8,
    maxJobsPerMinute: 120,
    maxRetainedJobs: 100,
    retainedJobTtlMs: 1_800_000,
    mcpHttpPort: 0,
    publicUrl: "",
    agentLatestVersion: "",
    agentBinaryUrl: "",
    agentBinaryUnc: "",
    agentBinarySha256: "",
    agentBinaryPath: "",
    tlsCertPath: "",
    tlsKeyPath: "",
    logLevel: "error",
    ...overrides,
  };
}

/** Read a JSONL file, skipping blank lines. */
export async function readJsonLines(path: string): Promise<unknown[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}
