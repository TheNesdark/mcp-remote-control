/**
 * registerJobTool: one MCP tool = one hub job, with uniform behavior.
 *
 * Every job tool does the same dance: optional pre-validation, hub.request
 * with audit metadata, failed outcomes as error results, hub errors
 * (offline/paused/busy/rate-limited) as error text.
 *
 * Auditing: hub.request audits the job itself (success, remote failure and
 * routing errors). Only pre-validation failures — which never reach the hub —
 * are audited here.
 *
 * Tools that orchestrate several jobs (upload/download/screenshot) or take
 * no job at all (agents_list) keep their hand-written handlers.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { JobType } from "@mrc/shared";
import { auditToolCall, type AuditLog } from "../audit.ts";
import { type Hub, type JobOutcome } from "../hub.ts";
import { toolError, toolJson } from "./util.ts";

export interface JobToolOptions<TArgs extends { agent: string }> {
  op: string;
  jobType: JobType;
  buildParams: (args: TArgs) => unknown;
  /** Map a successful outcome to the tool payload (may throw -> toolError). */
  buildResult: (outcome: JobOutcome, args: TArgs) => unknown;
  /** Map a failed outcome (ok:false) — default `{ ok: false, error }`. */
  buildFailure?: (outcome: JobOutcome, args: TArgs) => unknown;
  timeoutMs?: (args: TArgs) => number | undefined;
  /** Fail before sending the job; the message is audited and returned. */
  validate?: (args: TArgs) => string | null;
}

export interface JobToolDef<TArgs extends { agent: string }> {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShapeCompat;
  options: JobToolOptions<TArgs>;
}

export function registerJobTool<TArgs extends { agent: string }>(
  server: McpServer,
  hub: Hub,
  audit: AuditLog | null,
  def: JobToolDef<TArgs>,
): void {
  const { op, jobType, buildParams, buildResult, buildFailure, timeoutMs, validate } = def.options;
  server.registerTool(
    def.name,
    { title: def.title, description: def.description, inputSchema: def.inputSchema },
    async (args) => {
      const typed = args as TArgs;
      if (validate) {
        const error = validate(typed);
        if (error) {
          if (audit) {
            auditToolCall(audit, { op, agent: typed.agent, params: typed, startedAt: Date.now(), ok: false, error });
          }
          return toolJson({ ok: false, error }, true);
        }
      }
      let outcome: JobOutcome;
      try {
        outcome = await hub.request(typed.agent, jobType, buildParams(typed), timeoutMs?.(typed), {
          op,
          params: typed,
        });
      } catch (err) {
        return toolError(err);
      }
      if (!outcome.ok) {
        const payload = buildFailure?.(outcome, typed) ?? { ok: false, error: outcome.error ?? `${jobType} failed` };
        return toolJson(payload, true);
      }
      try {
        return toolJson(buildResult(outcome, typed));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
