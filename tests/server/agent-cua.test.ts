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
    case "screenshot":
      return { path: "C:\\Users\\SERVER-RX\\AppData\\Local\\Temp\\mrc-cua-shot.png", bytes: FAKE_PNG.length };
    case "browser_state":
      return {
        browser: "chrome", window_id: 101, window_title: "Example - Google Chrome",
        url: "https://example.com/", page_title: "Example Domain", page_ready: true,
        bounds: { x: 10, y: 20, width: 1600, height: 900 },
      };
    case "browser_open":
      return { mode: "takeover", browser: "chrome", window_id: 101, navigated: true };
    case "browser_navigate":
      return { navigated: true, window_id: 101, url: "https://example.com/" };
    case "browser_get_text":
      return { url: "https://example.com/", title: "Example Domain", truncated: false, text: "Example Domain" };
    case "browser_tabs":
      return { browser: "chrome", tab_count: 1, tabs: [{ title: "Example Domain", selected: true }] };
    case "browser_click":
      return { clicked: { x: 10, y: 20 }, name: "More information...", matches: 1 };
    case "record":
      return {
        path: "C:\\Users\\SERVER-RX\\AppData\\Local\\Temp\\mrc-cua-rec.avi", bytes: FAKE_PNG.length,
        frames: 8, fps: 4, duration_sec: 2, encoder: "mjpeg-avi",
      };
    default:
      return { unexpectedTool: params.tool };
  }
}

const FAKE_PNG = Buffer.from("mrc-cua-fake-png-bytes");
const FAKE_PNG_SHA = createHash("sha256").update(FAKE_PNG).digest("hex");

function respond(msg: JobRequestMsg): FakeResponse {
  if (msg.jobType === "fs.read") {
    return { stdout: FAKE_PNG.toString("base64"), meta: { eof: true, size: FAKE_PNG.length, sha256: FAKE_PNG_SHA } };
  }
  if (msg.jobType === "cua") return { meta: sidecarMeta(msg) };
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

// ------------------------------------------------------------- browser tools

test("agent_cua_browser and agent_cua_record are registered", async () => {
  const started = await start();
  const tools = (await started.client.listTools()).tools.map((tool) => tool.name);
  expect(tools).toContain("agent_cua_browser");
  expect(tools).toContain("agent_cua_record");
});

test("agent_cua_browser state is read-only and routes browser_state", async () => {
  const started = await start();
  const result = await call("agent_cua_browser", { agent: "W-CUA-01", operation: "state" });
  expect(result.isError).toBe(false);
  expect(result.data.browser).toBe("chrome");
  expect(result.data.url).toBe("https://example.com/");
  expect(started.jobs[0]).toMatchObject({ jobType: "cua", params: { tool: "browser_state", args: {} } });
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
  expect(started.jobs.length).toBe(0);
});

test("agent_cua_browser click with confirm drives browser_click through the sidecar", async () => {
  const started = await start();
  const result = await call("agent_cua_browser", {
    agent: "W-CUA-01",
    operation: "click",
    match: "more information",
    window_id: 101,
    confirm: true,
  });
  expect(result.isError).toBe(false);
  expect(result.data.clicked).toEqual({ x: 10, y: 20 });
  const params = (started.jobs[0]?.params ?? {}) as { tool: string; args: Record<string, unknown> };
  expect(params.tool).toBe("browser_click");
  expect(params.args).toMatchObject({ match: "more information", window_id: 101, confirm: true });
  expect(params.args).not.toHaveProperty("agent");
  expect(params.args).not.toHaveProperty("operation");
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
  const jobsReported = started.jobs.filter((job) => job.jobType === "cua");
  expect(jobsReported).toHaveLength(1);
  expect(jobsReported[0]).toMatchObject({ params: { tool: "record", args: { duration_sec: 2, fps: 4, confirm: true } } });
});
