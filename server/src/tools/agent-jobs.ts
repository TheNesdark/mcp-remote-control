import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { toolJson } from "./util.ts";

const JOB_STATES = ["running", "ok", "failed"] as const;

/**
 * Job history tool (operation: status | list | cancel). agent_exec with
 * async=true is the only producer of long-lived entries, but a running
 * synchronous agent_exec shows up too (see Hub.jobList). Audits keep the
 * per-operation names (agent_job_status / agent_job_list / agent_job_cancel)
 * the former separate tools used.
 */
export function registerAgentJobs(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  const record = (call: Parameters<typeof auditToolCall>[1]): void => {
    if (audit) auditToolCall(audit, call);
  };

  server.registerTool(
    "agent_jobs",
    {
      title: "Track or cancel async jobs on remote agents",
      description:
        "Work with jobs started by agent_exec async=true (running synchronous calls show up too). " +
        "operation='status': report the state (running | ok | failed), exit code, duration, stdout/stderr and " +
        "metadata of one job by jobId — output shown for a finished job is capped (history keeps a bounded copy); " +
        "errors when the id is unknown or its history expired. operation='list': list recent jobs, newest first, " +
        "filtered by agent (id or name) and/or state — use it to find a jobId or to check nothing is still running " +
        "before maintenance. operation='cancel': ask the agent to stop a running job (it kills the whole process " +
        "tree; if it does not confirm within a couple of seconds the server marks the job failed. " +
        "cancelRequested=false means the job had already finished).",
      inputSchema: {
        operation: z.enum(["status", "list", "cancel"]).describe("status = one job by id; list = recent jobs; cancel = stop a running job."),
        jobId: z.string().min(1).optional().describe("(status/cancel) jobId returned by agent_exec async=true."),
        agent: z.string().optional().describe("(list) Only jobs of this agent (id or unique name)."),
        state: z.enum(JOB_STATES).optional().describe("(list) Only jobs in this state."),
        limit: z.number().int().positive().max(500).optional().describe("(list) Return at most this many jobs (default 50)."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      const op = `agent_job_${args.operation}`;
      if (args.operation === "status") {
        if (!args.jobId) return toolJson({ ok: false, error: "operation 'status': 'jobId' is required" }, true);
        const status = hub.jobStatus(args.jobId);
        if (!status) {
          const error = `unknown_job: no job '${args.jobId}' (unknown, or its history expired)`;
          record({ op, params: args, startedAt, ok: false, error });
          return toolJson({ ok: false, error }, true);
        }
        record({ op, params: args, startedAt, ok: true });
        return toolJson(status);
      }
      if (args.operation === "list") {
        const jobs = hub.jobList({
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          ...(args.state !== undefined ? { state: args.state } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        record({ op, params: args, startedAt, ok: true });
        return toolJson({ ok: true, count: jobs.length, jobs });
      }
      if (!args.jobId) return toolJson({ ok: false, error: "operation 'cancel': 'jobId' is required" }, true);
      try {
        const result = hub.jobCancel(args.jobId);
        record({ op, params: args, startedAt, ok: true });
        return toolJson(result);
      } catch (err) {
        record({
          op,
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
