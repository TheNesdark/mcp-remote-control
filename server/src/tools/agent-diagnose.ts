import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

interface DiagnoseArgs {
  agent: string;
}

export function registerAgentDiagnose(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<DiagnoseArgs>(server, hub, audit, {
    name: "agent_diagnose",
    title: "Health report of a remote agent and of what it drives",
    description:
      "One call that answers the three questions that come up when a remote desktop misbehaves: is the " +
      "agent alive, is the Java Access Bridge usable, and is the Java application still running. It also " +
      "reports the open windows, the state of the screen recording and the last lines of the agent log.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
    },
    options: {
      op: "agent_diagnose",
      jobType: "diagnose",
      buildParams: () => ({}),
      buildResult: (outcome) => JSON.parse(outcome.stdout || "{}") as Record<string, unknown>,
    },
  });
}
