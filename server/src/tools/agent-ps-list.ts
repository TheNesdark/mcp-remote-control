import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PS_SORTS } from "@mrc/shared";
import type { Hub } from "../hub.ts";
import { toolError, toolJson } from "./util.ts";

export function registerAgentPsList(server: McpServer, hub: Hub): void {
  server.registerTool(
    "agent_ps_list",
    {
      title: "List processes on a remote agent",
      description:
        "List running processes on a remote machine (pid, name, user, cpuPercent, memBytes, command). " +
        "Filter by name/command substring and take the top N by cpu, mem, pid or name.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        filter: z.string().optional().describe("Case-insensitive substring match on process name or command line."),
        top: z.number().int().positive().max(5_000).optional().describe("Return at most this many processes (default 100)."),
        sort: z.enum(PS_SORTS).optional().describe("Order before truncating: cpu | mem | pid | name (default cpu)."),
      },
    },
    async (args) => {
      try {
        const outcome = await hub.request(args.agent, "ps.list", {
          filter: args.filter,
          top: args.top ?? 100,
          sort: args.sort ?? "cpu",
        });
        if (!outcome.ok) return toolJson({ ok: false, error: outcome.error ?? "ps.list failed" }, true);
        const parsed = JSON.parse(outcome.stdout || "{}") as Record<string, unknown>;
        return toolJson(parsed);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
