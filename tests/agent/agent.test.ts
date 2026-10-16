import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMsg } from "@mrc/shared";
import { testServerConfig, waitFor } from "../../scripts/test-utils.ts";
import type { ServerConfig } from "../../server/src/config.ts";
import { createService, type Service } from "../../server/src/service.ts";
import { downloadFile, uploadFile } from "../../server/src/transfers.ts";
import { AgentConnection } from "../../agent/src/connection.ts";
import { JobManager } from "../../agent/src/jobs.ts";

const TOKEN = "test-token";

function testConfig(): ServerConfig {
  return testServerConfig(TOKEN, { defaultJobTimeoutMs: 5_000 });
}

function startAgent(service: Service): { connection: AgentConnection; jobs: JobManager } {
  let connection: AgentConnection | null = null;
  const jobs = new JobManager({
    send: (msg: AgentMsg) => connection?.send(msg),
    log: () => {},
    maxConcurrent: 2,
    context: () => ({
      name: "AI-01",
      version: "0.3.0-test",
      agentId: service.hub.list()[0]?.id ?? null,
      server: "ws://127.0.0.1:0",
      caps: ["exec", "fs", "info", "ps", "screenshot"],
    }),
  });
  connection = new AgentConnection({
    serverUrl: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "AI-01",
    host: "test-host",
    os: "Linux test",
    version: "0.3.0",
    tags: ["test"],
    caps: ["exec", "fs", "info", "ps", "screenshot"],
    onJobRequest: (msg) => jobs.handleRequest(msg),
    onJobCancel: (msg) => jobs.handleCancel(msg),
    log: () => {},
  });
  connection.start();
  return { connection, jobs };
}

test("real agent executes an exec job end to end", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const outcome = await service.hub.request("AI-01", "exec", { command: "printf 'hi there'" });
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("hi there");
    expect(outcome.jobId.length).toBeGreaterThan(0);
  } finally {
    connection.stop();
    service.close();
  }
});

test("real agent reports exit codes and stderr", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const failed = await service.hub.request("AI-01", "exec", { command: "printf 'nope' 1>&2; exit 4" });
    expect(failed.ok).toBe(false);
    expect(failed.exitCode).toBe(4);
    expect(failed.stderr).toBe("nope");
  } finally {
    connection.stop();
    service.close();
  }
});

test("job timeout on the server settles while the agent kills the process", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const outcome = await service.hub.request("AI-01", "exec", { command: "sleep 5" }, 500);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/timed out|cancelled/);
    expect(outcome.durationMs).toBeLessThan(4_000);
  } finally {
    connection.stop();
    service.close();
  }
});

test("invalid job params get a clear error from the agent", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const outcome = await service.hub.request("AI-01", "ps.kill", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/exactly one of 'pid' or 'name'/);
  } finally {
    connection.stop();
    service.close();
  }
});

test("agent reconnects automatically after a dropped connection", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    // Drop the socket from the server side, like a network blip would.
    expect(service.hub.disconnect("AI-01")).toBe(true);
    await waitFor(() => (service.hub.list()[0]?.online === false ? true : undefined));

    // The agent retries with backoff and reattaches with the same agentId.
    await waitFor(() => (service.hub.list()[0]?.online === true ? true : undefined), { timeoutMs: 8_000 });
    expect(service.hub.list().length).toBe(1);

    const outcome = await service.hub.request("AI-01", "exec", { command: "printf reconnected" });
    expect(outcome.ok).toBe(true);
    expect(outcome.stdout).toBe("reconnected");
  } finally {
    connection.stop();
    service.close();
  }
});

test("fs jobs round trip through the hub", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  const dir = mkdtempSync(join(tmpdir(), "mrc-agent-fs-"));
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const file = join(dir, "notes", "a.txt");
    const write = await service.hub.request("AI-01", "fs.write", {
      path: file,
      data: Buffer.from("hola").toString("base64"),
      mode: "overwrite",
      mkdirs: true,
    });
    expect(write.ok).toBe(true);
    expect(write.meta?.bytesWritten).toBe(4);

    const read = await service.hub.request("AI-01", "fs.read", { path: file, offset: 0, length: 1024 });
    expect(read.ok).toBe(true);
    expect(Buffer.from(read.stdout, "base64").toString()).toBe("hola");
    expect(read.meta?.eof).toBe(true);

    const list = await service.hub.request("AI-01", "fs.list", { path: join(dir, "notes"), limit: 100 });
    expect(list.ok).toBe(true);
    const parsed = JSON.parse(list.stdout) as { entries: Array<{ name: string }> };
    expect(parsed.entries.some((entry) => entry.name === "a.txt")).toBe(true);

    const hash = await service.hub.request("AI-01", "fs.hash", { path: file });
    expect(hash.ok).toBe(true);
    expect(hash.meta?.sha256).toBe(createHash("sha256").update("hola").digest("hex"));

    const missing = await service.hub.request("AI-01", "fs.read", { path: join(dir, "nope.txt"), offset: 0, length: 16 });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/ENOENT/);
  } finally {
    connection.stop();
    service.close();
  }
});

test("50 MB binary upload/download round trip with matching sha256 (F2 acceptance)", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  const localDir = mkdtempSync(join(tmpdir(), "mrc-transfer-"));
  const remoteDir = mkdtempSync(join(tmpdir(), "mrc-transfer-remote-"));
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const size = 50 * 1024 * 1024;
    const source = join(localDir, "big.bin");
    const payload = Buffer.alloc(size);
    for (let offset = 0; offset < size; offset += 1024) {
      payload.fill((offset / 1024) % 256, offset, Math.min(offset + 1024, size));
    }
    writeFileSync(source, payload);
    const sourceSha = createHash("sha256").update(payload).digest("hex");

    const remote = join(remoteDir, "big.bin");
    const upload = await uploadFile(service.hub, "AI-01", source, remote);
    expect(upload.bytes).toBe(size);
    expect(upload.sha256).toBe(sourceSha);

    const destination = join(localDir, "big-down.bin");
    const download = await downloadFile(service.hub, "AI-01", remote, destination);
    expect(download.bytes).toBe(size);
    expect(download.sha256).toBe(sourceSha);

    const downloaded = await Bun.file(destination).arrayBuffer();
    expect(createHash("sha256").update(new Uint8Array(downloaded)).digest("hex")).toBe(sourceSha);
  } finally {
    connection.stop();
    service.close();
  }
}, 180_000);

// ---------------------------------------------------------------------------
// F3: inventory, processes, screenshots, reconnect
// ---------------------------------------------------------------------------

test("agent_info reports the host inventory through the hub", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const outcome = await service.hub.request("AI-01", "info", {});
    expect(outcome.ok).toBe(true);
    const info = JSON.parse(outcome.stdout) as {
      agent: { name: string; version: string; caps: string[] };
      host: string;
      os: { platform: string };
      cpu: { cores: number };
      memory: { totalBytes: number };
      ips: unknown[];
      disks: unknown[];
    };
    expect(info.host.length).toBeGreaterThan(0);
    expect(info.os.platform).toBe(process.platform);
    expect(info.cpu.cores).toBeGreaterThan(0);
    expect(info.memory.totalBytes).toBeGreaterThan(0);
    expect(Array.isArray(info.ips)).toBe(true);
    expect(Array.isArray(info.disks)).toBe(true);
    expect(info.agent.name).toBe("AI-01");
    expect(info.agent.caps).toContain("info");
  } finally {
    connection.stop();
    service.close();
  }
});

test("ps.list and ps.kill work end to end through the hub", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  const victim = Bun.spawn({ cmd: ["sleep", "60"], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const listed = await service.hub.request("AI-01", "ps.list", { filter: "sleep", top: 50, sort: "pid" });
    expect(listed.ok).toBe(true);
    const payload = JSON.parse(listed.stdout) as { processes: Array<{ pid: number; name: string }> };
    expect(payload.processes.some((proc) => proc.pid === victim.pid)).toBe(true);

    const killed = await service.hub.request("AI-01", "ps.kill", { pid: victim.pid, force: true, tree: true });
    expect(killed.ok).toBe(true);
    expect(killed.meta?.killedCount).toBeGreaterThanOrEqual(1);
    const exited = await Promise.race([victim.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
    expect(exited).toBe(true);
  } finally {
    try {
      victim.kill();
    } catch {
      // already gone
    }
    connection.stop();
    service.close();
  }
});

test("ps.kill refuses to kill the agent itself", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const outcome = await service.hub.request("AI-01", "ps.kill", { pid: process.pid, force: true, tree: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/own process/);
  } finally {
    connection.stop();
    service.close();
  }
});

test("screenshot reports a clear error on headless hosts", async () => {
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return; // graphical dev host: skip
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const outcome = await service.hub.request("AI-01", "screenshot", { format: "png", quality: 80 });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no interactive session|no capture tool/);
  } finally {
    connection.stop();
    service.close();
  }
});

test("reconnectNow() reconnects without waiting for the backoff", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    expect(service.hub.disconnect("AI-01")).toBe(true);
    await waitFor(() => (service.hub.list()[0]?.online === false ? true : undefined));
    await Bun.sleep(100); // let the loop enter its backoff wait

    const started = Date.now();
    connection.reconnectNow();
    await waitFor(() => (service.hub.list()[0]?.online === true ? true : undefined), { timeoutMs: 5_000 });
    // The first backoff is ~1000ms; skipping it must be much faster.
    expect(Date.now() - started).toBeLessThan(700);
  } finally {
    connection.stop();
    service.close();
  }
});

// ---------------------------------------------------------------------------
// F4: stable identity across server restarts
// ---------------------------------------------------------------------------

test("connection reports the server-assigned agent id", async () => {
  const service = createService(testConfig());
  const assigned: string[] = [];
  const connection = new AgentConnection({
    serverUrl: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "AI-ID",
    host: "test-host",
    os: "Linux test",
    version: "0.4.0",
    tags: [],
    caps: ["exec"],
    onJobRequest: () => {},
    onJobCancel: () => {},
    onIdAssigned: (id) => assigned.push(id),
    log: () => {},
  });
  try {
    connection.start();
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));
    expect(assigned.length).toBeGreaterThanOrEqual(1);
    expect(assigned[0]).toBe(service.hub.list()[0]!.id);
  } finally {
    connection.stop();
    service.close();
  }
});

test("agent reconnects with a stable id after a server restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mrc-restart-"));
  const base = { ...testConfig(), dbPath: join(dir, "mcp.db"), auditPath: join(dir, "audit.jsonl") };

  const first = createService({ ...base, port: 0 });
  const { connection } = startAgent(first);
  try {
    await waitFor(() => (first.hub.list()[0]?.online ? true : undefined));
    const agentId = first.hub.list()[0]!.id;
    expect(agentId.startsWith("ag_")).toBe(true);
    first.close();

    // Same port, same registry: the same agent process must come back alone.
    const second = createService({ ...base, port: first.port });
    try {
      await waitFor(() => (second.hub.list()[0]?.online === true ? true : undefined), { timeoutMs: 30_000 });
      expect(second.hub.list().length).toBe(1);
      expect(second.hub.list()[0]!.id).toBe(agentId);

      const info = await second.hub.request(agentId, "info", {});
      expect(info.ok).toBe(true);
      expect((JSON.parse(info.stdout) as { agent: { name: string } }).agent.name).toBe("AI-01");
    } finally {
      second.close();
    }
  } finally {
    connection.stop();
  }
}, 60_000);
