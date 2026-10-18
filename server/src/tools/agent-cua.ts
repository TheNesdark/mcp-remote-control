/**
 * agent_cua_*: computer-use tools backed by our own C# engine sidecar
 * (agent/cua/mrc-cua.cs, compiled on the target machine; no external driver).
 *
 * One MCP tool = one `cua` job = one sidecar CLI invocation. The sidecar is
 * stateless: get_window_state returns bounds, click/scroll use absolute
 * screen points, type/press target a window and steal its foreground first.
 *
 * Destructive tools require `confirm: true`; the sidecar enforces the same
 * gate again (defense in depth, it refuses runs without confirm=1).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { SCREENSHOT_EMBED_MAX_BYTES } from "./agent-screenshot.ts";
import { z } from "zod";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { SCREENSHOT_HTTP_PREFIX } from "../screenshots-http.ts";
import { scheduleScreenshotPrune } from "../screenshots-retention.ts";
import { downloadFile } from "../transfers.ts";
import { registerJobTool, type JobToolDef } from "./job-tool.ts";
import { toolError, toolJson } from "./util.ts";

const TIMEOUT_MAX = 115_000;

/** Args bag every MRC_CUA tool receives; extra keys pass through to the sidecar CLI. */
interface CuaArgsBag {
  agent: string;
  timeoutMs?: number;
  window_id?: number;
  pid?: number;
  confirm?: boolean;
}

/** Strip the routing fields: the remaining args go verbatim to the sidecar CLI. */
function cuaArgs(args: object): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (key === "agent" || key === "timeoutMs" || value === undefined || value === null) continue;
    out[key] = value as string | number | boolean;
  }
  return out;
}

function registerCuaJobTool(
  server: McpServer,
  hub: Hub,
  audit: AuditLog,
  def: {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    sidecarTool: string;
    validate?: (args: CuaArgsBag) => string | null;
  },
): void {
  registerJobTool<CuaArgsBag>(server, hub, audit, {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema as JobToolDef<CuaArgsBag>["inputSchema"],
    options: {
      op: def.name,
      jobType: "cua",
      validate: def.validate ? (args) => def.validate?.(args) ?? null : undefined,
      timeoutMs: (args) => args.timeoutMs,
      buildParams: (args) => ({ tool: def.sidecarTool, args: cuaArgs(args) }),
      buildResult: (outcome) => ({
        jobId: outcome.jobId,
        ...(outcome.meta ?? {}),
      }),
    },
  });
}

const CONFIRM_HINT = "Pass confirm: true to acknowledge this tool drives the real mouse/keyboard.";

export function registerAgentCuaTools(
  server: McpServer,
  hub: Hub,
  audit: AuditLog,
  opts: { screenshotDir: string; screenshotBaseUrl?: string },
): void {
  const timeoutSchema = z.number().int().positive().max(TIMEOUT_MAX).optional().describe("Sidecar/job timeout in ms.");
  const windowIdSchema = z.number().int().positive().optional().describe("HWND in decimal, from agent_cua_list_windows.");
  const pidSchema = z.number().int().positive().optional().describe("Fallback target: the process's biggest on-screen window.");
  const confirmSchema = z.boolean().describe(CONFIRM_HINT);
  const targetError = (args: object): string | null => {
    const a = args as { window_id?: number; pid?: number };
    return a.window_id || a.pid ? null : "provide window_id (from agent_cua_list_windows) or pid";
  };

  // -- read-only -----------------------------------------------------------

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_list_windows",
    title: "List on-screen windows via the CUA engine",
    description:
      "Top-level on-screen windows of the agent's desktop, with HWND, pid, process, class, title and screen " +
      "bounds. Pass a window's hwnd to the other agent_cua_* tools.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "list_windows",
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_get_window_state",
    title: "Render a window's accessibility tree (CUA engine)",
    description:
      "ControlView tree of one window: role, name, AutomationId, pid and a screen rect per element. Those " +
      "rects are the coordinates agent_cua_click / agent_cua_scroll expect. With include_screenshot the " +
      "sidecar also saves a PNG of the window and returns its remote path (fetchable with agent_fs_download).",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      window_id: windowIdSchema,
      pid: pidSchema,
      max_elements: z.number().int().min(10).max(300).optional().describe("Element cap (default 80)."),
      include_screenshot: z.boolean().optional().describe("Also capture the window as a PNG."),
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "get_window_state",
    validate: targetError,
  });

  // -- screenshot (sidecar saves a PNG; hub pulls it via chunked transfer) --

  registerAgentCuaScreenshot(server, hub, audit, opts);

  // -- input (destructive, confirm-gated) -----------------------------------

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_click",
    title: "Click the mouse via the CUA engine",
    description:
      "Steal the foreground for the target window, move the cursor to an absolute screen point (see the " +
      "element rects from agent_cua_get_window_state) and press a mouse button. Requires confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      x: z.number().int().describe("Absolute screen X."),
      y: z.number().int().describe("Absolute screen Y."),
      window_id: windowIdSchema,
      pid: pidSchema,
      button: z.enum(["left", "right", "middle"]).optional().describe("Default left."),
      double_click: z.boolean().optional(),
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "click",
    validate: (args) => targetError(args) ?? (args.confirm ? null : "requires confirm: true"),
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_type_text",
    title: "Type text via the CUA engine",
    description:
      "Steal the foreground for the target window and type text through SendInput unicode packets - no " +
      "SendKeys brace syntax, every character goes verbatim. Requires confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      text: z.string().min(1).max(4096).describe("Text to type (typed exactly)."),
      window_id: windowIdSchema,
      pid: pidSchema,
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "type_text",
    validate: (args) => targetError(args) ?? (args.confirm ? null : "requires confirm: true"),
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_press_key",
    title: "Press a key via the CUA engine",
    description:
      "Steal the foreground for the target window and press a key (enter, esc, tab, backspace, space, del, " +
      "home, end, pageup, pagedown, arrows, f1-f12, single letters/digits), optionally with ctrl/shift/alt/win " +
      "modifiers. Requires confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      key: z.string().min(1).max(16).describe("Key name or a single character."),
      modifiers: z.string().max(32).optional().describe("Comma/plus-separated: ctrl, shift, alt, win."),
      window_id: windowIdSchema,
      pid: pidSchema,
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "press_key",
    validate: (args) => targetError(args) ?? (args.confirm ? null : "requires confirm: true"),
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_scroll",
    title: "Scroll the mouse wheel via the CUA engine",
    description:
      "Move the cursor to an absolute screen point and spin the wheel. ticks is the number of wheel notches; " +
      "negative scrolls down. Requires confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      x: z.number().int().describe("Absolute screen X."),
      y: z.number().int().describe("Absolute screen Y."),
      ticks: z.number().int().min(-100).max(100).describe("Wheel notches; negative = down."),
      window_id: windowIdSchema,
      pid: pidSchema,
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "scroll",
    validate: (args) => targetError(args) ?? (args.confirm ? null : "requires confirm: true"),
  });

  // -- focus (no side effects beyond z-order) --------------------------------

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_focus",
    title: "Bring a window to the foreground via the CUA engine",
    description:
      "Force a window to the foreground (AttachThreadInput plus the ALT trick) exactly as every input " +
      "agent_cua_* tool does before sending input. Useful to validate targeting without clicking.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      window_id: windowIdSchema,
      pid: pidSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "focus",
    validate: targetError,
  });
}

/**
 * Screenshot needs a real transfer: the sidecar saves a PNG on the remote disk
 * and the hub pulls it via fs transfer (the same flow the legacy
 * agent_screenshot meta.path results used).
 */
function registerAgentCuaScreenshot(
  server: McpServer,
  hub: Hub,
  audit: AuditLog,
  opts: { screenshotDir: string; screenshotBaseUrl?: string },
): void {
  const { screenshotDir, screenshotBaseUrl } = opts;
  interface Args {
    agent: string;
    window_id?: number;
    pid?: number;
    timeoutMs?: number;
  }
  server.registerTool(
    "agent_cua_screenshot",
    {
      title: "Screenshot via the CUA engine (full screen or one window)",
      description:
        "Capture the agent's primary monitor, or a single window, through the CUA engine sidecar and store it " +
        "under the server's screenshot directory. The remote file is pulled with a chunked, sha256-verified " +
        "transfer - never inlined in hub frames. Over stdio the image is embedded when small enough; over the " +
        "HTTP face fetch it via downloadUrl instead.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        window_id: z.number().int().positive().optional().describe("HWND in decimal to capture; omit for the full screen."),
        pid: z.number().int().positive().optional().describe("Fallback target: the process's biggest on-screen window."),
        timeoutMs: z.number().int().positive().max(TIMEOUT_MAX).optional().describe("Sidecar/job timeout in ms."),
      },
    },
    async (raw) => {
      const args = raw as unknown as Args;
      const startedAt = Date.now();
      const auditCall = (ok: boolean, error?: string, extra?: Record<string, unknown>): void => {
        auditToolCall(audit, { op: "agent_cua_screenshot", agent: args.agent, params: args, startedAt, ok, ...extra, error });
      };
      const fail = (error: string) => {
        auditCall(false, error);
        return toolJson({ ok: false, error }, true);
      };
      try {
        const sidecarArgs: Record<string, number> = {
          ...(args.window_id ? { window_id: args.window_id } : {}),
          ...(args.pid ? { pid: args.pid } : {}),
        };
        const outcome = await hub.request(args.agent, "cua", { tool: "screenshot", args: sidecarArgs }, args.timeoutMs, {
          op: "agent_cua_screenshot",
          params: args,
        });
        if (!outcome.ok) return fail(outcome.error ?? "cua screenshot failed");
        const meta = (outcome.meta ?? {}) as { path?: unknown };
        const remotePath = typeof meta.path === "string" ? meta.path : "";
        if (!remotePath) return fail("cua screenshot failed: sidecar returned no path");

        await mkdir(screenshotDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const localPath = join(screenshotDir, `cua-${stamp}.png`);
        let bytes: Buffer;
        try {
          const transfer = await downloadFile(hub, args.agent, remotePath, localPath, { timeoutMs: args.timeoutMs });
          bytes = Buffer.from(await Bun.file(localPath).arrayBuffer());
          if (bytes.length !== transfer.bytes) return fail("cua screenshot failed: size mismatch after transfer");
        } catch (err) {
          return fail(`cua screenshot failed: transfer error (${err instanceof Error ? err.message : String(err)})`);
        }

        const sha256 = createHash("sha256").update(bytes).digest("hex");
        // Keep the directory bounded: drop everything older than the newest N.
        scheduleScreenshotPrune(screenshotDir, 0);
        const downloadPath = `${SCREENSHOT_HTTP_PREFIX}${basename(localPath)}`;
        const remoteMode = (screenshotBaseUrl ?? "").length > 0;
        const embed = remoteMode ? false : bytes.length <= SCREENSHOT_EMBED_MAX_BYTES;
        const payload = {
          ok: true,
          agent: args.agent,
          format: "png",
          localPath,
          bytes: bytes.length,
          sha256,
          embedded: embed,
          downloadPath,
          ...(screenshotBaseUrl ? { downloadUrl: `${screenshotBaseUrl}${downloadPath}` } : {}),
        };

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        if (embed) content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
        content.push({ type: "text", text: JSON.stringify(payload, null, 2) });
        auditCall(true, undefined, { bytes: bytes.length });
        return { content };
      } catch (err) {
        auditCall(false, err instanceof Error ? err.message : String(err));
        return toolError(err);
      }
    },
  );
}
