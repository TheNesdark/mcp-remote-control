#!/usr/bin/env bun
/**
 * mcp-remote-control -- central server.
 *
 * One process, two faces:
 *   - MCP over stdio (for the LLM client, e.g. opencode)
 *   - WebSocket hub for the remote agents (rc-agent.exe)
 *
 * IMPORTANT: stdout is reserved for the MCP stdio transport; logs go to stderr.
 *
 * Configuration (environment):
 *   MRC_HOST         bind address            (default 127.0.0.1)
 *   MRC_PORT         websocket port          (default 8787)
 *   MRC_TOKEN        shared auth token       (default dev-token, insecure)
 *   MRC_JOB_TIMEOUT_MS default job timeout   (default 30000)
 *   MRC_LOG_LEVEL    debug|info|warn|error   (default info)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { logger, setLogLevel } from "./log.ts";
import { createService } from "./service.ts";
import { registerTools } from "./tools/index.ts";

const VERSION = "0.3.0";

const config = loadConfig();
setLogLevel(config.logLevel);

if (config.usingDefaultToken) {
  logger.warn("MRC_TOKEN is not set; using the insecure development token 'dev-token'");
}

const service = createService(config);

const mcp = new McpServer({ name: "mcp-remote-control", version: VERSION });
registerTools(mcp, service.hub, { screenshotDir: config.screenshotDir });

const transport = new StdioServerTransport();
await mcp.connect(transport);
logger.info("mcp server connected over stdio", { name: "mcp-remote-control", version: VERSION });

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
transport.onclose = () => shutdown("mcp stdio closed");
