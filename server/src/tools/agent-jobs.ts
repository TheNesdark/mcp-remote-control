import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { toolJson } from "./util.ts";

const JOB_STATES = ["running", "ok", "failed"] as const;

/**
 * Job history tools. agent_exec_async is the only producer of long-lived
 * entries, but a running agent_exec shows up too (see Hub.jobList).
 */
export function registerAgentJobs(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  const record = (call: Parameters<typeof auditToolCall>[1]): void => {
    if (audit) auditToolCall(audit, call);
  };

  server.registerTool(
    "agent_job_status",
    {
      title: "Check the status of an async job",
      description:
        "Report the state (running | ok | failed), exit code, duration, stdout/stderr and metadata of a job started " +
        "with agent_exec_async. Output shown for a finished job is capped (the job history keeps a bounded copy). " +
        "Returns an error when the job id is unknown or its history already expired.",
      inputSchema: {
        jobId: z.string().min(1).describe("jobId returned by agent_exec_async."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      const status = hub.jobStatus(args.jobId);
      if (!status) {
        const error = `unknown_job: no job '${args.jobId}' (unknown, or its history expired)`;
        record({ op: "agent_job_status", params: args, startedAt, ok: false, error });
        return toolJson({ ok: false, error }, true);
      }
      record({ op: "agent_job_status", params: args, startedAt, ok: true });
      return toolJson(status);
    },
  );

  server.registerTool(
    "agent_job_list",
    {
      title: "List async jobs",
      description:
        "List recent jobs, newest first: every running job plus the retained history of agent_exec_async jobs. " +
        "Filter by agent (id or name) and/or state (running | ok | failed). Use it to find a job id or to check " +
        "that nothing is still running before a maintenance window.",
      inputSchema: {
        agent: z.string().optional().describe("Only jobs of this agent (id or unique name)."),
        state: z.enum(JOB_STATES).optional().describe("Only jobs in this state."),
        limit: z.number().int().positive().max(500).optional().describe("Return at most this many jobs (default 50)."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      const jobs = hub.jobList({
        ...(args.agent !== undefined ? { agent: args.agent } : {}),
        ...(args.state !== undefined ? { state: args.state } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      record({ op: "agent_job_list", params: args, startedAt, ok: true });
      return toolJson({ ok: true, count: jobs.length, jobs });
    },
  );

  server.registerTool(
    "agent_job_cancel",
    {
      title: "Cancel a running job",
      description:
        "Ask the agent to stop a running job (agent_exec_async, or a synchronous agent_exec in flight) and return its " +
        "state. The agent kills the whole process tree; if it does not confirm within a couple of seconds the server " +
        "gives up on it and marks the job failed. `cancelRequested: false` means the job had already finished.",
      inputSchema: {
        jobId: z.string().min(1).describe("jobId to cancel."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const result = hub.jobCancel(args.jobId);
        record({ op: "agent_job_cancel", params: args, startedAt, ok: true });
        return toolJson(result);
      } catch (err) {
        record({
          op: "agent_job_cancel",
          params: args,
          startedAt,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return toolJson({ ok: false, error: err instanceof Error ? err.message : String(err) }, true);
      }
    },
  );
}
