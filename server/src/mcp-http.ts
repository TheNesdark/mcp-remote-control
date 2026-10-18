/**
 * MCP over Streamable HTTP (LAN deployments).
 *
 * Same tools as the stdio face, served at POST/GET/DELETE /mcp through the
 * WebStandard transport (native Request/Response, works in Bun.serve).
 * Every request needs `Authorization: Bearer <MRC_TOKEN>`; otherwise 401.
 * The bearer is the shared server secret, so set a strong MRC_TOKEN and never
 * expose this port beyond the trusted LAN.
 *
 * One McpServer + transport is created *per session* (the SDK's multi-session
 * pattern): a client POSTs `initialize` without an `Mcp-Session-Id` header and
 * gets a fresh session; later requests carry the header and are routed to
 * that session's transport. A single shared transport would instead lock the
 * endpoint to the first client and answer 400 "Server already initialized"
 * to everyone else, including the first client after a reconnect.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { sameSecret } from "@mrc/shared/secret";
import type { AuditLog } from "./audit.ts";
import type { Hub } from "./hub.ts";
import { registerTools } from "./tools/index.ts";

export const MCP_HTTP_PATH = "/mcp";
const SESSION_HEADER = "mcp-session-id";

export interface McpHttpOptions {
  version: string;
  screenshotDir: string;
  /** Newest screenshots to keep on disk (0 = keep everything). */
  screenshotKeep?: number;
  /** Base URL clients use to fetch saved screenshots (empty = relative only). */
  screenshotBaseUrl?: string;
  audit: AuditLog;
  bearerToken: string;
}

interface McpSession {
  mcp: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
}

export interface McpHttpHandler {
  (req: Request): Promise<Response>;
  /** Close all live sessions (server shutdown). */
  close(): void;
}

export function createMcpHttpHandler(hub: Hub, opts: McpHttpOptions): McpHttpHandler {
  const sessions = new Map<string, McpSession>();

  const handler = (async (req: Request): Promise<Response> => {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice("Bearer ".length), opts.bearerToken)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const sessionId = req.headers.get(SESSION_HEADER);
    if (sessionId !== null) {
      const session = sessions.get(sessionId);
      if (!session) return Response.json({ error: "not found" }, { status: 404 });
      return session.transport.handleRequest(req);
    }

    // No session id: only `initialize` (a POST) may create one.
    if (req.method !== "POST") {
      return Response.json(
        { error: "missing or invalid mcp-session-id header" },
        { status: 400 },
      );
    }

    const mcp = new McpServer({ name: "mcp-remote-control", version: opts.version });
    registerTools(mcp, hub, {
      screenshotDir: opts.screenshotDir,
      screenshotKeep: opts.screenshotKeep,
      screenshotBaseUrl: opts.screenshotBaseUrl,
      audit: opts.audit,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { mcp, transport });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        void mcp.close();
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await mcp.connect(transport);
    return transport.handleRequest(req);
  }) as McpHttpHandler;

  handler.close = () => {
    for (const session of sessions.values()) void session.mcp.close();
    sessions.clear();
  };
  return handler;
}
