import type { Server } from "bun";
import { AGENT_PATH, MAX_FRAME_BYTES } from "@mrc/shared";
import type { ServerConfig } from "./config.ts";
import { Hub, type WsData } from "./hub.ts";
import { logger, setLogLevel } from "./log.ts";

export interface Service {
  server: Server<WsData>;
  hub: Hub;
  port: number;
  wsUrl: string;
  close(): void;
}

/** Start the websocket hub that remote agents connect to. */
export function createService(config: ServerConfig): Service {
  setLogLevel(config.logLevel);
  const hub = new Hub({
    token: config.token,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    defaultJobTimeoutMs: config.defaultJobTimeoutMs,
    maxJobOutputBytes: config.maxJobOutputBytes,
  });
  hub.start();

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

  return {
    server,
    hub,
    port,
    wsUrl,
    close() {
      hub.shutdown();
      void server.stop(true);
    },
  };
}
