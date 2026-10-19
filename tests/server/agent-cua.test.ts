/**
 * Tests for the agent_cua_* tool batch (server/src/tools/agent-cua.ts).
 *
 * A fake Windows agent answers `cua` jobs with canned sidecar JSON (meta), and
 * the screenshot tool additionally answers the `fs.read` transfer it triggers.
 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JobRequestMsg } from "@mrc/shared";
import { FakeAgent, type FakeResponse } from "../../scripts/fake-agent.ts";
import { testServerConfig } from "../../scripts/test-utils.ts";
import { createMcpHttpHandler } from "../../server/src/mcp-http.ts";
import { createService, type Service } from "../../server/src/service.ts";

const TOKEN = "test-token";

interface ToolCall {
  isError: boolean;
  data: any;
  text: string;
}

interface Harness {
  service: Service;
  agent: FakeAgent;
  client: Client;
  /** Every (jobType, params) job the fake agent received, in order. */
  jobs: Array<{ jobType: string; params: unknown }>;
  screenshotDir: string;
}

let harness: Harness | null = null;
let httpServer: Bun.Server<unknown> | null = null;

afterEach(async () => {
  if (harness) {
    try {
      await harness.client.close();
    } catch {
      // already closed
    }
    harness.agent.stop();
    harness.service.close();
    await rmSync(harness.screenshotDir, { recursive: true, force: true });
    harness = null;
  }
  if (httpServer) {
    await httpServer.stop(true);
    httpServer = null;
  }
});

const WINDOWS = [{ hwnd: 101, pid: 20, process: "notepad", class: "Notepad", title: "Sin título", visible: true, bounds: { x: 10, y: 20, width: 800, height: 600 } }];
const TREE = { ok: true, hwnd: 101, pid: 20, title: "Sin título", class: "Notepad", element_count: 4, tree: "- [Window] id=...,(Editor) pid=20 screen(10,20 800x600)" };

function sidecarMeta(msg: JobRequestMsg): Record<string, unknown> {
  const params = (msg.params ?? {}) as { tool?: string };
  switch (params.tool) {
    case "list_windows":
      return { windows: WINDOWS };
    case "get_window_state":
      return TREE;
    case "click":
      return { clicked: { x: 40, y: 50, button: "left" } };
    case "type_text":
      return { typed_chars: 5 };
    case "press_key":
      return { key: "enter" };
    case "scroll":
      return { scrolled: { x: 40, y: 50, delta: -240 } };
    case "focus":
      return { focused_hwnd: 101 };
    case "find_element":
      return {
        matches: 2,
        element: {
          name: "Guardar", automation_id: "btnSave", class_name: "Button", control_type: "Button",
          enabled: true, offscreen: false, pid: 20, bounds: { x: 40, y: 50, width: 80, height: 24 },
        },
        click_point: { x: 80, y: 62 },
      };
    case "invoke":
      return { via: "invoke", element: { name: "Guardar", control_type: "Button", bounds: { x: 40, y: 50, width: 80, height: 24 } } };
    case "set_value":
      return { via: "textbox", chars: 9 };
    case "wait_for":
      return { present: true, waited_ms: 420, element: { name: "Guardar", control_type: "Button" } };
    case "table_read":
      return {
        via: "grid-pattern", row_count: 3, column_count: 2, returned_rows: 2, truncated: true,
        rows: [["Cabecera A", "Cabecera B"], ["dato 1", "dato 2"]],
      };
    case "clipboard_set":
      return { chars: 12 };
    case "clipboard_get":
      return { has_text: true, chars: 21, text: "FACT-2026-0001  |  1250.00" };
    case "window":
      return { action: "maximize", hwnd: 101 };
    case "send_hotkey":
      return { keys: "ctrl+s" };
    case "drag":
      return { from: { x: 10, y: 20 }, to: { x: 300, y: 400 }, button: "left" };
    case "element_screenshot":
      return { path: "C:\\Users\\SERVER-RX\\AppData\\Local\\Temp\\mrc-cua-elem.png", bytes: 4096, format: "png", bounds: { x: 1, y: 2, width: 30, height: 40 } };
    case "screenshot":
      return { path: "C:\\Users\\SERVER-RX\\AppData\\Local\\Temp\\mrc-cua-shot.png", bytes: FAKE_PNG.length };
    case "record":
      return {
        path: "C:\\Users\\SERVER-RX\\AppData\\Local\\Temp\\mrc-cua-rec.avi", bytes: FAKE_PNG.length,
        frames: 8, fps: 4, duration_sec: 2, encoder: "mjpeg-avi",
      };
    default:
      return { unexpectedTool: params.tool };
  }
}

/** Canned CDP results for `browser` jobs (agent/src/browser-cdp.ts on Windows). */
function browserMeta(msg: JobRequestMsg): Record<string, unknown> {
  const params = (msg.params ?? {}) as { operation?: string };
  switch (params.operation) {
    case "state":
      return {
        browser: "chrome", target_id: "A1B2", url: "https://example.com/", page_title: "Example Domain",
        ready: "complete", text_head: "Example Domain This domain is for use in",
      };
    case "open":
      return { browser: "chrome", target_id: "A1B2", url: "https://example.com/", first_access_prompt: false };
    case "navigate":
      return { browser: "chrome", target_id: "A1B2", navigated: true, url: "https://example.com/" };
    case "text":
      return { browser: "chrome", target_id: "A1B2", url: "https://example.com/", title: "Example Domain", truncated: false, text: "Example Domain" };
    case "tabs":
      return { browser: "chrome", tab_count: 1, tabs: [{ target_id: "A1B2", title: "Example Domain", url: "https://example.com/" }] };
    case "click":
      return { browser: "chrome", target_id: "A1B2", clicked: { x: 10, y: 20, w: 100, h: 20 }, tag: "a", text: "More information...", matches: 1, via: "dom" };
    case "search":
      return { browser: "chrome", target_id: "A1B2", query: "test", typed: 4, submitted: "keydown", input_name: "search_query", url: "https://example.com/results?search_query=test" };
    default:
      return { unexpectedOperation: params.operation };
  }
}

/** Canned results for `record` jobs (agent/src/record.ts on Windows). */
function recordMeta(msg: JobRequestMsg): Record<string, unknown> {
  const params = (msg.params ?? {}) as { duration_sec?: number; fps?: number };
  const duration = params.duration_sec ?? 10;
  const fps = params.fps ?? 4;
  const frames = duration * fps;
  // Long clips are encoded in the background and come back as ffmpeg/h264.
  if (duration > 15) {
    return {
      path: "C:\\Users\\SERVER-RX\\AppData\\Local\\Temp\\mrc-cua-rec.mp4", bytes: FAKE_PNG.length,
      frames, fps, duration_sec: duration, encoder: "ffmpeg/h264",
    };
  }
  return {
    path: "C:\\Users\\SERVER-RX\\AppData\\Local\\Temp\\mrc-cua-rec.avi", bytes: FAKE_PNG.length,
    frames, fps, duration_sec: duration, encoder: "mjpeg-avi",
  };
}

const FAKE_PNG = Buffer.from("mrc-cua-fake-png-bytes");
const FAKE_PNG_SHA = createHash("sha256").update(FAKE_PNG).digest("hex");

function respond(msg: JobRequestMsg): FakeResponse {
  if (msg.jobType === "fs.read") {
    return { stdout: FAKE_PNG.toString("base64"), meta: { eof: true, size: FAKE_PNG.length, sha256: FAKE_PNG_SHA } };
  }
  if (msg.jobType === "cua") return { meta: sidecarMeta(msg) };
  if (msg.jobType === "browser") return { meta: browserMeta(msg) };
  if (msg.jobType === "record") return { meta: recordMeta(msg) };
  return { ok: false, error: `unexpected job ${msg.jobType}` };
}

async function start(): Promise<Harness> {
  const service = createService(testServerConfig(TOKEN));
  const screenshotDir = await mkdtempSync(join(tmpdir(), "mrc-cua-shots-"));
  const jobs: Harness["jobs"] = [];
  const agent = new FakeAgent({
    url: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "W-CUA-01",
    os: "Windows_NT 10.0.19045",
    onLog: () => {},
    respond: (msg) => {
      jobs.push({ jobType: msg.jobType, params: msg.params });
      return respond(msg);
    },
  });
  await agent.start();

  const handler = createMcpHttpHandler(service.hub, {
    version: "test",
    screenshotDir,
    audit: service.audit,
    bearerToken: TOKEN,
  });
  httpServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({ name: "cua-tools-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  harness = { service, agent, client, jobs, screenshotDir };
  return harness;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolCall> {
  if (!harness) throw new Error("harness not started");
  const result = await harness.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // plain-text transport error: keep `text` only
  }
  return { isError: result.isError === true, data, text };
}

test("the agent_cua_* tools are registered", async () => {
  const started = await start();
  const tools = (await started.client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "agent_cua_list_windows",
    "agent_cua_get_window_state",
    "agent_cua_screenshot",
    "agent_cua_click",
    "agent_cua_type_text",
    "agent_cua_press_key",
    "agent_cua_scroll",
    "agent_cua_focus",
  ]) {
    expect(tools).toContain(name);
  }
});

test("agent_cua_list_windows routes one cua job and returns the window list", async () => {
  const started = await start();
  const result = await call("agent_cua_list_windows", { agent: "W-CUA-01" });
  expect(result.isError).toBe(false);
  expect(result.data.windows[0]).toMatchObject({ hwnd: 101, process: "notepad", title: "Sin título" });
  expect(started.jobs.length).toBe(1);
  expect(started.jobs[0]).toMatchObject({ jobType: "cua", params: { tool: "list_windows" } });
});

test("agent_cua_get_window_state requires a target", async () => {
  const started = await start();
  const result = await call("agent_cua_get_window_state", { agent: "W-CUA-01" });
  expect(result.isError).toBe(true);
  expect(result.data.error).toContain("window_id");
  expect(started.jobs.length).toBe(0);
});

test("agent_cua_get_window_state forwards tree requests to the sidecar", async () => {
  const started = await start();
  const result = await call("agent_cua_get_window_state", { agent: "W-CUA-01", window_id: 101, max_elements: 120 });
  expect(result.isError).toBe(false);
  expect(result.data.element_count).toBe(4);
  expect(started.jobs[0]).toMatchObject({ params: { tool: "get_window_state", args: { window_id: 101, max_elements: 120 } } });
});

test("destructive agent_cua_* tools require confirm", async () => {
  const started = await start();
  for (const batch of [
    { name: "agent_cua_click", args: { x: 40, y: 50, window_id: 101 } },
    { name: "agent_cua_type_text", args: { text: "hola", window_id: 101 } },
    { name: "agent_cua_press_key", args: { key: "enter", window_id: 101 } },
    { name: "agent_cua_scroll", args: { x: 40, y: 50, ticks: -2, window_id: 101 } },
  ]) {
    const result = await call(batch.name, { agent: "W-CUA-01", ...batch.args });
    expect(result.isError).toBe(true);
    // Schema-level validation failures surface as plain text MCP errors.
    expect(result.data === null || result.data?.error?.includes?.("confirm")).toBe(true);
    expect(result.text).toMatch(/confirm/i);
  }
  expect(started.jobs.length).toBe(0);
});

test("agent_cua_click with confirm drives the sidecar and keeps routing fields out of args", async () => {
  const started = await start();
  const result = await call("agent_cua_click", {
    agent: "W-CUA-01",
    x: 40,
    y: 50,
    window_id: 101,
    confirm: true,
    timeoutMs: 5_000,
  });
  expect(result.isError).toBe(false);
  expect(result.data.clicked).toEqual({ x: 40, y: 50, button: "left" });
  expect(started.jobs.length).toBe(1);
  const params = (started.jobs[0]?.params ?? {}) as { tool: string; args: Record<string, unknown> };
  expect(params.tool).toBe("click");
  expect(params.args).toMatchObject({ x: 40, y: 50, window_id: 101, confirm: true });
  expect(params.args).not.toHaveProperty("agent");
  expect(params.args).not.toHaveProperty("timeoutMs");
});

test("agent_cua_screenshot pulls the remote PNG into the screenshot dir", async () => {
  const started = await start();
  const result = await call("agent_cua_screenshot", { agent: "W-CUA-01" });
  expect(result.isError).toBe(false);
  expect(result.data.embedded).toBe(true);
  expect(result.data.sha256).toBe(FAKE_PNG_SHA);
  expect(result.data.localPath.startsWith(started.screenshotDir)).toBe(true);
  expect(existsSync(result.data.localPath)).toBe(true);
  expect(result.data.downloadPath).toContain("/screenshots/");
  const jobsReported = started.jobs.filter((job) => job.jobType === "cua");
  expect(jobsReported).toHaveLength(1);
  expect(jobsReported[0]).toMatchObject({ params: { tool: "screenshot" } });
});

test("agent_cua_screenshot fails cleanly when the sidecar has no path", async () => {
  const service = createService(testServerConfig(TOKEN));
  const agent = new FakeAgent({
    url: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "W-CUA-02",
    os: "Windows_NT 10.0.19045",
    onLog: () => {},
    respond: () => ({ meta: {} }),
  });
  await agent.start();
  httpServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createMcpHttpHandler(service.hub, {
    version: "test",
    screenshotDir: await mkdtempSync(join(tmpdir(), "mrc-cua-shots-")),
    audit: service.audit,
    bearerToken: TOKEN,
  }) });
  const client = new Client({ name: "cua-tools-test-2", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  }));
  const result = await client.callTool({ name: "agent_cua_screenshot", arguments: { agent: "W-CUA-02" } });
  const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
  const data = JSON.parse(text);
  expect(result.isError).toBe(true);
  expect(data.error).toContain("no path");
  client.close();
  agent.stop();
  service.close();
});

// ---------------------------------------------------- element-oriented tools

test("agent_cua_find_element routes criteria and returns the click point", async () => {
  const started = await start();
  const result = await call("agent_cua_find_element", {
    agent: "W-CUA-01", name: "Guardar", window_id: 101, max_results: 5,
  });
  expect(result.isError).toBe(false);
  expect(result.data.matches).toBe(2);
  expect(result.data.click_point).toEqual({ x: 80, y: 62 });
  expect(started.jobs[0]).toMatchObject({
    jobType: "cua",
    params: { tool: "find_element", args: { name: "Guardar", window_id: 101, max_results: 5 } },
  });
});

test("agent_cua_find_element requires at least one criterion", async () => {
  const started = await start();
  const result = await call("agent_cua_find_element", { agent: "W-CUA-01", window_id: 101 });
  expect(result.isError).toBe(true);
  expect(result.text + JSON.stringify(result.data ?? "")).toMatch(/name, automation_id, class_name, control_type/);
  expect(started.jobs.length).toBe(0);
});

test("agent_cua_invoke and agent_cua_set_value are confirm-gated", async () => {
  const started = await start();
  for (const call_ of [
    { name: "agent_cua_invoke", args: { name: "Guardar" } },
    { name: "agent_cua_set_value", args: { name: "Total", value: "1234" } },
    { name: "agent_cua_clipboard_set", args: { text: "hola mundo" } },
  ]) {
    const result = await call(call_.name, { agent: "W-CUA-01", window_id: 101, ...call_.args });
    expect(result.isError).toBe(true);
    expect(result.text + JSON.stringify(result.data ?? "")).toMatch(/confirm/i);
  }
  expect(started.jobs.length).toBe(0);
});

test("agent_cua_invoke with confirm activates the element through UIA", async () => {
  const started = await start();
  const result = await call("agent_cua_invoke", { agent: "W-CUA-01", name: "Guardar", window_id: 101, confirm: true });
  expect(result.isError).toBe(false);
  expect(result.data.via).toBe("invoke");
  expect(started.jobs[0]).toMatchObject({ params: { tool: "invoke", args: { name: "Guardar", confirm: true } } });
});

test("agent_cua_wait_for and agent_cua_table_read are read-only", async () => {
  const started = await start();
  const waited = await call("agent_cua_wait_for", { agent: "W-CUA-01", name: "Guardar", window_id: 101, timeout_ms: 5000 });
  expect(waited.isError).toBe(false);
  expect(waited.data.present).toBe(true);

  const table = await call("agent_cua_table_read", { agent: "W-CUA-01", window_id: 101, max_rows: 2 });
  expect(table.isError).toBe(false);
  expect(table.data.via).toBe("grid-pattern");
  expect(table.data.rows[1]).toEqual(["dato 1", "dato 2"]);

  expect(started.jobs.map((job) => (job.params as { tool: string }).tool)).toEqual(["wait_for", "table_read"]);
});

test("agent_cua_clipboard_get is read-only and returns the text", async () => {
  const started = await start();
  const result = await call("agent_cua_clipboard_get", { agent: "W-CUA-01" });
  expect(result.isError).toBe(false);
  expect(result.data.has_text).toBe(true);
  expect(result.data.text).toContain("FACT-2026-0001");
  expect(started.jobs[0]).toMatchObject({ params: { tool: "clipboard_get" } });
});

test("agent_cua_window validates the action and the move coordinates", async () => {
  const started = await start();
  const noCoords = await call("agent_cua_window", { agent: "W-CUA-01", action: "move", window_id: 101, confirm: true });
  expect(noCoords.isError).toBe(true);
  expect(noCoords.text + JSON.stringify(noCoords.data ?? "")).toMatch(/x and y/);

  const noConfirm = await call("agent_cua_window", { agent: "W-CUA-01", action: "close", window_id: 101 });
  expect(noConfirm.isError).toBe(true);
  expect(noConfirm.text + JSON.stringify(noConfirm.data ?? "")).toMatch(/confirm/i);
  expect(started.jobs.length).toBe(0);

  const ok = await call("agent_cua_window", { agent: "W-CUA-01", action: "maximize", window_id: 101, confirm: true });
  expect(ok.isError).toBe(false);
  expect(ok.data.action).toBe("maximize");
});

test("agent_cua_send_hotkey, agent_cua_drag and agent_cua_element_screenshot route their tools", async () => {
  const started = await start();

  const hotkey = await call("agent_cua_send_hotkey", { agent: "W-CUA-01", keys: "ctrl+s", window_id: 101, confirm: true });
  expect(hotkey.isError).toBe(false);
  expect(hotkey.data.keys).toBe("ctrl+s");

  const badDrag = await call("agent_cua_drag", { agent: "W-CUA-01", from_x: 10, from_y: 20, confirm: true });
  expect(badDrag.isError).toBe(true);

  const drag = await call("agent_cua_drag", {
    agent: "W-CUA-01", from_x: 10, from_y: 20, to_x: 300, to_y: 400, confirm: true,
  });
  expect(drag.isError).toBe(false);
  expect(drag.data.to).toEqual({ x: 300, y: 400 });

  const shot = await call("agent_cua_element_screenshot", { agent: "W-CUA-01", window_id: 101, name: "Factura" });
  expect(shot.isError).toBe(false);
  expect(shot.data.path).toContain("mrc-cua-elem");

  const tools = started.jobs.map((job) => (job.params as { tool: string }).tool);
  expect(tools).toEqual(["send_hotkey", "drag", "element_screenshot"]);
});

// ------------------------------------------------------------- browser tools

test("agent_cua_browser and agent_cua_record are registered", async () => {
  const started = await start();
  const tools = (await started.client.listTools()).tools.map((tool) => tool.name);
  expect(tools).toContain("agent_cua_browser");
  expect(tools).toContain("agent_cua_record");
});

test("agent_cua_browser state is read-only and routes a browser job", async () => {
  const started = await start();
  const result = await call("agent_cua_browser", { agent: "W-CUA-01", operation: "state" });
  expect(result.isError).toBe(false);
  expect(result.data.browser).toBe("chrome");
  expect(result.data.url).toBe("https://example.com/");
  expect(started.jobs[0]).toMatchObject({ jobType: "browser", params: { operation: "state" } });
});

test("agent_cua_browser open/navigate/click require confirm", async () => {
  const started = await start();
  for (const args of [
    { operation: "open", url: "https://example.com/" },
    { operation: "navigate", url: "https://example.com/" },
    { operation: "click", match: "more information" },
  ]) {
    const result = await call("agent_cua_browser", { agent: "W-CUA-01", ...args });
    expect(result.isError).toBe(true);
    expect(result.text + JSON.stringify(result.data ?? "")).toMatch(/confirm/i);
  }
  expect(started.jobs.length).toBe(0);
});

test("agent_cua_browser validates url scheme and click match", async () => {
  const started = await start();
  const bad = await call("agent_cua_browser", { agent: "W-CUA-01", operation: "navigate", url: "javascript:alert(1)", confirm: true });
  expect(bad.isError).toBe(true);
  expect(bad.text + JSON.stringify(bad.data ?? "")).toMatch(/http/);
  const noMatch = await call("agent_cua_browser", { agent: "W-CUA-01", operation: "click", confirm: true });
  expect(noMatch.isError).toBe(true);
  expect(noMatch.text + JSON.stringify(noMatch.data ?? "")).toMatch(/match/);
  const noQuery = await call("agent_cua_browser", { agent: "W-CUA-01", operation: "search", confirm: true });
  expect(noQuery.isError).toBe(true);
  expect(noQuery.text + JSON.stringify(noQuery.data ?? "")).toMatch(/match/);
  expect(started.jobs.length).toBe(0);
});

test("agent_cua_browser search types the query and submits it", async () => {
  const started = await start();
  const result = await call("agent_cua_browser", {
    agent: "W-CUA-01",
    operation: "search",
    match: "test",
    confirm: true,
  });
  expect(result.isError).toBe(false);
  expect(result.data.query).toBe("test");
  expect(result.data.typed).toBe(4);
  expect(result.data.submitted).toBe("keydown");
  const params = (started.jobs[0]?.params ?? {}) as Record<string, unknown>;
  expect(params).toMatchObject({ operation: "search", match: "test" });
});

test("agent_cua_browser click with confirm drives a browser click job", async () => {
  const started = await start();
  const result = await call("agent_cua_browser", {
    agent: "W-CUA-01",
    operation: "click",
    match: "more information",
    nth: 1,
    confirm: true,
  });
  expect(result.isError).toBe(false);
  expect(result.data.clicked).toEqual({ x: 10, y: 20, w: 100, h: 20 });
  expect(result.data.via).toBe("dom");
  const params = (started.jobs[0]?.params ?? {}) as Record<string, unknown>;
  expect(params).toMatchObject({ operation: "click", match: "more information", nth: 1 });
  expect(params).not.toHaveProperty("agent");
  expect(params).not.toHaveProperty("confirm");
});

// -------------------------------------------------------------- record tool

test("agent_cua_record requires confirm", async () => {
  const started = await start();
  const result = await call("agent_cua_record", { agent: "W-CUA-01", duration_sec: 5 });
  expect(result.isError).toBe(true);
  expect(result.text + JSON.stringify(result.data ?? "")).toMatch(/confirm/i);
  expect(started.jobs.length).toBe(0);
});

test("agent_cua_record pulls the clip into the screenshot dir with sha256", async () => {
  const started = await start();
  const result = await call("agent_cua_record", { agent: "W-CUA-01", duration_sec: 2, fps: 4, confirm: true });
  expect(result.isError).toBe(false);
  expect(result.data.sha256).toBe(FAKE_PNG_SHA);
  expect(result.data.encoder).toBe("mjpeg-avi");
  expect(result.data.localPath.startsWith(started.screenshotDir)).toBe(true);
  expect(result.data.localPath.endsWith(".avi")).toBe(true);
  expect(existsSync(result.data.localPath)).toBe(true);
  expect(result.data.downloadPath).toContain("/screenshots/");
  const jobsReported = started.jobs.filter((job) => job.jobType === "record");
  expect(jobsReported).toHaveLength(1);
  expect(jobsReported[0]).toMatchObject({ params: { duration_sec: 2, fps: 4, confirm: true } });
});

test("agent_cua_record keeps long clips async so the proxy does not cut them", async () => {
  const started = await start();
  const result = await call("agent_cua_record", { agent: "W-CUA-01", duration_sec: 30, fps: 8, confirm: true });
  expect(result.isError).toBe(false);
  expect(result.data.state).toBe("running");
  expect(typeof result.data.jobId).toBe("string");
  const jobsReported = started.jobs.filter((job) => job.jobType === "record");
  expect(jobsReported).toHaveLength(1);
  expect(jobsReported[0]).toMatchObject({ params: { duration_sec: 30, fps: 8, confirm: true } });
});
