import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { toolError, toolJson } from "./util.ts";

export function registerAgentPsKill(server: McpServer, hub: Hub, audit: AuditLog): void {
  server.registerTool(
    "agent_ps_kill",
    {
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
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        if ((args.pid === undefined) === (args.name === undefined)) {
          const error = "provide exactly one of 'pid' or 'name'";
          auditToolCall(audit, { op: "agent_ps_kill", agent: args.agent, params: args, startedAt, ok: false, error });
          return toolJson({ ok: false, error }, true);
        }
        const outcome = await hub.request(
          args.agent,
          "ps.kill",
          {
            ...(args.pid !== undefined ? { pid: args.pid } : {}),
            ...(args.name !== undefined ? { name: args.name } : {}),
            force: args.force ?? true,
            tree: args.tree ?? true,
          },
          undefined,
          { op: "agent_ps_kill", params: args },
        );
        if (!outcome.ok) return toolJson({ ok: false, error: outcome.error ?? "ps.kill failed" }, true);
        const parsed = JSON.parse(outcome.stdout || "{}") as Record<string, unknown>;
        return toolJson(parsed);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
