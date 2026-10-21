/**
 * Tests for the agent_message tool (server/src/tools/agent-message.ts).
 *
 * The box is drawn by the agent itself (agent-dotnet Message.cs) as a `message`
 * job, not by a PowerShell child: an exec job runs inside a job object with
 * KILL_ON_JOB_CLOSE, so a child process dies with the job and the user never
 * sees the notice.
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
  // The real agent answers with the box state in the meta (agent-dotnet Message.cs).
  if (msg.jobType === "message") {
    const params = msg.params as { text: string; title: string; style: string; buttons: string };
    return { meta: { shown: true, title: params.title, style: params.style, buttons: params.buttons } };
  }
  return { ok: false, error: `unexpected job ${msg.jobType}` };
}

async function start(): Promise<Harness> {
  const service = createService(testServerConfig(TOKEN));
  const screenshotDir = await mkdtempSync(join(tmpdir(), "mrc-message-shots-"));
  const jobs: Harness["jobs"] = [];
  const agent = new FakeAgent({
    url: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "W-MSG-01",
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
  const client = new Client({ name: "message-tool-test", version: "0.0.0" });
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

test("the agent_message tool is registered", async () => {
  const started = await start();
  const tools = (await started.client.listTools()).tools.map((tool) => tool.name);
  expect(tools).toContain("agent_message");
});

test("agent_message sends a message job, not a shell script", async () => {
  const started = await start();
  const result = await call("agent_message", { agent: "W-MSG-01", text: "Reinicio en 5 minutos" });
  expect(result.isError).toBe(false);
  expect(started.jobs.length).toBe(1);
  expect(started.jobs[0]?.jobType).toBe("message");
  const params = started.jobs[0]?.params as Record<string, unknown>;
  expect(params.text).toBe("Reinicio en 5 minutos");
  expect(params.title).toBe("Remote control");
  expect(params.style).toBe("info");
  expect(params.buttons).toBe("ok");
  expect(params.command).toBeUndefined();
});

test("agent_message passes the title, the icon and the buttons", async () => {
  const started = await start();
  const result = await call("agent_message", {
    agent: "W-MSG-01",
    text: "Guarde su trabajo",
    title: "Sistemas",
    style: "warning",
    buttons: "okcancel",
  });
  expect(result.isError).toBe(false);
  const params = started.jobs[0]?.params as Record<string, unknown>;
  expect(params.title).toBe("Sistemas");
  expect(params.style).toBe("warning");
  expect(params.buttons).toBe("okcancel");
  expect(result.data.shown).toBe(true);
  expect(result.data.style).toBe("warning");
});

test("agent_message fails for an unknown agent", async () => {
  const started = await start();
  const result = await call("agent_message", { agent: "NOPE", text: "hola" });
  expect(result.isError).toBe(true);
  expect(started.jobs.length).toBe(0);
});
