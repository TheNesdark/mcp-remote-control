import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

interface PsKillArgs {
  agent: string;
  pid?: number;
  name?: string;
  force?: boolean;
  tree?: boolean;
}

export function registerAgentPsKill(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<PsKillArgs>(server, hub, audit, {
    name: "agent_ps_kill",
    title: "Kill processes on a remote agent",
    description:
      "Kill a process by pid, or every process whose executable name matches (case-insensitive, '.exe' optional). " +
      "By default the whole process tree is killed forcefully (SIGKILL / taskkill /T /F); use force=false and/or " +
      "tree=false for a graceful, single-process kill. The agent refuses to kill itself.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      pid: z.number().int().positive().optional().describe("Process id to kill (exactly one of pid or name)."),
      name: z
        .string()
        .min(1)
        .optional()
        .describe("Executable name; every match is killed (e.g. 'notepad' or 'notepad.exe')."),
      force: z.boolean().optional().describe("SIGKILL / taskkill /F (default true)."),
      tree: z.boolean().optional().describe("Also kill child processes (default true)."),
    },
    options: {
      op: "agent_ps_kill",
      jobType: "ps.kill",
      validate: (args) =>
        (args.pid === undefined) === (args.name === undefined) ? "provide exactly one of 'pid' or 'name'" : null,
      buildParams: (args) => ({
        ...(args.pid !== undefined ? { pid: args.pid } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
        force: args.force ?? true,
        tree: args.tree ?? true,
      }),
      buildResult: (outcome) => JSON.parse(outcome.stdout || "{}") as Record<string, unknown>,
    },
  });
}
