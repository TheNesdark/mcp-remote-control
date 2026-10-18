/**
 * Cua Driver tools: every MCP tool the driver exposes (see
 * shared/cua-tools.ts, generated from its `dump-docs`) is registered as
 * `agent_cua_<name>` and runs as a `cua` job call on the target agent.
 *
 * The agent is a dumb, audited pipe (`cua-driver call <tool>` with the JSON
 * on stdin); all semantics stay here:
 *  - `session` defaults to "mrc" so element_token/snapshot state survives
 *    across separate MCP calls (one-shot CLI calls share nothing otherwise);
 *  - driver-flagged `destructive` tools require confirm=true, our house rule;
 *  - `screenshot:true` captures the driver's image block, saves it under the
 *    screenshot directory and returns path/downloadUrl instead of a base64
 *    blob in the tool result (same policy that fixed agent_screenshot over
 *    SSE);
 *  - stdout passes through as text; it is the driver's own JSON/markdown.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { downloadFile } from "../transfers.ts";
import { CUA_DRIVER_VERSION } from "@mrc/shared/cua-version";
import { CUA_TOOLS, CUA_TOOLS_SOURCE_VERSION } from "@mrc/shared/cua-tools";
import { z } from "zod";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub, JobOutcome } from "../hub.ts";
import { scheduleScreenshotPrune } from "../screenshots-retention.ts";
import { SCREENSHOT_HTTP_PREFIX } from "../screenshots-http.ts";

import { toolError, toolJson } from "./util.ts";

/** Shared session label so element tokens keep working between calls. */
export const CUA_DEFAULT_SESSION = "mrc";

/** Driver tools whose response carries a PNG in the image content block. */
export const CUA_IMAGE_TOOLS = new Set([
  "get_window_state",
  "get_desktop_state",
  "zoom",
  "get_browser_state",
  "verify_state",
  "parse_visual_regions",
]);

/** Generous for tree walks and captures; the CLI itself caps calls at 120s. */
export const CUA_JOB_TIMEOUT_MS = 60_000;
/** Output cap for cua jobs: driver trees plus embedded base64 images are big. */
export const CUA_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface CuaToolsOptions {
  audit: AuditLog | null;
  /** Where `screenshot:true` results are saved (reused screenshot dir). */
  screenshotDir: string;
  /** Newest screenshots to keep on disk (0 = keep everything). */
  screenshotKeep?: number;
  /** Base URL for downloadUrl (empty = relative path only). */
  screenshotBaseUrl?: string;
}

/** Compact parameter summary embedded in each tool's description. */
function describeParams(inputSchema: Record<string, unknown>): string {
  const props = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((inputSchema.required ?? []) as string[]);
  const parts = Object.entries(props).map(([key, def]) => {
    const type = String(def.type ?? "any");
    return required.has(key) ? `${key}:${type}*` : `${key}:${type}`;
  });
  return parts.length ? parts.join(", ") : "(no arguments)";
}

interface CuaCallArgs {
  agent: string;
  params?: Record<string, unknown>;
  confirm?: boolean;
  timeoutMs?: number;
}

export function registerCuaTools(server: McpServer, hub: Hub, options: CuaToolsOptions): void {
  const { audit, screenshotDir, screenshotKeep, screenshotBaseUrl } = options;

  for (const spec of CUA_TOOLS) {
    const toolName = `agent_cua_${spec.name}`;
    const description =
      `${spec.description}\n\n` +
      `Cua Driver ${CUA_TOOLS_SOURCE_VERSION} tool "${spec.name}"${spec.destructive ? " — DESTRUCTIVE: confirm=true required" : spec.readOnly ? " — read-only" : ""}. ` +
      `params fields (* = required): ${describeParams(spec.inputSchema)}. ` +
      `The 'session' field defaults to "${CUA_DEFAULT_SESSION}": pass an explicit one only to isolate parallel work. ` +
      `State machine: get_window_state first, then act with element_token from that snapshot (stale tokens fail with stale_element_token).`;

    server.registerTool(
      toolName,
      {
        title: `Cua: ${spec.name}`,
        description,
        inputSchema: {
          agent: z.string().min(1).describe("Agent id or unique name from agents_list (needs the 'cua' capability)."),
          params: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(`Tool input JSON (fields: ${describeParams(spec.inputSchema)}).`),
          ...(spec.destructive
            ? { confirm: z.boolean().optional().describe("Must be true: the driver flags this tool as destructive.") }
            : {}),
          timeoutMs: z.number().int().positive().max(115_000).optional().describe("Job timeout in milliseconds (default 60s)."),
        },
      },
      async (args) => {
        const typed = args as CuaCallArgs;
        const startedAt = Date.now();
        const record = (ok: boolean, error?: string): void => {
          if (audit) {
            auditToolCall(audit, {
              op: toolName,
              agent: typed.agent,
              params: { params: typed.params ?? {} },
              startedAt,
              ok,
              ...(error ? { error } : {}),
            });
          }
        };
        const gate = cuaGate(hub)(typed);
        if (gate) {
          record(false, gate);
          return toolJson({ ok: false, error: gate }, true);
        }
        if (spec.destructive && typed.confirm !== true) {
          const error = `agent_cua_${spec.name} is destructive (driver flag); pass confirm=true`;
          record(false, error);
          return toolJson({ ok: false, error }, true);
        }
        const wantScreenshot =
          typed.params?.screenshot !== false && CUA_IMAGE_TOOLS.has(spec.name);
        const params = { session: CUA_DEFAULT_SESSION, ...(typed.params ?? {}) };
        let outcome: JobOutcome;
        try {
          outcome = await hub.request(
            typed.agent,
            "cua",
            { action: "call", tool: spec.name, args: params, ...(wantScreenshot ? { screenshot: true } : {}) },
            typed.timeoutMs ?? CUA_JOB_TIMEOUT_MS,
            { op: toolName, params: { tool: spec.name, args: params } },
            { maxOutputBytes: CUA_MAX_OUTPUT_BYTES },
          );
        } catch (err) {
          record(false, err instanceof Error ? err.message : String(err));
          return toolError(err);
        }
        const meta = (outcome.meta ?? {}) as Record<string, unknown>;
        if (!outcome.ok || meta.ok === false) {
          const error =
            typeof meta.error === "string" && meta.error
              ? meta.error
              : (meta.stderr as string) || outcome.error || `${spec.name} failed`;
          record(false, error);
          return toolJson({ ok: false, error, exitCode: meta.exitCode ?? null, stdout: meta.stdout ?? null }, true);
        }
        record(true);
        return toolJson({ ok: true, tool: spec.name, exitCode: meta.exitCode ?? 0, stdout: meta.stdout ?? "" });
      },
    );
  }

  // ---- companion tools: provisioning + status + raw passthrough ----

  server.registerTool(
    "agent_cua_setup",
    {
      title: "Install or update the Cua Driver on a remote agent",
      description:
        `Provision Cua Driver ${CUA_DRIVER_VERSION} (or the version the hub publishes) on the agent: download from ` +
        "the hub, verify the sha256, unpack under %LOCALAPPDATA%\\mcp-remote-control\\cua and enable the driver " +
        "autostart daemon. Agents do this automatically on connect; call it to retry after a Defender quarantine or " +
        "to force a re-install. Windows only.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const outcome = await hub.request(args.agent, "cua", { action: "setup" }, 180_000, {
          op: "agent_cua_setup",
          params: args,
        });
        const meta = (outcome.meta ?? {}) as Record<string, unknown>;
        const ok = outcome.ok && meta.ok !== false;
        if (audit) {
          auditToolCall(audit, {
            op: "agent_cua_setup",
            agent: args.agent,
            params: args,
            startedAt,
            ok,
            ...(ok ? {} : { error: String(meta.error ?? outcome.error ?? "setup failed") }),
          });
        }
        return toolJson({ ok, ...meta }, !ok);
      } catch (err) {
        if (audit) {
          auditToolCall(audit, {
            op: "agent_cua_setup",
            agent: args.agent,
            params: args,
            startedAt,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "agent_cua_status",
    {
      title: "Cua Driver install and daemon status of a remote agent",
      description:
        "Report whether Cua Driver is installed on the agent (version, directory, one-line daemon status) and " +
        "which version the hub announced. Read this before any agent_cua_* tool if calls fail; the fix for a " +
        "missing install is agent_cua_setup.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const outcome = await hub.request(args.agent, "cua", { action: "status" }, 20_000, {
          op: "agent_cua_status",
          params: args,
        });
        if (audit) auditToolCall(audit, { op: "agent_cua_status", agent: args.agent, params: args, startedAt, ok: outcome.ok });
        if (!outcome.ok) return toolJson({ ok: false, error: outcome.error ?? "status failed" }, true);
        return toolJson({ ok: true, ...(outcome.meta as Record<string, unknown>) });
      } catch (err) {
        if (audit) {
          auditToolCall(audit, {
            op: "agent_cua_status",
            agent: args.agent,
            params: args,
            startedAt,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "agent_cua_call",
    {
      title: "Call any Cua Driver tool generically",
      description:
        "Escape hatch to invoke any driver tool by name (see agent_cua_status for the installed version). Prefer " +
        "the dedicated agent_cua_<name> tools: they carry the schema and the destructive-confirm rule. 'session' is " +
        `defaulted to "${CUA_DEFAULT_SESSION}" here too. The 'screenshot' option captures the driver's image block ` +
        "and returns a saved path + downloadUrl instead of inline base64.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list (needs the 'cua' capability)."),
        tool: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/).describe("Driver tool name, e.g. 'list_windows'."),
        params: z.record(z.string(), z.unknown()).optional().describe("Tool input JSON."),
        screenshot: z.boolean().optional().describe("Save the response's image to the server and return path/downloadUrl."),
        timeoutMs: z.number().int().positive().max(115_000).optional().describe("Job timeout in milliseconds (default 60s)."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      const gate = cuaGate(hub)(args);
      if (gate) {
        if (audit) auditToolCall(audit, { op: "agent_cua_call", agent: args.agent, params: { tool: args.tool }, startedAt, ok: false, error: gate });
        return toolJson({ ok: false, error: gate }, true);
      }
      const params = { session: CUA_DEFAULT_SESSION, ...(args.params ?? {}) };
      const known = CUA_TOOLS.find((tool) => (tool as { name: string }).name === args.tool);
      try {
        const outcome = await hub.request(
          args.agent,
          "cua",
          { action: "call", tool: args.tool, args: params, ...(args.screenshot ? { screenshot: true } : {}) },
          args.timeoutMs ?? CUA_JOB_TIMEOUT_MS,
          { op: "agent_cua_call", params: { tool: args.tool, args: params } },
          { maxOutputBytes: CUA_MAX_OUTPUT_BYTES },
        );
        const meta = (outcome.meta ?? {}) as Record<string, unknown>;
        if (!outcome.ok || meta.ok === false) {
          const error = typeof meta.error === "string" && meta.error ? meta.error : (meta.stderr as string) || outcome.error || "call failed";
          if (audit) auditToolCall(audit, { op: "agent_cua_call", agent: args.agent, params: { tool: args.tool }, startedAt, ok: false, error });
          return toolJson({ ok: false, error, exitCode: meta.exitCode ?? null, stdout: meta.stdout ?? null }, true);
        }
        const payload: Record<string, unknown> = {
          ok: true,
          tool: args.tool,
          exitCode: meta.exitCode ?? 0,
          ...(known?.destructive ? { note: "driver-flagged destructive tool" } : {}),
        };
        // Persist an image if asked: same local path + downloadUrl contract as
        // the old screenshot flow, so a remote opencode can curl it.
        // Agent may report the image either as a remote path (new, chunked
        // transfer) or as base64 in meta (legacy 0.8.0 agents and direct calls).
        const remotePath = typeof meta.screenshotPath === "string" ? meta.screenshotPath : null;
        const inlineBase64 = typeof meta.screenshotBase64 === "string" ? meta.screenshotBase64 : null;
        if (args.screenshot && (remotePath || inlineBase64)) {
          await mkdir(screenshotDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
          const localPath = join(screenshotDir, `cua-${args.tool}-${stamp}.png`);
          try {
            let bytes: Buffer;
            if (remotePath) {
              const transfer = await downloadFile(hub, args.agent, remotePath, localPath, { timeoutMs: args.timeoutMs ?? CUA_JOB_TIMEOUT_MS });
              bytes = Buffer.from(await Bun.file(localPath).arrayBuffer());
              if (bytes.length !== transfer.bytes) throw new Error("screenshot size mismatch after transfer");
            } else {
              bytes = Buffer.from(inlineBase64!, "base64");
              await Bun.write(localPath, bytes);
            }
            const sha = createHash("sha256").update(bytes).digest("hex");
            scheduleScreenshotPrune(screenshotDir, screenshotKeep ?? 0);
            payload.screenshotPath = localPath;
            payload.screenshotBytes = bytes.length;
            payload.screenshotSha256 = sha;
            const downloadPath = `${SCREENSHOT_HTTP_PREFIX}${basename(localPath)}`;
            payload.screenshotDownloadPath = downloadPath;
            if (screenshotBaseUrl) payload.screenshotDownloadUrl = `${screenshotBaseUrl}${downloadPath}`;
          } catch (err) {
            payload.screenshotError = err instanceof Error ? err.message : String(err);
          }
        }
        payload.stdout = meta.stdout ?? "";
        if (audit) auditToolCall(audit, { op: "agent_cua_call", agent: args.agent, params: { tool: args.tool }, startedAt, ok: true });
        return toolJson(payload);
      } catch (err) {
        if (audit) {
          auditToolCall(audit, {
            op: "agent_cua_call",
            agent: args.agent,
            params: { tool: args.tool },
            startedAt,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return toolError(err);
      }
    },
  );
}

/** Capability an agent must publish (hello/caps) for the cua tools to apply. */
export const CUA_CAPABILITY = "cua";

/**
 * validate builder for the 64 call tools: the agent must publish `cua`.
 * Unknown/offline agents pass through (the hub produces its own routing error).
 */
export function cuaGate(hub: Hub): (args: { agent: string }) => string | null {
  return (args) => {
    let record;
    try {
      record = hub.resolve(args.agent);
    } catch {
      return null;
    }
    if (!record.online) return null;
    return record.caps.includes(CUA_CAPABILITY)
      ? null
      : `agent '${args.agent}' has no 'cua' capability (Cua Driver missing or provisioning failed); call agent_cua_status then agent_cua_setup`;
  };
}
