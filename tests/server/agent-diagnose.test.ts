/**
 * Tests for the agent_diagnose tool (server/src/tools/agent-diagnose.ts).
 *
 * The diagnose job is answered by the agent itself (agent-dotnet Diagnose.cs):
 * it reports the agent, the bridge, the Java windows and the tail of the log.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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

const DIAGNOSE = {
  ok: true,
  version: "1.0.31",
  uptimeSec: 4242,
  pid: 1234,
  user: "SERVER-RX",
  machine: "DESKTOP-S7PG32F",
  os: "Microsoft Windows NT 10.0.19045.0",
  bridge: { loaded: true, library: "C:\\Windows\\system32\\WindowsAccessBridge-64.dll" },
  recording: { ok: true, active: false, elapsed_sec: 0, frames: 0, fps: 8, resolution: "1368x768" },
  windows: [
    { hwnd: 101, pid: 20, process: "java", class: "SunAwtDialog", title: "G@noma Plus", java: true },
    { hwnd: 102, pid: 30, process: "explorer", class: "Shell_TrayWnd", title: "Barra de tareas", java: false },
  ],
  java: [
    {
      hwnd: 101,
      title: "G@noma Plus",
      windowAlive: true,
      bridgeAnswers: false,
      note: "the Java application is no longer running (the JVM exited; look for hs_err_pid*.log next to the jar)",
    },
  ],
  logTail: ["2026-10-20T02:33:11.000Z ERROR jab: the tree walk ran out of time"],
};

interface Harness {
  service: Service;
  agent: FakeAgent;
  client: Client;
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

function respond(msg: JobRequestMsg): FakeResponse {
  // The real agent answers with the report in the meta (agent-dotnet Diagnose.cs).
  if (msg.jobType === "diagnose") return { meta: DIAGNOSE };
  return { ok: false, error: `unexpected job ${msg.jobType}` };
}

async function start(): Promise<Harness> {
  const service = createService(testServerConfig(TOKEN));
  const screenshotDir = await mkdtempSync(join(tmpdir(), "mrc-diag-shots-"));
  const jobs: Harness["jobs"] = [];
  const agent = new FakeAgent({
    url: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "W-DIAG-01",
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
  const client = new Client({ name: "diagnose-tool-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  harness = { service, agent, client, jobs, screenshotDir };
  return harness;
}

async function call(name: string, args: Record<string, unknown>) {
  if (!harness) throw new Error("harness not started");
  const result = await harness.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // plain-text transport error
  }
  return { isError: result.isError === true, data, text };
}

test("the agent_diagnose tool is registered", async () => {
  const started = await start();
  const tools = (await started.client.listTools()).tools.map((tool) => tool.name);
  expect(tools).toContain("agent_diagnose");
});

test("agent_diagnose asks the agent for a diagnose job", async () => {
  const started = await start();
  const result = await call("agent_diagnose", { agent: "W-DIAG-01" });
  expect(result.isError).toBe(false);
  expect(started.jobs.length).toBe(1);
  expect(started.jobs[0]?.jobType).toBe("diagnose");
});

test("agent_diagnose reports the agent, the bridge and the Java windows", async () => {
  await start();
  const result = await call("agent_diagnose", { agent: "W-DIAG-01" });
  expect(result.isError).toBe(false);
  expect(result.data.version).toBe("1.0.31");
  expect(result.data.bridge.loaded).toBe(true);
  expect(result.data.java[0].bridgeAnswers).toBe(false);
  expect(result.data.java[0].note).toContain("no longer running");
  expect((result.data.logTail as string[]).length).toBeGreaterThan(0);
});

test("agent_diagnose fails for an unknown agent", async () => {
  const started = await start();
  const result = await call("agent_diagnose", { agent: "NOPE" });
  expect(result.isError).toBe(true);
  expect(started.jobs.length).toBe(0);
});

test("agent_diagnose reports the log tail of the agent", async () => {
  await start();
  const result = await call("agent_diagnose", { agent: "W-DIAG-01" });
  expect(result.isError).toBe(false);
  expect(Array.isArray(result.data.logTail)).toBe(true);
});
