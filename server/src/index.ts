#!/usr/bin/env bun
/**
 * mcp-remote-control -- central server.
 *
 * One process, up to three faces:
 *   - MCP over stdio (for the LLM client, e.g. opencode)
 *   - MCP over Streamable HTTP at /mcp (LAN clients, Bearer <MRC_TOKEN>)
 *   - WebSocket hub for the remote agents (rc-agent.exe)
 *
 * IMPORTANT: stdout is reserved for the MCP stdio transport; logs go to stderr.
 *
 * Configuration (environment):
 *   MRC_HOST         bind address            (default 127.0.0.1)
 *   MRC_PORT         websocket port          (default 8787)
 *   MRC_TOKEN        shared auth token       (default dev-token, insecure)
 *   MRC_REQUIRE_DB_TOKENS  only enrolled per-agent tokens (default unset)
 *   MRC_DATA_DIR / MRC_DB_PATH / MRC_AUDIT_PATH / MRC_SCREENSHOT_DIR
 *   MRC_JOB_TIMEOUT_MS default job timeout   (default 30000)
 *   MRC_MAX_JOBS_PER_AGENT in-flight cap     (default 8)
 *   MRC_MAX_JOBS_PER_MIN rate limit          (default 120)
 *   MRC_MCP_HTTP_PORT  MCP over HTTP port    (default 0 = disabled)
 *   MRC_PUBLIC_URL   base URL clients use for the HTTP face, announced in
 *                  agent_screenshot links (e.g. http://192.168.1.192:8788)
 *   MRC_TLS_CERT / MRC_TLS_KEY  PEM files; when set both faces serve
 *                  wss://+https:// (self-signed is fine on a trusted LAN;
 *                  agents need the CA or MRC_TLS_INSECURE=1)
 *   MRC_LOG_LEVEL    debug|info|warn|error   (default info)
 *
 * Flags: --mcp-http-port <n>, --no-mcp-stdio (systemd: hub + HTTP only).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { argFlag, argString, parseArgv } from "@mrc/shared/args";
import { loadConfig, screenshotBaseUrl } from "./config.ts";
import { logger, setLogLevel } from "./log.ts";
import { createService } from "./service.ts";
import { registerTools } from "./tools/index.ts";

import { VERSION } from "@mrc/shared/version";

const args = parseArgv(process.argv.slice(2));
const httpPortFlag = argString(args, "mcp-http-port");
if (httpPortFlag !== undefined) process.env.MRC_MCP_HTTP_PORT = httpPortFlag;
const noStdio = argFlag(args, "no-mcp-stdio");

const config = loadConfig();
setLogLevel(config.logLevel);

if (config.usingDefaultToken) {
  logger.warn("MRC_TOKEN is not set; using the insecure development token 'dev-token'");
}

const service = createService(config, VERSION);

let transport: StdioServerTransport | null = null;
if (!noStdio) {
  const mcp = new McpServer({ name: "mcp-remote-control", version: VERSION });
  registerTools(mcp, service.hub, {
    screenshotDir: config.screenshotDir,
    screenshotBaseUrl: screenshotBaseUrl(config),
    audit: service.audit,
  });

  transport = new StdioServerTransport();
  await mcp.connect(transport);
  logger.info("mcp server connected over stdio", { name: "mcp-remote-control", version: VERSION });
} else {
  logger.info("mcp stdio disabled (--no-mcp-stdio); serving hub" + (service.mcpHttpPort > 0 ? " + mcp http" : " only"));
}

let shuttingDown = false;
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { reason });
  service.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (transport) {
  transport.onclose = () => shutdown("mcp stdio closed");
} else {
  // No stdio client attached (e.g. systemd): stay alive for hub + HTTP.
  await new Promise(() => {});
}
