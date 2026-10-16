#!/usr/bin/env bun
/**
 * End-to-end test over the real entry points:
 *   MCP client (stdio)  <->  server process (index.ts)  <->  fake agents (websocket)
 *
 * Run: bun run e2e
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { FakeAgent } from "./fake-agent.ts";

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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(label: string, fn: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await sleep(150);
  }
  throw new Error(`waitFor '${label}' timed out`);
}

function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

const client = new Client({ name: "e2e-client", version: "0.0.0" });
const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", SERVER_ENTRY],
  env: { ...cleanEnv(), MRC_PORT: String(PORT), MRC_TOKEN: TOKEN, MRC_LOG_LEVEL: "info" },
});

async function listAgents(): Promise<AgentSummary[]> {
  const res = await client.callTool({ name: "agents_list", arguments: {} });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text ?? "[]";
  return JSON.parse(text) as AgentSummary[];
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

  const listed = await waitFor("two agents in agents_list", async () => {
    const all = await listAgents();
    return all.length === 2 ? all : undefined;
  });
  const one = listed.find((a) => a.name === "FAKE-01")!;
  const two = listed.find((a) => a.name === "FAKE-02")!;
  check("FAKE-01 online and not paused", one.online && !one.paused);
  check("FAKE-02 online and paused (local disable)", two.online && two.paused);
  check("tags round-trip through the protocol", one.tags.includes("test"));

  a1.pause();
  await waitFor("FAKE-01 paused", async () => {
    const all = await listAgents();
    return all.find((a) => a.name === "FAKE-01")?.paused ? true : undefined;
  });
  check("presence pause reaches the server", true);
  a1.resume();

  a2.stop();
  await waitFor("FAKE-02 offline", async () => {
    const all = await listAgents();
    const f = all.find((a) => a.name === "FAKE-02");
    return f && !f.online ? true : undefined;
  });
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
