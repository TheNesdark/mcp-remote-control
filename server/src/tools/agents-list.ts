import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";

export function registerAgentsList(server: McpServer, hub: Hub, audit: AuditLog): void {
  server.registerTool(
    "agents_list",
    {
      title: "List remote agents",
      description:
        "List every known remote machine (agent). Online agents that are not paused can receive commands. " +
        "Use the returned 'id' (or the unique 'name') as the 'agent' argument of every other tool.",
      inputSchema: {},
    },
    async () => {
      const startedAt = Date.now();
      const agents = hub.list();
      auditToolCall(audit, { op: "agents_list", startedAt, ok: true });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(agents, null, 2) }],
      };
    },
  );
}
