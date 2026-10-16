#!/usr/bin/env bun
/**
 * End-to-end test over the real entry points:
 *   MCP client (stdio)  <->  server process (index.ts)  <->  fake agents (websocket)
 *
 * Run: bun run e2e
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgent } from "./fake-agent.ts";

const PORT = Number(process.env.E2E_PORT ?? 18_999);
const TOKEN = "e2e-token";
const SERVER_ENTRY = join(import.meta.dir, "..", "server", "src", "index.ts");
const AGENT_ENTRY = join(import.meta.dir, "..", "agent", "src", "index.ts");

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

async function callAgentTool(
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

/** Prefix a child process stream line-by-line for readable e2e output. */
function forwardLines(stream: ReadableStream<Uint8Array>, prefix: string): void {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) console.log(`${prefix}${line}`);
        index = buffer.indexOf("\n");
      }
    }
  })();
}

const agents: FakeAgent[] = [];
let agentProc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
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

  // -------------------------------------------------------------------------
  // Real agent: agent_exec end to end (streaming, exit codes, timeout kill)
  // -------------------------------------------------------------------------
  console.log("e2e: starting the real agent (agent/src)");
  agentProc = Bun.spawn<"ignore", "pipe", "pipe">({
    cmd: ["bun", "run", AGENT_ENTRY, "--server", `ws://127.0.0.1:${PORT}`, "--token", TOKEN, "--name", "E2E-01", "--tags", "e2e"],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  forwardLines(agentProc.stdout, "  [E2E-01] ");
  forwardLines(agentProc.stderr, "  [E2E-01] ");

  await waitFor("real agent online", async () => {
    const all = await listAgents();
    const real = all.find((a) => a.name === "E2E-01");
    return real?.online ? true : undefined;
  });
  check("real agent connected to the hub", true);

  const echo = await callAgentTool("agent_exec", { agent: "E2E-01", command: "echo hello-e2e" });
  check(
    "agent_exec echoes stdout and exit code 0",
    echo.data.ok === true && String(echo.data.stdout).includes("hello-e2e") && echo.data.exitCode === 0,
    echo.data,
  );

  const failed = await callAgentTool("agent_exec", { agent: "E2E-01", command: "printf 'oops' 1>&2; exit 3" });
  check(
    "agent_exec reports non-zero exit code and stderr",
    failed.data.ok === false && failed.data.exitCode === 3 && String(failed.data.stderr).includes("oops"),
    failed.data,
  );

  const timed = await callAgentTool("agent_exec", { agent: "E2E-01", command: "sleep 3", timeoutMs: 500 });
  check(
    "agent_exec timeout kills the process quickly",
    timed.isError === true &&
      String(timed.data.error ?? "").match(/timed out|cancelled/) !== null &&
      Number(timed.data.durationMs) < 3_000,
    timed.data,
  );

  // -------------------------------------------------------------------------
  // Real agent: files (list/read/write + upload/download with sha256)
  // -------------------------------------------------------------------------
  console.log("e2e: exercising file tools against the real agent");
  const fsDir = mkdtempSync(join(tmpdir(), "mrc-e2e-fs-"));
  const helloPath = join(fsDir, "notes", "hello.txt");

  const writeRes = await callAgentTool("agent_fs_write", {
    agent: "E2E-01",
    path: helloPath,
    content: "hello file",
    mkdirs: true,
  });
  check(
    "agent_fs_write creates dirs and returns bytes + sha256",
    writeRes.data.ok === true && writeRes.data.bytes === 10 && typeof writeRes.data.sha256 === "string",
    writeRes.data,
  );

  const readRes = await callAgentTool("agent_fs_read", { agent: "E2E-01", path: helloPath });
  check(
    "agent_fs_read returns content, eof and sha256",
    readRes.data.content === "hello file" && readRes.data.eof === true && typeof readRes.data.sha256 === "string",
    readRes.data,
  );

  const listRes = await callAgentTool("agent_fs_list", { agent: "E2E-01", path: join(fsDir, "notes") });
  check(
    "agent_fs_list shows the file",
    Array.isArray(listRes.data.entries) &&
      (listRes.data.entries as Array<{ name: string }>).some((entry) => entry.name === "hello.txt"),
    listRes.data,
  );

  const sourceBin = join(fsDir, "up.bin");
  const payload = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  writeFileSync(sourceBin, payload);

  const uploadRes = await callAgentTool("agent_fs_upload", {
    agent: "E2E-01",
    localPath: sourceBin,
    remotePath: join(fsDir, "remote.bin"),
  });
  check(
    "agent_fs_upload reports ok, size and sha256",
    uploadRes.data.ok === true && uploadRes.data.bytes === payload.length && typeof uploadRes.data.sha256 === "string",
    uploadRes.data,
  );

  const downloadRes = await callAgentTool("agent_fs_download", {
    agent: "E2E-01",
    remotePath: join(fsDir, "remote.bin"),
    localPath: join(fsDir, "down.bin"),
  });
  check(
    "agent_fs_download round trips the same sha256",
    downloadRes.data.ok === true &&
      downloadRes.data.bytes === payload.length &&
      downloadRes.data.sha256 === uploadRes.data.sha256,
    { up: uploadRes.data, down: downloadRes.data },
  );

  const missingRes = await callAgentTool("agent_fs_read", { agent: "E2E-01", path: join(fsDir, "nope.txt") });
  check(
    "agent_fs_read reports missing files as an error",
    missingRes.isError === true && String(missingRes.data.error ?? "").includes("ENOENT"),
    missingRes.data,
  );

  // -------------------------------------------------------------------------
  // Real agent: inventory, processes and screenshot
  // -------------------------------------------------------------------------
  console.log("e2e: exercising inventory/process/screenshot tools");
  const infoRes = await callAgentTool("agent_info", { agent: "E2E-01" });
  check(
    "agent_info returns host, cpu and disks",
    typeof infoRes.data.host === "string" &&
      Number((infoRes.data.cpu as { cores?: number } | undefined)?.cores ?? 0) > 0 &&
      Array.isArray(infoRes.data.disks),
    infoRes.data,
  );

  const psRes = await callAgentTool("agent_ps_list", { agent: "E2E-01", top: 500, sort: "pid" });
  const psProcesses = (psRes.data.processes ?? []) as Array<{ pid: number; name: string }>;
  check(
    "agent_ps_list returns processes with pids",
    psProcesses.length > 0 && psProcesses.every((proc) => typeof proc.pid === "number"),
    { total: psRes.data.total, sample: psProcesses.slice(0, 3) },
  );

  const spawned = await callAgentTool("agent_exec", {
    agent: "E2E-01",
    command: "sh -c 'sleep 45 >/dev/null 2>&1 & echo pid:$!'",
  });
  const remotePid = Number(/pid:(\d+)/.exec(String(spawned.data.stdout ?? ""))?.[1] ?? 0);
  check("spawned a remote sleep process to kill", Number.isInteger(remotePid) && remotePid > 0, spawned.data);

  const killRes = await callAgentTool("agent_ps_kill", { agent: "E2E-01", pid: remotePid });
  check(
    "agent_ps_kill reports the killed process",
    killRes.isError === false && Number(killRes.data.killedCount) >= 1,
    killRes.data,
  );

  // A killed orphan may linger as a zombie when PID 1 does not reap (e.g. CI
  // containers), so both "gone" and state Z count as dead.
  const probe = await callAgentTool("agent_exec", {
    agent: "E2E-01",
    command: `if [ -e /proc/${remotePid} ]; then awk '{print "state:" $3}' /proc/${remotePid}/stat; else echo state:gone; fi`,
  });
  check(
    "killed process is gone or a zombie",
    /state:(gone|Z)/.test(String(probe.data.stdout ?? "")),
    probe.data,
  );

  const shot = await callAgentTool("agent_screenshot", { agent: "E2E-01" });
  const shotWorked = shot.isError === false && typeof shot.data.localPath === "string";
  const shotHeadless =
    shot.isError === true &&
    /no interactive session|no graphical display|no capture tool/.test(String(shot.data.text ?? shot.data.error ?? ""));
  check("agent_screenshot captures or reports a clear headless error", shotWorked || shotHeadless, shot.data);

  // -------------------------------------------------------------------------
  // Concurrent jobs across two agents (fake + real)
  // -------------------------------------------------------------------------
  console.log("e2e: running concurrent jobs against FAKE-01 and E2E-01");
  const concurrent = await Promise.all([
    callAgentTool("agent_exec", { agent: "FAKE-01", command: "echo a" }),
    callAgentTool("agent_exec", { agent: "FAKE-01", command: "echo b" }),
    callAgentTool("agent_exec", { agent: "FAKE-01", command: "echo c" }),
    callAgentTool("agent_exec", { agent: "E2E-01", command: "echo x" }),
    callAgentTool("agent_info", { agent: "E2E-01" }),
    callAgentTool("agent_ps_list", { agent: "E2E-01", top: 10 }),
  ]);
  const [cFakeA, cFakeB, cFakeC, cExec, cInfo, cPs] = concurrent;
  check(
    "concurrent jobs across 2 agents all succeed",
    concurrent.every((res) => res.isError === false) &&
      cFakeA.data.ok === true &&
      cFakeB.data.ok === true &&
      cFakeC.data.ok === true &&
      cExec.data.ok === true &&
      typeof cInfo.data.host === "string" &&
      Array.isArray(cPs.data.processes),
    concurrent.map((res) => ({ isError: res.isError, ok: res.data.ok })),
  );
} catch (err) {
  failures++;
  console.error("e2e error:", err);
} finally {
  for (const agent of agents) agent.stop();
  agentProc?.kill();
  try {
    await client.close();
  } catch {
    // already closed
  }
}

console.log(failures === 0 ? "\ne2e: PASS" : `\ne2e: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
