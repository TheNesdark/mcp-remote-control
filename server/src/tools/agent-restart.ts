import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

interface RestartArgs {
  agent: string;
  updatePath?: string;
  args?: string[];
}

export function registerAgentRestart(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<RestartArgs>(server, hub, audit, {
    name: "agent_restart",
    title: "Restart (and optionally self-update) a remote agent",
    description:
      "Restart the agent process. On Windows the relaunched agent is detached and survives the restart. " +
      "With `updatePath` (a file already on the agent, typically from agent_fs_upload) the running exe is swapped " +
      "for that file before relaunching — use the directory from agent_info's execPath for a compatible path. " +
      "Expect the agent to drop offline for a few seconds and come back with the new binary. " +
      "On non-Windows agents the intent is validated and logged but the supervisor must relaunch the process.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      updatePath: z
        .string()
        .min(1)
        .optional()
        .describe("Path on the agent to a staged new binary; when set, the exe is updated before relaunch."),
      args: z
        .array(z.string().max(4096))
        .max(64)
        .optional()
        .describe("CLI args for the relaunched process (default: the agent's current argv)."),
    },
    options: {
      op: "agent_restart",
      jobType: "restart",
      validate: (args) =>
        args.updatePath !== undefined && !/^[A-Za-z]:[\\/]|^[\\\\/]/.test(args.updatePath)
          ? "updatePath must be an absolute path on the agent"
          : null,
      buildParams: (args) => ({
        ...(args.updatePath !== undefined ? { updatePath: args.updatePath } : {}),
        ...(args.args !== undefined ? { args: args.args } : {}),
      }),
      buildResult: (outcome, args) => ({
        ok: true,
        restartScheduled: true,
        updating: args.updatePath !== undefined,
        execPath: (outcome.meta as { execPath?: string } | undefined)?.execPath ?? null,
        note: "the agent will drop offline and return within seconds",
      }),
    },
  });
}
