import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

interface InfoArgs {
  agent: string;
}

export function registerAgentInfo(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<InfoArgs>(server, hub, audit, {
    name: "agent_info",
    title: "System inventory of a remote agent",
    description:
      "Return a system inventory of a remote machine: hostname, OS, logged-in user, uptime, CPU " +
      "(model/cores/load), memory (total/free), network addresses and disks (with free space).",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
    },
    options: {
      op: "agent_info",
      jobType: "info",
      buildParams: () => ({}),
      buildResult: (outcome) => JSON.parse(outcome.stdout || "{}") as Record<string, unknown>,
    },
  });
}
