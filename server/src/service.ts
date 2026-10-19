import type { Server } from "bun";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { AGENT_PATH, MAX_FRAME_BYTES } from "@mrc/shared";
import { AuditLog } from "./audit.ts";
import { screenshotBaseUrl, type ServerConfig } from "./config.ts";
import { Hub, type WsData } from "./hub.ts";
import { logger, setLogLevel } from "./log.ts";
import { createMcpHttpHandler, MCP_HTTP_PATH } from "./mcp-http.ts";
import { createRegistry, type TokenRegistry } from "./registry.ts";
import { handleScreenshotRequest, SCREENSHOT_HTTP_PREFIX } from "./screenshots-http.ts";
import { scheduleScreenshotPrune } from "./screenshots-retention.ts";
import { AgentStore } from "./store.ts";

/** TLS material for Bun.serve; undefined keeps the plain ws://+http:// faces. */
function tlsOptions(config: ServerConfig): { cert: string; key: string } | undefined {
  if (!config.tlsCertPath && !config.tlsKeyPath) return undefined;
  if (!config.tlsCertPath || !config.tlsKeyPath) {
    throw new Error("MRC_TLS_CERT and MRC_TLS_KEY must be set together");
  }
  return {
    cert: Bun.file(config.tlsCertPath),
    key: Bun.file(config.tlsKeyPath),
  } as unknown as { cert: string; key: string };
}

/** Auto-update: path where the hub hands out the published agent binary. */
export const AGENT_BINARY_PATH = "/agent/latest.exe";

export interface Service {  server: Server<WsData>;
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
  const startedAt = Date.now();
  setLogLevel(config.logLevel);
  const store = new AgentStore(config.dbPath);
  const registry = createRegistry(store, {
    legacyToken: config.token,
    allowLegacy: !config.requireDbTokens,
  });
  const audit = new AuditLog(config.auditPath);

  // Auto-update, HTTP route: the hub serves the binary itself, so it can hash
  // it and let the agent verify the download.
  //
  // Auto-update, UNC route: the build lives on a share the hub cannot read,
  // so no hash is published here. A stale MRC_AGENT_BINARY_SHA256 would make
  // the agent reject every real build, so it is only honoured when it comes
  // from the file the hub actually serves. Agents verify the UNC download by
  // the version stamped in the binary instead.
  const servesBinary = Boolean(config.agentBinaryPath);
  let agentBinarySha256 = servesBinary ? config.agentBinarySha256 : "";
  if (servesBinary && !agentBinarySha256) {
    try {
      const buf = readFileSync(config.agentBinaryPath);
      agentBinarySha256 = createHash("sha256").update(buf).digest("hex");
      logger.info("computed agent binary sha256 from file", { path: config.agentBinaryPath, sha256: agentBinarySha256 });
    } catch (err) {
      logger.warn("could not read agent binary for sha256", { path: config.agentBinaryPath, error: String(err) });
    }
  }
  if (!servesBinary && config.agentBinarySha256) {
    logger.warn("ignoring MRC_AGENT_BINARY_SHA256: the hub does not serve the binary, so the hash cannot be verified", {
      sha256: config.agentBinarySha256,
    });
  }

  const hub = new Hub({
    registry,
    audit,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    defaultJobTimeoutMs: config.defaultJobTimeoutMs,
    maxJobOutputBytes: config.maxJobOutputBytes,
    maxJobsPerAgent: config.maxJobsPerAgent,
    maxJobsPerMinute: config.maxJobsPerMinute,
    maxRetainedJobs: config.maxRetainedJobs,
    retainedJobTtlMs: config.retainedJobTtlMs,
    ...(config.agentLatestVersion
      ? {
          update: {
            latestVersion: config.agentLatestVersion,
            ...(servesBinary || config.agentBinaryUrl
              ? { binaryUrl: config.agentBinaryUrl || "/agent/latest.exe" }
              : {}),
            ...(config.agentBinaryUnc ? { binaryUnc: config.agentBinaryUnc } : {}),
            ...(agentBinarySha256 ? { binarySha256: agentBinarySha256 } : {}),
          },
        }
      : {}),
  });
  hub.start();
  // Bound the screenshot directory from previous runs before serving anything.
  scheduleScreenshotPrune(config.screenshotDir, config.screenshotKeep);

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
    tls: tlsOptions(config),
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
      // Rich health for Docker HEALTHCHECK / monitoring: no jobs, no auth.
      if (url.pathname === "/health") {
        const stats = hub.stats();
        return Response.json({
          ok: true,
          version,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          agents: stats.agents,
          jobs: stats.jobs,
          lastAgentSeenAt: stats.lastAgentSeenAt ? new Date(stats.lastAgentSeenAt).toISOString() : null,
        });
      }
      // Auto-update: hand out the published agent binary (opt-in via
      // MRC_AGENT_BINARY_PATH). Unauthenticated by design: the file is a
      // public program, and the agents themselves still need a token.
      if (url.pathname === AGENT_BINARY_PATH && config.agentBinaryPath) {
        const file = Bun.file(config.agentBinaryPath);
        return new Response(file, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${basename(config.agentBinaryPath)}"`,
          },
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
  const secure = Boolean(tlsOptions(config));
  const scheme = secure ? "wss" : "ws";
  const httpScheme = secure ? "https" : "http";
  const wsUrl = `${scheme}://${config.host}:${port}${AGENT_PATH}`;
  logger.info("websocket hub listening", { url: wsUrl });

  // Optional second face: MCP over Streamable HTTP for LAN clients
  // (persistent server under systemd; opencode connects as a remote server).
  let mcpServer: Server<unknown> | null = null;
  let mcpHttpPort = 0;
  let mcpHttpUrl = "";
  let closeMcpSessions: (() => void) | null = null;
  if (config.mcpHttpPort > 0) {
    if (config.usingDefaultToken) {
      logger.error("serving MCP over HTTP with the insecure development token; set a strong MRC_TOKEN");
    }
    const handleMcp = createMcpHttpHandler(hub, {
      version,
      screenshotDir: config.screenshotDir,
      screenshotKeep: config.screenshotKeep,
      screenshotBaseUrl: screenshotBaseUrl(config),
      audit,
      bearerToken: config.token,
    });
    closeMcpSessions = handleMcp.close;
    mcpServer = Bun.serve({
      hostname: config.host,
      port: config.mcpHttpPort,
      tls: tlsOptions(config),
      fetch(req) {
        const url = new URL(req.url);
        // Screenshot downloads for clients on other machines (token-protected).
        if (url.pathname.startsWith(SCREENSHOT_HTTP_PREFIX)) {
          return handleScreenshotRequest(req, config.screenshotDir, config.token);
        }
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
    mcpHttpUrl = `${httpScheme}://${config.host}:${mcpHttpPort}${MCP_HTTP_PATH}`;
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
      closeMcpSessions?.();
      registry.close();
    },
  };
}
