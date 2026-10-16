import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeAgent } from "../../scripts/fake-agent.ts";
import { testServerConfig } from "../../scripts/test-utils.ts";
import type { ServerConfig } from "../../server/src/config.ts";
import { createMcpHttpHandler } from "../../server/src/mcp-http.ts";
import { createService, type Service } from "../../server/src/service.ts";

const TOKEN = "test-token";

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return testServerConfig(TOKEN, overrides);
}

let service: Service | null = null;
let httpServer: Bun.Server<unknown> | null = null;
const agents: FakeAgent[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      // already closed
    }
  }
  clients.length = 0;
  for (const agent of agents) agent.stop();
  agents.length = 0;
  if (httpServer) {
    await httpServer.stop(true);
    httpServer = null;
  }
  service?.close();
  service = null;
});

async function startHttp(): Promise<string> {
  service = createService(testConfig());
  const agent = new FakeAgent({ url: `ws://127.0.0.1:${service.port}`, token: TOKEN, name: "H-01", onLog: () => {} });
  agents.push(agent);
  await agent.start();

  const handler = createMcpHttpHandler(service.hub, {
    version: "0.5.0-test",
    screenshotDir: "/tmp/mrc-test-screenshots",
    audit: service.audit,
    bearerToken: TOKEN,
  });
  httpServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return `http://127.0.0.1:${httpServer.port}/mcp`;
}

test("requests without a bearer token get 401", async () => {
  const url = await startHttp();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(res.status).toBe(401);

  const wrong = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer nope" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  expect(wrong.status).toBe(401);
});

test("mcp over http lists tools and runs them", async () => {
  const url = await startHttp();
  const client = new Client({ name: "http-test", version: "0.0.0" });
  clients.push(client);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);

  const tools = await client.listTools();
  expect(tools.tools.some((tool) => tool.name === "agents_list")).toBe(true);
  expect(tools.tools.some((tool) => tool.name === "agent_exec")).toBe(true);

  const listed = await client.callTool({ name: "agents_list", arguments: {} });
  const text = (listed.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "[]";
  const agentsList = JSON.parse(text) as Array<{ name: string; online: boolean }>;
  expect(agentsList.some((agent) => agent.name === "H-01" && agent.online)).toBe(true);

  const exec = await client.callTool({ name: "agent_exec", arguments: { agent: "H-01", command: "echo hi" } });
  const execText =
    (exec.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
  expect((JSON.parse(execText) as { ok: boolean }).ok).toBe(true);
});

test("mcp http serves concurrent and reconnecting clients", async () => {
  const url = await startHttp();

  async function connectedClient(name: string): Promise<Client> {
    const client = new Client({ name, version: "0.0.0" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    );
    return client;
  }

  // Two sessions alive at the same time.
  const first = await connectedClient("http-test-a");
  const second = await connectedClient("http-test-b");
  const tools = await second.listTools();
  expect(tools.tools.some((tool) => tool.name === "agents_list")).toBe(true);

  // A client that reconnects after closing gets a fresh session.
  await first.close();
  clients.splice(clients.indexOf(first), 1);
  const reopened = await connectedClient("http-test-a-retry");
  const listed = await reopened.callTool({ name: "agents_list", arguments: {} });
  const text = (listed.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "[]";
  expect((JSON.parse(text) as Array<{ name: string }>).some((agent) => agent.name === "H-01")).toBe(true);
});

test("unknown session ids are 404, missing session ids on non-POST are 400", async () => {
  const url = await startHttp();
  const auth = { authorization: `Bearer ${TOKEN}` };

  const unknown = await fetch(url, { method: "POST", headers: { ...auth, "mcp-session-id": "nope" }, body: "{}" });
  expect(unknown.status).toBe(404);

  const missing = await fetch(url, { method: "GET", headers: auth });
  expect(missing.status).toBe(400);
});

test("mcp http is disabled by default in the service", () => {
  service = createService(testConfig());
  expect(service.mcpHttpPort).toBe(0);
  expect(service.mcpHttpUrl).toBe("");
});

test("service mounts mcp http on a configured port", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const freePort = probe.port!;
  await probe.stop(true);

  service = createService(testConfig({ mcpHttpPort: freePort }));
  expect(service.mcpHttpPort).toBe(freePort);
  expect(service.mcpHttpUrl).toBe(`http://127.0.0.1:${freePort}/mcp`);

  const denied = await fetch(service.mcpHttpUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(denied.status).toBe(401);

  const client = new Client({ name: "http-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(service.mcpHttpUrl), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  const tools = await client.listTools();
  expect(tools.tools.some((tool) => tool.name === "agents_list")).toBe(true);
});
