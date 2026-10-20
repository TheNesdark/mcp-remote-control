/**
 * Tests for the agent_settings tool (server/src/tools/agent-settings.ts).
 *
 * The settings job is answered by the agent itself (agent-dotnet
 * SettingsJob.cs): it reads and writes the name, the hub, the token and the
 * autostart of the machine.
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

const SETTINGS = {
  ok: true,
  name: "SERVER-RX",
  server: "ws://192.168.1.192:8787",
  token: "mrc_********abcd",
  tags: [],
  id: "ag_1bd6d2d2",
  paused: false,
  autostart: true,
  autostart_command: "\"C:\\\\rc-agent.exe\" --name SERVER-RX",
  config_path: "C:\\Users\\SERVER-RX\\AppData\\Roaming\\mcp-remote-control\\agent.json",
  version: "1.0.32",
  watchdog: true,
  pid: 4242,
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
  if (msg.jobType === "settings") {
    const params = (msg.params ?? {}) as { operation?: string };
    if (params.operation === "write") {
      return { meta: { ok: true, changed: ["server"], name: "SERVER-RX", server: "ws://nuevo:8787", autostart: true, restart_required: true } };
    }
    return { meta: SETTINGS };
  }
  return { ok: false, error: `unexpected job ${msg.jobType}` };
}

async function start(): Promise<Harness> {
  const service = createService(testServerConfig(TOKEN));
  const screenshotDir = await mkdtempSync(join(tmpdir(), "mrc-settings-shots-"));
  const jobs: Harness["jobs"] = [];
  const agent = new FakeAgent({
    url: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "W-SET-01",
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
  const client = new Client({ name: "settings-tool-test", version: "0.0.0" });
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

test("the agent_settings tool is registered", async () => {
  const started = await start();
  const tools = (await started.client.listTools()).tools.map((tool) => tool.name);
  expect(tools).toContain("agent_settings");
});

test("agent_settings reads the settings of the agent", async () => {
  const started = await start();
  const result = await call("agent_settings", { agent: "W-SET-01", operation: "read" });
  expect(result.isError).toBe(false);
  expect(started.jobs.length).toBe(1);
  expect(started.jobs[0]).toMatchObject({ jobType: "settings", params: { operation: "read" } });
  expect(result.data.name).toBe("SERVER-RX");
  expect(result.data.autostart).toBe(true);
  expect(result.data.watchdog).toBe(true);
});

test("agent_settings never returns the whole token", async () => {
  await start();
  const result = await call("agent_settings", { agent: "W-SET-01", operation: "read" });
  expect(String(result.data.token)).toContain("*");
  expect(String(result.data.token)).not.toContain("mrc_LajSuZKlZ57FDiI2ohKll0eisXagGTFndEv2GYu7-SY");
});

test("agent_settings writes the new settings", async () => {
  const started = await start();
  const result = await call("agent_settings", {
    agent: "W-SET-01",
    operation: "write",
    server: "ws://nuevo:8787",
    name: "OTRO",
  });
  expect(result.isError).toBe(false);
  expect(started.jobs[0]).toMatchObject({
    jobType: "settings",
    params: { operation: "write", server: "ws://nuevo:8787", name: "OTRO" },
  });
  expect(result.data.changed).toContain("server");
  expect(result.data.restart_required).toBe(true);
});

test("agent_settings fails for an unknown agent", async () => {
  await start();
  const result = await call("agent_settings", { agent: "NOPE", operation: "read" });
  expect(result.isError).toBe(true);
});
