/**
 * Test preload: the suite asserts config precedence from a pristine
 * environment, so strip the operator's real .env values before any test runs.
 */
for (const key of ["MRC_TOKEN", "MRC_SERVER", "MRC_NAME", "MRC_TAGS", "MRC_LOG_LEVEL", "MRC_HOST", "MRC_PORT",
  "MRC_MCP_HTTP_PORT", "MRC_JOB_TIMEOUT_MS", "MRC_MAX_JOBS_PER_AGENT", "MRC_MAX_JOBS_PER_MIN",
  "MRC_AUTO_UPDATE", "MRC_TLS_INSECURE", "MRC_AGENT_LATEST_VERSION", "MRC_AGENT_BINARY_URL",
  "MRC_AGENT_BINARY_SHA256", "MRC_AGENT_BINARY_PATH", "MCP_URL", "MCP_BEARER"]) {
  delete process.env[key];
}
