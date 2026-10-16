import type { Server } from "bun";
import { AGENT_PATH, MAX_FRAME_BYTES } from "@mrc/shared";
import { AuditLog } from "./audit.ts";
import type { ServerConfig } from "./config.ts";
import { Hub, type WsData } from "./hub.ts";
import { logger, setLogLevel } from "./log.ts";
import { createMcpHttpHandler, MCP_HTTP_PATH } from "./mcp-http.ts";
import { createRegistry, type TokenRegistry } from "./registry.ts";
import { AgentStore } from "./store.ts";

export interface Service {
  server: Server<WsData>;
  hub: Hub;
  store: AgentStore;
  registry: TokenRegistry;
  audit: AuditLog;
  config: ServerConfig;
  port: number;
  wsUrl: string;
  /** Actual MCP-HTTP port (0 when disabled) and URL. */
  mcpHttpPort: number;
  mcpHttpUrl: string;
  close(): void;
}

/** Start the websocket hub that remote agents connect to. */
export function createService(config: ServerConfig, version = "0.0.0"): Service {
  setLogLevel(config.logLevel);
  const store = new AgentStore(config.dbPath);
  const registry = createRegistry(store, {
    legacyToken: config.token,
    allowLegacy: !config.requireDbTokens,
  });
  const audit = new AuditLog(config.auditPath);
  const hub = new Hub({
    registry,
    audit,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    defaultJobTimeoutMs: config.defaultJobTimeoutMs,
    maxJobOutputBytes: config.maxJobOutputBytes,
    maxJobsPerAgent: config.maxJobsPerAgent,
    maxJobsPerMinute: config.maxJobsPerMinute,
  });
  hub.start();

  if (config.requireDbTokens) {
    logger.info("auth mode: per-agent tokens only (legacy shared token disabled)");
  } else if (config.usingDefaultToken) {
    logger.warn("auth mode: insecure development token accepted; enroll agents and set MRC_REQUIRE_DB_TOKENS=1 for production");
  } else {
    logger.info("auth mode: shared MRC_TOKEN accepted alongside enrolled per-agent tokens");
  }

  const server = Bun.serve<WsData>({
    hostname: config.host,
    port: config.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === AGENT_PATH) {
        const upgraded = srv.upgrade(req, { data: { agentId: null } satisfies WsData });
        if (upgraded) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/") {
        return Response.json({
          service: "mcp-remote-control",
          ok: true,
          agents: hub.list().length,
        });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      open: () => {
        // Nothing to do until the first `hello` frame arrives.
      },
      message: (ws, message) =>
        hub.handleMessage(ws, typeof message === "string" ? message : Buffer.from(message).toString("utf8")),
      close: (ws) => hub.handleClose(ws),
    },
  });

  const port = server.port ?? config.port;
  const wsUrl = `ws://${config.host}:${port}${AGENT_PATH}`;
  logger.info("websocket hub listening", { url: wsUrl });

  // Optional second face: MCP over Streamable HTTP for LAN clients
  // (persistent server under systemd; opencode connects as a remote server).
  let mcpServer: Server<unknown> | null = null;
  let mcpHttpPort = 0;
  let mcpHttpUrl = "";
  if (config.mcpHttpPort > 0) {
    if (config.usingDefaultToken) {
      logger.error("serving MCP over HTTP with the insecure development token; set a strong MRC_TOKEN");
    }
    const handleMcp = createMcpHttpHandler(hub, {
      version,
      screenshotDir: config.screenshotDir,
      audit,
      bearerToken: config.token,
    });
    mcpServer = Bun.serve({
      hostname: config.host,
      port: config.mcpHttpPort,
      fetch(req) {
        const url = new URL(req.url);
        if (
          url.pathname === MCP_HTTP_PATH &&
          (req.method === "POST" || req.method === "GET" || req.method === "DELETE")
        ) {
          return handleMcp(req);
        }
        return new Response("not found", { status: 404 });
      },
    });
    mcpHttpPort = mcpServer.port ?? config.mcpHttpPort;
    mcpHttpUrl = `http://${config.host}:${mcpHttpPort}${MCP_HTTP_PATH}`;
    logger.info("mcp http listening", { url: mcpHttpUrl });
  }

  return {
    server,
    hub,
    store,
    registry,
    audit,
    config,
    port,
    wsUrl,
    mcpHttpPort,
    mcpHttpUrl,
    close() {
      hub.shutdown();
      void server.stop(true);
      if (mcpServer) void mcpServer.stop(true);
      registry.close();
    },
  };
}
