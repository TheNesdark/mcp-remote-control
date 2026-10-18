/**
 * agent_ps: consolidated process tool (operation: list | kill).
 * Audits under 'agent_ps_list' / 'agent_ps_kill' as the former separate tools.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PS_SORTS } from "@mrc/shared";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

interface PsListFields {
  operation: "list";
  filter?: string;
  top?: number;
  sort?: "cpu" | "mem" | "pid" | "name";
}

interface PsKillFields {
  operation: "kill";
  pid?: number;
  name?: string;
  force?: boolean;
  tree?: boolean;
}

type PsArgs = { agent: string } & (PsListFields | PsKillFields);

export function registerAgentPs(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<PsArgs>(server, hub, audit, {
    name: "agent_ps",
    title: "List or kill processes on a remote agent",
    description:
      "Process management on a remote machine. operation='list' returns running processes (pid, name, user, " +
      "cpuPercent, memBytes, command), filtered by name/command substring and truncated to the top N by cpu, mem, " +
      "pid or name. operation='kill' terminates a process by pid, or every process whose executable name matches " +
      "(case-insensitive, '.exe' optional); by default the whole process tree is killed forcefully (SIGKILL / " +
      "taskkill /T /F) — use force=false and/or tree=false for a graceful single-process kill. The agent refuses " +
      "to kill itself.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      operation: z.enum(["list", "kill"]).describe("list = inventory processes; kill = terminate by pid or name."),
      filter: z
        .string()
        .optional()
        .describe("(list) Case-insensitive substring match on process name or command line."),
      top: z.number().int().positive().max(5_000).optional().describe("(list) Return at most this many processes (default 100)."),
      sort: z.enum(PS_SORTS).optional().describe("(list) Order before truncating: cpu | mem | pid | name (default cpu)."),
      pid: z.number().int().positive().optional().describe("(kill) Process id to kill (exactly one of pid or name)."),
      name: z
        .string()
        .min(1)
        .optional()
        .describe("(kill) Executable name; every match is killed (e.g. 'notepad' or 'notepad.exe')."),
      force: z.boolean().optional().describe("(kill) SIGKILL / taskkill /F (default true)."),
      tree: z.boolean().optional().describe("(kill) Also kill child processes (default true)."),
    },
    options: {
      op: (args) => (args.operation === "kill" ? "agent_ps_kill" : "agent_ps_list"),
      jobType: (args) => (args.operation === "kill" ? "ps.kill" : "ps.list"),
      validate: (args) =>
        args.operation === "kill" && (args.pid === undefined) === (args.name === undefined)
          ? "operation 'kill': provide exactly one of 'pid' or 'name'"
          : null,
      buildParams: (args) =>
        args.operation === "kill"
          ? {
              ...(args.pid !== undefined ? { pid: args.pid } : {}),
              ...(args.name !== undefined ? { name: args.name } : {}),
              force: args.force ?? true,
              tree: args.tree ?? true,
            }
          : {
              filter: args.filter,
              top: args.top ?? 100,
              sort: args.sort ?? "cpu",
            },
      buildResult: (outcome) => JSON.parse(outcome.stdout || "{}") as Record<string, unknown>,
    },
  });
}
