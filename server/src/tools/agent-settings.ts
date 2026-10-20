import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

interface SettingsArgs {
  agent: string;
  operation: string;
  name?: string;
  server?: string;
  token?: string;
  tags?: string[];
  autostart?: boolean;
}

export function registerAgentSettings(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<SettingsArgs>(server, hub, audit, {
    name: "agent_settings",
    title: "Read or change the settings of a remote agent",
    description:
      "Reads (operation=read) or changes (operation=write) the settings of an agent: the name it registers " +
      "with, the hub it calls, the token it uses, whether it starts with Windows and whether its watchdog " +
      "is running. The token is never returned in full. A change of name, server or token needs a restart to " +
      "take effect; the result says so.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      operation: z.enum(["read", "write"]).describe("read the settings, or write them."),
      name: z.string().max(120).optional().describe("New name for the agent."),
      server: z.string().max(300).optional().describe("New hub url (ws://host:8787)."),
      token: z.string().max(300).optional().describe("New token for the agent."),
      tags: z.array(z.string().max(60)).optional().describe("New tags for the agent."),
      autostart: z.boolean().optional().describe("Start the agent with Windows (true) or not (false)."),
    },
    options: {
      op: "agent_settings",
      jobType: "settings",
      buildParams: (args) => ({
        operation: args.operation,
        name: args.name,
        server: args.server,
        token: args.token,
        tags: args.tags,
        autostart: args.autostart,
      }),
      buildResult: (outcome) => JSON.parse(outcome.stdout || "{}") as Record<string, unknown>,
      buildFailure: (outcome) => {
        const meta = (outcome.meta ?? {}) as { error?: unknown };
        if (meta.error) return { ok: false, error: meta.error };
        return { ok: false, error: outcome.error ?? "the settings could not be read" };
      },
    },
  });
}
