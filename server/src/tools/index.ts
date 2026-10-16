import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Hub } from "../hub.ts";
import { registerAgentsList } from "./agents-list.ts";

/** Register every MCP tool exposed by the server. */
export function registerTools(server: McpServer, hub: Hub): void {
  registerAgentsList(server, hub);
}
