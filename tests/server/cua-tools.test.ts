import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JobRequestMsg } from "@mrc/shared";
import { FakeAgent, type FakeResponse } from "../../scripts/fake-agent.ts";
import { testServerConfig } from "../../scripts/test-utils.ts";
import { createMcpHttpHandler } from "../../server/src/mcp-http.ts";
import { createService, type Service } from "../../server/src/service.ts";

const TOKEN = "test-token";
const WINDOWS_OS = "Windows_NT 10.0.19045";

interface Harness {
  service: Service;
  agent: FakeAgent;
  client: Client;
  /** Every `cua` job the hub sent, in order. */
  jobs: Record<string, unknown>[];
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
    harness = null;
  }
  if (httpServer) {
    await httpServer.stop(true);
    httpServer = null;
  }
});

async function startCua(options: { caps?: string[] } = {}): Promise<Harness> {
  const service = createService(
    // a non-empty cuaDriverPath marks the hub as a Cua publisher (welcome carries it)
    testServerConfig(TOKEN, {
      cuaDriverPath: "/tmp/mrc-test-cua.zip",
      cuaDriverVersion: "0.36.0",
      cuaDriverSha256: "f8c47024b626f4e0e70f8428d2998df39e4879110c5722a29d5fd03e367353ad",
    }),
  );
  const jobs: Record<string, unknown>[] = [];
  const agent = new FakeAgent({
    url: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "CUA-01",
    os: WINDOWS_OS,
    caps: options.caps ?? ["exec", "cua"],
    onLog: () => {},
    respond: (msg: JobRequestMsg): FakeResponse | undefined => {
      if (msg.jobType !== "cua") return undefined;
      const params = msg.params as Record<string, unknown>;
      jobs.push(params);
      const tool = String(params.tool ?? params.action ?? "");
      if (params.action === "status") {
        return { meta: { installed: true, version: "0.36.0", dir: "C:\\cua", daemon: "running", announced: "0.36.0" } };
      }
      if (params.action === "setup") {
        return { meta: { downloaded: true, version: "0.36.0" } };
      }
      if (tool === "list_windows") return { meta: { exitCode: 0, stdout: "[{\"pid\":1,\"window_id\":2}]" } };
      if (tool === "click") return { meta: { exitCode: 0, stdout: "{\"path\":\"ax\",\"effect\":\"confirmed\"}" } };
      if (tool === "kill_app") {
        return { meta: { exitCode: 2, stdout: "", stderr: "daemon not running", ok: false, error: "daemon not running" } };
      }
      return { meta: { exitCode: 0, stdout: "{}" } };
    },
  });
  await agent.start();

  const handler = createMcpHttpHandler(service.hub, {
    version: "test",
    screenshotDir: "/tmp/mrc-test-screenshots",
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
  harness = { service, agent, client, jobs };
  return harness;
}

async function call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; data: any }> {
  if (!harness) throw new Error("harness not started");
  const result = await harness.client.callTool({ name, ...(args ? { arguments: args } : {}) } as never);
  const text =
    (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  return { isError: result.isError === true, data };
}

test("welcome announces the pinned Cua Driver build", async () => {
  const started = await startCua();
  const welcome = started.agent.welcome!;
  expect(welcome.cuaDriverVersion).toBe("0.36.0");
  expect(welcome.cuaDriverUrl).toBe("/cua/latest.zip");
  expect(welcome.cuaDriverSha256).toMatch(/^[0-9a-f]{64}$/);
});

test("the 64 driver tools are registered plus the three companions", async () => {
  const started = await startCua();
  const tools = (await started.client.listTools()).tools.map((tool) => tool.name);
  expect(tools.filter((name) => name.startsWith("agent_cua_"))).toHaveLength(67);
  for (const name of ["agent_cua_list_windows", "agent_cua_get_window_state", "agent_cua_click", "agent_cua_call", "agent_cua_setup", "agent_cua_status"]) {
    expect(tools).toContain(name);
  }
});

test("agent_cua tools default the session and pass params through", async () => {
  const started = await startCua();
  const result = await call("agent_cua_list_windows", { agent: "CUA-01", params: { pid: 1 } });
  expect(result.isError).toBe(false);
  expect(result.data).toMatchObject({ ok: true, tool: "list_windows", stdout: "[{\"pid\":1,\"window_id\":2}]" });
  expect(started.jobs[0]).toMatchObject({ action: "call", tool: "list_windows", args: { session: "mrc", pid: 1 } });
});

test("explicit session wins over the mrc default", async () => {
  const started = await startCua();
  await call("agent_cua_list_windows", { agent: "CUA-01", params: { session: "batch-7" } });
  expect(started.jobs[0]).toMatchObject({ args: { session: "batch-7" } });
});

test("destructive driver tools require confirm=true", async () => {
  const started = await startCua();
  const refused = await call("agent_cua_click", { agent: "CUA-01", params: { pid: 1, x: 10, y: 20 } });
  expect(refused.isError).toBe(true);
  expect(String(refused.data.error)).toContain("confirm=true");
  expect(started.jobs.length).toBe(0);

  const allowed = await call("agent_cua_click", { agent: "CUA-01", params: { pid: 1, x: 10, y: 20 }, confirm: true });
  expect(allowed.isError).toBe(false);
  expect(allowed.data.stdout).toContain("confirmed");
  expect(started.jobs[0]).toMatchObject({ tool: "click", args: { session: "mrc", pid: 1 } });
});

test("agents without the cua capability are refused before any job", async () => {
  const started = await startCua({ caps: ["exec"] });
  const result = await call("agent_cua_list_windows", { agent: "CUA-01" });
  expect(result.isError).toBe(true);
  expect(String(result.data.error)).toContain("cua");
  expect(started.jobs.length).toBe(0);
});

test("agent_cua_status and agent_cua_setup run their own actions", async () => {
  const started = await startCua();
  const status = await call("agent_cua_status", { agent: "CUA-01" });
  expect(status.isError).toBe(false);
  expect(status.data).toMatchObject({ ok: true, installed: true, version: "0.36.0", daemon: "running" });
  expect(started.jobs[0]).toMatchObject({ action: "status" });

  const setup = await call("agent_cua_setup", { agent: "CUA-01" });
  expect(setup.isError).toBe(false);
  expect(setup.data).toMatchObject({ ok: true, downloaded: true });
  expect(started.jobs[1]).toMatchObject({ action: "setup" });
});

test("driver-side failures come back as structured errors", async () => {
  const started = await startCua();
  const result = await call("agent_cua_call", { agent: "CUA-01", tool: "kill_app" });
  expect(result.isError).toBe(true);
  expect(result.data).toMatchObject({ ok: false, error: "daemon not running", exitCode: 2 });
  expect(started.jobs[0]).toMatchObject({ action: "call", tool: "kill_app" });
});
