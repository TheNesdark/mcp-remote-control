import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Hub } from "../hub.ts";
import { toolError, toolJson } from "./util.ts";

export function registerAgentInfo(server: McpServer, hub: Hub): void {
  server.registerTool(
    "agent_info",
    {
      title: "System inventory of a remote agent",
      description:
        "Return a system inventory of a remote machine: hostname, OS, logged-in user, uptime, CPU " +
        "(model/cores/load), memory (total/free), network addresses and disks (with free space).",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      },
    },
    async (args) => {
      try {
        const outcome = await hub.request(args.agent, "info", {}, undefined, { op: "agent_info", params: args });
        if (!outcome.ok) return toolJson({ ok: false, error: outcome.error ?? "info failed" }, true);
        const parsed = JSON.parse(outcome.stdout || "{}") as Record<string, unknown>;
        return toolJson(parsed);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
