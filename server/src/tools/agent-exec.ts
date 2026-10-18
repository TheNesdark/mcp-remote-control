/**
 * agent_exec: one tool, sync and async dispatch.
 *
 * Sync calls wait for the job and return stdout/stderr (op 'agent_exec');
 * async=true returns a jobId immediately (op 'agent_exec_async'). Auditing is
 * left to the hub (it records the job when it settles, for both modes), which
 * matches the pre-consolidation behavior of the two separate tools.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExecParams } from "@mrc/shared";
import type { AuditLog } from "../audit.ts";
import { type Hub } from "../hub.ts";
import { toolError, toolJson } from "./util.ts";

/** Sync calls are capped at 1 h; async jobs may legitimately run for a day. */
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_ASYNC_TIMEOUT_MS = 24 * 3_600_000;

interface ExecArgs {
  agent: string;
  command: string;
  shell?: "native" | "cmd" | "powershell";
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  async?: boolean;
}

function execParams(args: ExecArgs): Partial<ExecParams> {
  const params: Partial<ExecParams> = { command: args.command };
  if (args.shell) params.shell = args.shell;
  if (args.cwd) params.cwd = args.cwd;
  if (args.env) params.env = args.env;
  if (args.stdin !== undefined) params.stdin = args.stdin;
  return params;
}

export function registerAgentExec(server: McpServer, hub: Hub, _audit: AuditLog | null = null): void {
  server.registerTool(
    "agent_exec",
    {
      title: "Run a command on a remote agent",
      description:
        "Execute a command on a remote machine. By default it waits for the command to finish and streams " +
        "stdout/stderr back in the result; with async=true it returns a jobId as soon as the command is running " +
        "instead (track it with agent_jobs 'status'/'list', stop it with agent_jobs 'cancel'; only async jobs stay " +
        "queryable after they finish, in a bounded history). Use async=true for long work: installs, backups, scans, " +
        "bulk copies. shell 'native' uses cmd.exe on Windows and sh on POSIX; 'cmd' forces cmd.exe; 'powershell' uses " +
        "powershell.exe (or pwsh on POSIX). If the job times out (or the caller cancels), the whole process tree is " +
        "killed. Output is capped; for large outputs redirect to a file.",
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
          .max(MAX_ASYNC_TIMEOUT_MS)
          .optional()
          .describe(
            `Timeout in milliseconds (default: server MRC_JOB_TIMEOUT_MS). Sync calls accept up to ${MAX_TIMEOUT_MS}; ` +
              `async jobs up to ${MAX_ASYNC_TIMEOUT_MS}. On timeout the process tree is killed.`,
          ),
        async: z
          .boolean()
          .optional()
          .describe("Return a jobId immediately instead of waiting for completion (default false)."),
      },
    },
    async (args) => {
      const typed = args as ExecArgs;
      const max = typed.async ? MAX_ASYNC_TIMEOUT_MS : MAX_TIMEOUT_MS;
      if (typed.timeoutMs !== undefined && typed.timeoutMs > max) {
        return toolJson(
          { ok: false, error: `timeoutMs ${typed.timeoutMs} exceeds the ${typed.async ? "async" : "sync"} limit of ${max} ms` },
          true,
        );
      }
      if (typed.async) {
        try {
          const handle = hub.requestAsync(typed.agent, "exec", execParams(typed), typed.timeoutMs, {
            op: "agent_exec_async",
            params: typed,
          });
          return toolJson({
            ok: true,
            ...handle,
            state: "running",
            note: "poll with agent_jobs (status/list) or stop with agent_jobs cancel",
          });
        } catch (err) {
          return toolError(err);
        }
      }
      let outcome;
      try {
        outcome = await hub.request(typed.agent, "exec", execParams(typed), typed.timeoutMs, {
          op: "agent_exec",
          params: typed,
        });
      } catch (err) {
        return toolError(err);
      }
      return toolJson({
        jobId: outcome.jobId,
        ok: outcome.ok,
        exitCode: outcome.exitCode ?? null,
        durationMs: outcome.durationMs,
        truncated: outcome.truncated,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    },
  );
}
