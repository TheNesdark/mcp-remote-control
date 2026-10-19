#!/usr/bin/env bun
/**
 * End-to-end test over the real entry points:
 *   MCP client (stdio)  <->  server process (index.ts)  <->  fake agents (websocket)
 *
 * The real Windows agent (agent-dotnet) cannot run on the CI Linux host, so the
 * agent side is covered by the in-process FakeAgent: this exercises the hub's
 * routing, gating, presence, concurrency and job lifecycle over the wire.
 *
 * Run: bun run e2e
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { FakeAgent } from "./fake-agent.ts";
import { cleanEnv, waitFor } from "./test-utils.ts";

const PORT = Number(process.env.E2E_PORT ?? 18_999);
const TOKEN = "e2e-token";
const SERVER_ENTRY = join(import.meta.dir, "..", "server", "src", "index.ts");

interface AgentSummary {
  id: string;
  name: string;
  host: string;
  os: string;
  tags: string[];
  caps: string[];
  online: boolean;
  paused: boolean;
}

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures++;
  console.error(`  FAIL ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ""}`);
}

const client = new Client({ name: "e2e-client", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: "bun",
  // --env-file is a bun-level flag (before `run`) and replaces the operator's
  // .env, which Bun would otherwise merge into this child; inherited env wins.
  args: ["--env-file", join(import.meta.dir, "..", "tests", "e2e-sandbox", ".env"), SERVER_ENTRY],
  env: {
    ...cleanEnv(),
    MRC_PORT: String(PORT),
    // explicit 0: even if a stray .env would re-add the operator's MCP port,
    // an inherited variable wins over file values in Bun.
    MRC_MCP_HTTP_PORT: "0",
    MRC_TOKEN: TOKEN,
    MRC_LOG_LEVEL: "info",
  },
});

async function listAgents(): Promise<AgentSummary[]> {
  const res = await client.callTool({ name: "agents_list", arguments: {} });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text ?? "[]";
  return JSON.parse(text) as AgentSummary[];
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: Record<string, unknown> }> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text ?? "{}";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { text };
  }
  return { isError: Boolean(res.isError), data };
}

const agents: FakeAgent[] = [];
try {
  console.log("e2e: spawning server process and connecting mcp client");
  await client.connect(transport);

  const tools = await client.listTools();
  check(
    "agents_list tool is exposed",
    tools.tools.some((t) => t.name === "agents_list"),
  );

  check("no agents initially", (await listAgents()).length === 0);

  console.log("e2e: connecting fake agents");
  const a1 = new FakeAgent({
    url: `ws://127.0.0.1:${PORT}`,
    token: TOKEN,
    name: "FAKE-01",
    tags: ["test"],
    onLog: (line) => console.log(`  [FAKE-01] ${line}`),
    respond: (msg) => {
      const params = (msg.params ?? {}) as { command?: string };
      // Emulate the real agent's exec: run nothing, echo the command back.
      if (msg.jobType === "exec") {
        const command = params.command ?? "";
        const sleepMs = /sleep\s+(\d+)/.exec(command) ? 5_000 : 0;
        return { stdout: `${command}\n`, exitCode: 0, ...(sleepMs ? { sleepMs } : {}) };
      }
      return undefined;
    },
  });
  agents.push(a1);
  await a1.start();

  const a2 = new FakeAgent({
    url: `ws://127.0.0.1:${PORT}`,
    token: TOKEN,
    name: "FAKE-02",
    paused: true,
    onLog: (line) => console.log(`  [FAKE-02] ${line}`),
  });
  agents.push(a2);
  await a2.start();

  const listed = await waitFor(
    async () => {
      const all = await listAgents();
      return all.length === 2 ? all : undefined;
    },
    { label: "two agents in agents_list", timeoutMs: 8_000 },
  );
  const one = listed.find((a) => a.name === "FAKE-01")!;
  const two = listed.find((a) => a.name === "FAKE-02")!;
  check("FAKE-01 online and not paused", one.online && !one.paused);
  check("FAKE-02 online and paused (local disable)", two.online && two.paused);
  check("tags round-trip through the protocol", one.tags.includes("test"));

  a1.pause();
  await waitFor(
    async () => {
      const all = await listAgents();
      return all.find((a) => a.name === "FAKE-01")?.paused ? true : undefined;
    },
    { label: "FAKE-01 paused", timeoutMs: 8_000 },
  );
  check("presence pause reaches the server", true);
  a1.resume();

  a2.stop();
  await waitFor(
    async () => {
      const all = await listAgents();
      const f = all.find((a) => a.name === "FAKE-02");
      return f && !f.online ? true : undefined;
    },
    { label: "FAKE-02 offline", timeoutMs: 8_000 },
  );
  check("disconnect marks the agent offline", true);

  const bad = new FakeAgent({ url: `ws://127.0.0.1:${PORT}`, token: "wrong-token", name: "FAKE-BAD" });
  agents.push(bad);
  let rejected = false;
  try {
    await bad.start(3_000);
  } catch {
    rejected = true;
  }
  check("bad token is rejected with auth_failed", rejected && bad.lastError?.code === "auth_failed", bad.lastError);

  // -------------------------------------------------------------------------
  // Job routing and lifecycle against FAKE-01
  // -------------------------------------------------------------------------
  console.log("e2e: exercising job routing and lifecycle");

  const echo = await callTool("agent_exec", { agent: "FAKE-01", command: "echo hello-e2e" });
  check(
    "agent_exec returns the agent's stdout and exit code",
    echo.isError === false && echo.data.ok === true && String(echo.data.stdout).includes("hello-e2e"),
    echo.data,
  );

  const unknown = await callTool("agent_exec", { agent: "NOPE-99", command: "echo x" });
  check("unknown agent is rejected", unknown.isError === true, unknown.data);

  // A paused agent refuses work (assertAgentReady).
  const paused = await callTool("agent_exec", { agent: "FAKE-02", command: "echo x" });
  check("paused agent rejects jobs", paused.isError === true, paused.data);

  // async job + status/list + cancel
  const async1 = await callTool("agent_exec", { agent: "FAKE-01", command: "sleep 10", async: true });
  check("async agent_exec returns a jobId", typeof async1.data.jobId === "string", async1.data);
  if (typeof async1.data.jobId === "string") {
    const status = await callTool("agent_jobs", { operation: "status", jobId: async1.data.jobId });
    check("agent_jobs reports the running job", status.data.state === "running", status.data);
    const cancelled = await callTool("agent_jobs", { operation: "cancel", jobId: async1.data.jobId });
    check("agent_jobs cancels the running job", cancelled.data.ok === true, cancelled.data);
    const after = await waitFor(
      async () => {
        const s = await callTool("agent_jobs", { operation: "status", jobId: async1.data.jobId as string });
        return s.data.state !== "running" ? s.data : undefined;
      },
      { label: "job settles after cancel", timeoutMs: 8_000 },
    );
    check("cancelled job settles as failed", after.state === "failed", after);
  }

  // Concurrent jobs on one agent are serialized by the per-agent limiter.
  const many = await Promise.all(
    [1, 2, 3].map((n) => callTool("agent_exec", { agent: "FAKE-01", command: `echo n${n}` })),
  );
  check(
    "three concurrent jobs all settle",
    many.every((m) => m.data.ok === true),
    many.map((m) => m.data),
  );

  // -------------------------------------------------------------------------
  // Confirmation gate on a destructive tool
  // -------------------------------------------------------------------------
  console.log("e2e: exercising the confirm gate");
  const noConfirm = await callTool("agent_exec", { agent: "FAKE-01", command: "echo x" });
  // agent_exec is not confirm-gated; use a CUA tool that is.
  check("agent_exec needs no confirm", noConfirm.isError === false, noConfirm.data);
  const cuaNoConfirm = await callTool("agent_cua_click", { agent: "FAKE-01", x: 1, y: 2 });
  check("agent_cua_click requires confirm", cuaNoConfirm.isError === true, cuaNoConfirm.data);
} catch (err) {
  failures++;
  console.error("e2e error:", err);
} finally {
  for (const agent of agents) agent.stop();
  try {
    await client.close();
  } catch {
    // already closed
  }
}

console.log(failures === 0 ? "\ne2e: PASS" : `\ne2e: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
