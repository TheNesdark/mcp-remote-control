import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ExecParams } from "@mrc/shared";
import type { AuditLog } from "../audit.ts";
import { type Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

const MAX_TIMEOUT_MS = 3_600_000;

interface ExecArgs {
  agent: string;
  command: string;
  shell?: "native" | "cmd" | "powershell";
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export function registerAgentExec(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<ExecArgs>(server, hub, audit, {
    name: "agent_exec",
    title: "Run a command on a remote agent",
    description:
      "Execute a command on a remote machine and wait for it to finish. stdout/stderr are streamed back and returned in the result. " +
      "shell 'native' uses cmd.exe on Windows and sh on POSIX; 'cmd' forces cmd.exe; 'powershell' uses powershell.exe (or pwsh on POSIX). " +
      "If the job times out (or the caller cancels), the whole process tree is killed. Output is capped; for large outputs redirect to a file.",
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
        .describe("Timeout in milliseconds (default: server MRC_JOB_TIMEOUT_MS). On timeout the process tree is killed."),
    },
    options: {
      op: "agent_exec",
      jobType: "exec",
      timeoutMs: (args) => args.timeoutMs,
      buildParams: (args) => {
        const params: Partial<ExecParams> = { command: args.command };
        if (args.shell) params.shell = args.shell;
        if (args.cwd) params.cwd = args.cwd;
        if (args.env) params.env = args.env;
        if (args.stdin !== undefined) params.stdin = args.stdin;
        return params;
      },
      buildResult: (outcome) => ({
        jobId: outcome.jobId,
        ok: outcome.ok,
        exitCode: outcome.exitCode ?? null,
        durationMs: outcome.durationMs,
        truncated: outcome.truncated,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        ...(outcome.error ? { error: outcome.error } : {}),
      }),
      buildFailure: (outcome) => ({
        jobId: outcome.jobId,
        ok: false,
        exitCode: outcome.exitCode ?? null,
        durationMs: outcome.durationMs,
        truncated: outcome.truncated,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        ...(outcome.error ? { error: outcome.error } : {}),
      }),
    },
  });
}
