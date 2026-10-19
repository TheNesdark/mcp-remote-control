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

const windowIdSchema = z.number().int().positive().optional().describe("HWND in decimal, from agent_cua_list_windows.");
const pidSchema = z.number().int().positive().optional().describe("Fallback target: the process's biggest on-screen window.");

/** Args bag every MRC_CUA tool receives; extra keys pass through to the sidecar CLI. */
interface CuaArgsBag {
  agent: string;
  timeoutMs?: number;
  window_id?: number;
  pid?: number;
  confirm?: boolean;
  /** Element-oriented tools (FlaUI criteria). */
  name?: string;
  automation_id?: string;
  class_name?: string;
  control_type?: string;
  nth?: number;
  whole_desktop?: boolean;
  value?: string;
  text?: string;
  keys?: string;
  action?: string;
  x?: number;
  y?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  from_name?: string;
  from_automation_id?: string;
  to_name?: string;
  to_automation_id?: string;
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

  // -- native browser control + screen recording -----------------------------

  registerAgentCuaRecord(server, hub, audit, opts);
  registerAgentCuaBrowser(server, hub, audit);

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

  // -- element-oriented (FlaUI): find/invoke/set_value/wait_for/table_read -----

  const elementCriteria = {
    name: z.string().max(256).optional().describe("Substring of the element name (case-insensitive)."),
    automation_id: z.string().max(256).optional().describe("Substring of the AutomationId."),
    class_name: z.string().max(256).optional().describe("Substring of the window class name."),
    control_type: z.string().max(64).optional().describe("Exact UIA control type (e.g. Button, Edit, DataItem)."),
    nth: z.number().int().min(0).max(50).optional().describe("Which match to use (default 0)."),
    whole_desktop: z.boolean().optional().describe("Search the whole desktop instead of one window."),
  };
  const criteriaError = (args: object): string | null => {
    const a = args as Record<string, unknown>;
    return a.name || a.automation_id || a.class_name || a.control_type
      ? null
      : "provide at least one of name, automation_id, class_name, control_type";
  };

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_find_element",
    title: "Find a UI element and return its rect (CUA engine)",
    description:
      "Locates a control by name / automation id / class name / control type and returns its identity, " +
      "bounds and centre click point. Use it instead of guessing coordinates: the returned click_point feeds " +
      "agent_cua_click directly, and the identity feeds agent_cua_invoke / agent_cua_set_value. Searches one " +
      "window (window_id/pid) or the whole desktop with whole_desktop.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      ...elementCriteria,
      max_results: z.number().int().min(1).max(200).optional().describe("Match cap (default 20)."),
      window_id: windowIdSchema,
      pid: pidSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "find_element",
    validate: criteriaError,
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_invoke",
    title: "Activate a UI element through UIA (CUA engine)",
    description:
      "Activates a control through its UIA pattern (InvokePattern) instead of clicking a point, so it keeps " +
      "working when the window moved or scrolled. Falls back to a real click on the element centre when the " +
      "control exposes no InvokePattern. Selects the element with the same criteria as agent_cua_find_element. " +
      "Requires confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      ...elementCriteria,
      window_id: windowIdSchema,
      pid: pidSchema,
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "invoke",
    validate: (args) => criteriaError(args) ?? (args.confirm ? null : "requires confirm: true"),
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_set_value",
    title: "Write a value into a UI field through UIA (CUA engine)",
    description:
      "Sets the value of a field without stealing focus or clicking it (TextBox.Text, or the generic " +
      "ValuePattern). More reliable than typing character by character. Selects the element with the same " +
      "criteria as agent_cua_find_element. Requires confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      value: z.string().max(4096).describe("Value to write."),
      ...elementCriteria,
      window_id: windowIdSchema,
      pid: pidSchema,
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "set_value",
    validate: (args) => criteriaError(args) ?? (args.confirm ? null : "requires confirm: true"),
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_wait_for",
    title: "Wait for a UI element to appear or disappear (CUA engine)",
    description:
      "Blocks until an element matching the criteria appears (default) or disappears (until_gone: true), " +
      "polling until timeout_ms. Replaces fixed sleeps: wait for the dialog, the row, the 'Ready' label. " +
      "Read-only.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      ...elementCriteria,
      timeout_ms: z.number().int().min(200).max(120_000).optional().describe("Wait budget in ms (default 15000)."),
      until_gone: z.boolean().optional().describe("Wait for the element to disappear instead."),
      poll_ms: z.number().int().min(50).max(5000).optional().describe("Poll interval (default 250)."),
      window_id: windowIdSchema,
      pid: pidSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "wait_for",
    validate: criteriaError,
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_table_read",
    title: "Read a table/grid as rows of cells (CUA engine)",
    description:
      "Reads a grid or list as rows of cell strings. Uses the UIA GridPattern when the app exposes it " +
      "(Excel, most datagrids) and falls back to walking DataItem/ListItem children for ListView-style " +
      "tables. Point it at the table with window_id/pid or narrow it with the element criteria. Read-only.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      ...elementCriteria,
      max_rows: z.number().int().min(1).max(5000).optional().describe("Row cap (default 200)."),
      max_cells: z.number().int().min(1).max(50_000).optional().describe("Cell cap (default 5000)."),
      window_id: windowIdSchema,
      pid: pidSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "table_read",
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_clipboard_set",
    title: "Put text on the clipboard (CUA engine)",
    description:
      "Preloads the clipboard with text so a paste (Ctrl+V) — the most reliable desktop input path — can be " +
      "used instead of typing character by character. Pair with agent_cua_press_key key=ctrl+v. Requires " +
      "confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      text: z.string().max(100_000).describe("Text to place on the clipboard."),
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "clipboard_set",
    validate: (args) => (args.confirm ? null : "requires confirm: true"),
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_clipboard_get",
    title: "Read the clipboard (CUA engine)",
    description:
      "Returns the text currently on the clipboard. This is the extraction path for apps that expose no " +
      "usable UIA tree: select everything and copy inside the app, then read the content here. Read-only.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "clipboard_get",
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_window",
    title: "Control a window by handle (CUA engine)",
    description:
      "Closes, minimizes, maximizes, restores or moves/resizes a window identified by window_id. Useful to " +
      "put windows in a reproducible layout before clicking or recording, and to dismiss windows that expose " +
      "no usable UIA tree. move takes x/y and optional width/height (current size when omitted). Requires " +
      "confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      action: z.enum(["close", "minimize", "maximize", "restore", "move"]).describe("What to do with the window."),
      window_id: z.number().int().positive().describe("HWND in decimal, from agent_cua_list_windows."),
      x: z.number().int().optional().describe("move: target X."),
      y: z.number().int().optional().describe("move: target Y."),
      width: z.number().int().positive().optional().describe("move: width (keeps current when omitted)."),
      height: z.number().int().positive().optional().describe("move: height (keeps current when omitted)."),
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "window",
    validate: (args) => {
      if (!args.confirm) return "requires confirm: true";
      if (args.action === "move" && (args.x === undefined || args.y === undefined)) return "move requires x and y";
      return null;
    },
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_send_hotkey",
    title: "Send a keyboard shortcut in one step (CUA engine)",
    description:
      "Presses an atomic chord such as ctrl+s, alt+f4 or ctrl+shift+t: modifiers are held while the final " +
      "key goes down and released after, which is what menus expect. Optionally focuses a window first with " +
      "window_id/pid. Requires confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      keys: z.string().min(1).max(64).describe("Chord, e.g. \"ctrl+s\" or \"ctrl+shift+t\"."),
      window_id: windowIdSchema,
      pid: pidSchema,
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "send_hotkey",
    validate: (args) => (args.confirm ? null : "requires confirm: true"),
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_drag",
    title: "Drag between two points or elements (CUA engine)",
    description:
      "Presses, moves and releases the mouse between two points - sliders, reordering rows, selecting text, " +
      "dragging files. Each end is either from_x/from_y and to_x/to_y, or an element named by " +
      "from_name/from_automation_id and to_name/to_automation_id, which resolves to that element's centre. " +
      "Requires confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      from_x: z.number().int().optional(),
      from_y: z.number().int().optional(),
      to_x: z.number().int().optional(),
      to_y: z.number().int().optional(),
      from_name: z.string().max(256).optional().describe("Start element name (alternative to from_x/from_y)."),
      from_automation_id: z.string().max(256).optional(),
      to_name: z.string().max(256).optional().describe("End element name (alternative to to_x/to_y)."),
      to_automation_id: z.string().max(256).optional(),
      button: z.enum(["left", "right", "middle"]).optional().describe("Default left."),
      whole_desktop: z.boolean().optional().describe("Resolve element names on the whole desktop."),
      window_id: windowIdSchema,
      pid: pidSchema,
      confirm: confirmSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "drag",
    validate: (args) => {
      if (!args.confirm) return "requires confirm: true";
      const hasFrom = (args.from_x !== undefined && args.from_y !== undefined) || args.from_name || args.from_automation_id;
      const hasTo = (args.to_x !== undefined && args.to_y !== undefined) || args.to_name || args.to_automation_id;
      if (!hasFrom || !hasTo) return "drag requires from_/to_ coordinates or element names at both ends";
      return null;
    },
  });

  registerCuaJobTool(server, hub, audit, {
    name: "agent_cua_element_screenshot",
    title: "Capture a single UI element (CUA engine)",
    description:
      "Captures one control (a panel, a table, a chart) to a PNG/JPEG on the agent and returns its path " +
      "(fetch it with agent_fs_download). Scoped evidence instead of a full-monitor screenshot. Selects the " +
      "element with the same criteria as agent_cua_find_element. Read-only.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      ...elementCriteria,
      format: z.enum(["png", "jpeg"]).optional().describe("Default png."),
      quality: z.number().int().min(1).max(100).optional().describe("JPEG quality (default 85)."),
      window_id: windowIdSchema,
      pid: pidSchema,
      timeoutMs: timeoutSchema,
    },
    sidecarTool: "element_screenshot",
    validate: criteriaError,
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

// --------------------------------------------------------------------- record

/**
 * agent_cua_record: the sidecar captures the primary monitor for a bounded
 * duration and encodes it on the agent (ffmpeg/h264 when present, motion-JPEG
 * AVI otherwise); the hub then pulls the finished file with a chunked,
 * sha256-verified transfer and serves it under /screenshots/ like images.
 */
function registerAgentCuaRecord(
  server: McpServer,
  hub: Hub,
  audit: AuditLog,
  opts: { screenshotDir: string; screenshotBaseUrl?: string },
): void {
  interface Args extends CuaArgsBag {
    duration_sec?: number;
    fps?: number;
    timeoutMs?: number;
    confirm?: boolean;
  }
  const { screenshotDir, screenshotBaseUrl } = opts;

  server.registerTool(
    "agent_cua_record",
    {
      title: "Record a short screen clip via the CUA engine",
      description:
        "Capture the agent's primary monitor for duration_sec seconds (1-60, default 10) at fps frames/s " +
        "(1-10, default 4) and encode it on the agent. MP4/h264 when ffmpeg is available on that machine, " +
        "otherwise a motion-JPEG .avi (playable in VLC; remux with `ffmpeg -i in.avi -c copy out.mp4`). " +
        "This call BLOCKS for the whole clip plus encoding. The hub pulls the finished file with a " +
        "sha256-verified transfer and returns downloadPath. Requires confirm: true (it records the screen).",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        duration_sec: z.number().int().min(1).max(60).optional().describe("Clip length in seconds (default 10)."),
        fps: z.number().int().min(1).max(10).optional().describe("Frames per second (default 4)."),
        confirm: z.boolean().describe("Record the screen: pass true to acknowledge."),
        timeoutMs: z.number().int().positive().max(TIMEOUT_MAX).optional().describe("Sidecar/job timeout in ms."),
      },
    },
    async (raw) => {
      const args = raw as unknown as Args;
      const startedAt = Date.now();
      const auditCall = (ok: boolean, error?: string, extra?: Record<string, unknown>): void => {
        auditToolCall(audit, { op: "agent_cua_record", agent: args.agent, params: args, startedAt, ok, ...extra, error });
      };
      const fail = (error: string) => {
        auditCall(false, error);
        return toolJson({ ok: false, error }, true);
      };
      if (args.confirm !== true) return fail("agent_cua_record requires confirm: true (the clip records the whole screen)");
      try {
        const sidecarArgs: Record<string, number | boolean> = { confirm: true };
        if (args.duration_sec) sidecarArgs.duration_sec = args.duration_sec;
        if (args.fps) sidecarArgs.fps = args.fps;
        // Long clips are captured by the `record` job and encoded by the
        // agent's background poller, so the HTTP stream is never idle long
        // enough for a proxy to cut it (see agent/src/record.ts).
        const outcome = await hub.request(args.agent, "record", sidecarArgs, args.timeoutMs, {
          op: "agent_cua_record",
          params: args,
        });
        if (!outcome.ok) return fail(outcome.error ?? "cua record failed");
        const meta = (outcome.meta ?? {}) as { path?: unknown; encoder?: unknown; frames?: unknown; fps?: unknown };
        const remotePath = typeof meta.path === "string" ? meta.path : "";
        if (!remotePath) return fail("cua record failed: sidecar returned no path");
        const ext = remotePath.toLowerCase().endsWith(".mp4") ? ".mp4" : ".avi";

        await mkdir(screenshotDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const localPath = join(screenshotDir, `rec-${stamp}${ext}`);
        let bytes: Buffer;
        try {
          const transfer = await downloadFile(hub, args.agent, remotePath, localPath, {
            // A long clip can be a few MB per second; give the chunked
            // transfer its own budget, well above the sidecar's.
            timeoutMs: Math.max(args.timeoutMs ?? 0, 150_000),
          });
          bytes = Buffer.from(await Bun.file(localPath).arrayBuffer());
          if (bytes.length !== transfer.bytes) return fail("cua record failed: size mismatch after transfer");
        } catch (err) {
          return fail(`cua record failed: transfer error (${err instanceof Error ? err.message : String(err)})`);
        }

        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const downloadPath = `${SCREENSHOT_HTTP_PREFIX}${basename(localPath)}`;
        const payload = {
          ok: true,
          agent: args.agent,
          localPath,
          bytes: bytes.length,
          sha256,
          encoder: meta.encoder ?? "unknown",
          frames: meta.frames,
          fps: meta.fps,
          duration_sec: args.duration_sec ?? 10,
          downloadPath,
          ...(screenshotBaseUrl ? { downloadUrl: `${screenshotBaseUrl}${downloadPath}` } : {}),
        };
        auditCall(true, undefined, { bytes: bytes.length });
        return toolJson(payload);
      } catch (err) {
        auditCall(false, err instanceof Error ? err.message : String(err));
        return toolError(err);
      }
    },
  );
}

// -------------------------------------------------------------------- browser

/**
 * agent_cua_browser: control of the browser the USER already runs, over the
 * Chrome DevTools Protocol of their real profile (chrome://inspect -> "Allow
 * remote debugging"; the first touch of a tab asks "Allow debugging?" once).
 * Reads use the DOM directly (url, text, tabs); click resolves link/button
 * text inside the page. agent_cua_get_window_state + agent_cua_click remain
 * the fallback for browsers without CDP (Firefox) and non-browser windows.
 */
function registerAgentCuaBrowser(server: McpServer, hub: Hub, audit: AuditLog): void {
  interface Args {
    agent: string;
    operation: "state" | "open" | "navigate" | "text" | "tabs" | "click";
    browser?: "chrome" | "msedge";
    url?: string;
    max_chars?: number;
    match?: string;
    nth?: number;
    target_id?: string;
    confirm?: boolean;
    timeoutMs?: number;
  }
  const MUTATING = new Set(["open", "navigate", "click"]);

  registerJobTool<Args>(server, hub, audit, {
    name: "agent_cua_browser",
    title: "Control the user's live browser (Chrome DevTools Protocol)",
    description:
      "Drives the browser the USER runs (their real profile, tabs and logins) through its DevTools-Protocol " +
      "port: state (url/title/text preview), tabs (list with target_id), text (page innerText), open (new " +
      "tab at url), navigate (current tab to url), click (nth enabled link/button whose text contains " +
      "`match`). One-time setup on the machine: enable chrome://inspect/#remote-debugging once; the first " +
      "touch of each tab shows an 'Allow debugging?' prompt the user accepts once. Firefox is not " +
      "supported - for it use agent_cua_get_window_state + agent_cua_click. open/navigate/click require " +
      "confirm: true.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      operation: z.enum(["state", "open", "navigate", "text", "tabs", "click"]).describe("Browser operation to run."),
      browser: z.enum(["chrome", "msedge"]).optional().describe("Which browser to attach to (default: the one with debugging enabled)."),
      url: z.string().max(2048).optional().describe("http(s) or file:// URL for open/navigate."),
      max_chars: z.number().int().min(200).max(40_000).optional().describe("text: page text cap (default 8000)."),
      match: z.string().min(1).max(120).optional().describe("click: substring of the link/button text."),
      nth: z.number().int().min(0).max(50).optional().describe("click: which match to use (default 0)."),
      target_id: z.string().min(1).max(64).optional().describe("Target id (or prefix) from tabs to drive a specific tab."),
      confirm: z.boolean().optional().describe("Required true for open/navigate/click."),
      timeoutMs: z.number().int().positive().max(TIMEOUT_MAX).optional().describe("Job timeout in ms."),
    },
    options: {
      op: (args) => `agent_cua_browser_${args.operation}`,
      jobType: "browser",
      validate: (args) => {
        if (MUTATING.has(args.operation) && args.confirm !== true) return CONFIRM_HINT;
        if ((args.operation === "navigate" || args.operation === "open") &&
            !/^https?:\/\//i.test(args.url ?? "") && !(args.url ?? "").toLowerCase().startsWith("file://")) {
          return `${args.operation} requires a full http(s):// or file:// url`;
        }
        if (args.operation === "click" && !args.match) return "click requires 'match' (substring of a link/button text)";
        return null;
      },
      timeoutMs: (args) => args.timeoutMs,
      buildParams: (args) => ({
        operation: args.operation,
        ...(args.browser ? { browser: args.browser } : {}),
        ...(args.url ? { url: args.url } : {}),
        ...(args.max_chars ? { max_chars: args.max_chars } : {}),
        ...(args.match ? { match: args.match } : {}),
        ...(args.nth !== undefined ? { nth: args.nth } : {}),
        ...(args.target_id ? { target_id: args.target_id } : {}),
      }),
      buildResult: (outcome) => ({ jobId: outcome.jobId, ...(outcome.meta ?? {}) }),
    },
  });
}

