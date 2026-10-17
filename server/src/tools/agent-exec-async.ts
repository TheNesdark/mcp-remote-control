import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExecParams } from "@mrc/shared";
import type { AuditLog } from "../audit.ts";
import { type Hub } from "../hub.ts";
import { toolError, toolJson } from "./util.ts";

/** Async jobs may legitimately run for a long time; 24 h is the hard cap. */
const MAX_TIMEOUT_MS = 24 * 3_600_000;

interface ExecAsyncArgs {
  agent: string;
  command: string;
  shell?: "native" | "cmd" | "powershell";
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export function registerAgentExecAsync(server: McpServer, hub: Hub, _audit: AuditLog | null = null): void {
  // No tool-level audit here on purpose: the hub writes one entry (op
  // 'agent_exec_async') when the job actually settles, and another one when a
  // routing problem rejects it.
  server.registerTool(
    "agent_exec_async",
    {
      title: "Start a command on a remote agent and return immediately",
      description:
        "Like agent_exec, but returns a jobId as soon as the command is running instead of waiting for it. " +
        "Poll it with agent_job_status (or agent_job_list) and stop it with agent_job_cancel. " +
        "Use this for long work: installs, backups, scans, copies of many files. The job still times out after " +
        "timeoutMs (default server MRC_JOB_TIMEOUT_MS) and its process tree is killed then. " +
        "Only agent_exec_async jobs stay queryable after they finish (bounded history).",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        command: z.string().min(1).describe("Command line to run."),
        shell: z
          .enum(["native", "cmd", "powershell"])
          .optional()
          .describe("Shell to use (default 'native' = cmd.exe on Windows, sh on POSIX)."),
        cwd: z.string().min(1).optional().describe("Working directory on the remote machine."),
        env: z.record(z.string(), z.string()).optional().describe("Extra environment variables."),
        stdin: z.string().optional().describe("Data piped to the command's stdin."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe("Timeout in milliseconds (default: server MRC_JOB_TIMEOUT_MS)."),
      },
    },
    async (args) => {
      const typed = args as ExecAsyncArgs;
      const params: Partial<ExecParams> = { command: typed.command };
      if (typed.shell) params.shell = typed.shell;
      if (typed.cwd) params.cwd = typed.cwd;
      if (typed.env) params.env = typed.env;
      if (typed.stdin !== undefined) params.stdin = typed.stdin;
      try {
        const handle = hub.requestAsync(typed.agent, "exec", params, typed.timeoutMs, {
          op: "agent_exec_async",
          params: typed,
        });
        return toolJson({
          ok: true,
          ...handle,
          state: "running",
          note: "poll with agent_job_status(jobId) or agent_job_list(agent); stop with agent_job_cancel(jobId)",
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
