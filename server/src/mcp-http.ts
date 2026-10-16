/**
 * MCP over Streamable HTTP (LAN deployments).
 *
 * Same tools as the stdio face, served at POST/GET/DELETE /mcp through the
 * WebStandard transport (native Request/Response, works in Bun.serve).
 * Every request needs `Authorization: Bearer <MRC_TOKEN>`; otherwise 401.
 * The bearer is the shared server secret, so set a strong MRC_TOKEN and never
 * expose this port beyond the trusted LAN.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import type { AuditLog } from "./audit.ts";
import type { Hub } from "./hub.ts";
import { registerTools } from "./tools/index.ts";

export const MCP_HTTP_PATH = "/mcp";

export interface McpHttpOptions {
  version: string;
  screenshotDir: string;
  audit: AuditLog;
  bearerToken: string;
}

function sameSecret(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

export function createMcpHttpHandler(hub: Hub, opts: McpHttpOptions): (req: Request) => Promise<Response> {
  const mcp = new McpServer({ name: "mcp-remote-control", version: opts.version });
  registerTools(mcp, hub, { screenshotDir: opts.screenshotDir, audit: opts.audit });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  const ready = mcp.connect(transport);

  return async (req: Request): Promise<Response> => {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice("Bearer ".length), opts.bearerToken)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    await ready;
    return transport.handleRequest(req);
  };
}
