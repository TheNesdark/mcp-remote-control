import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMsg } from "@mrc/shared";
import type { ServerConfig } from "../../server/src/config.ts";
import { createService, type Service } from "../../server/src/service.ts";
import { downloadFile, uploadFile } from "../../server/src/transfers.ts";
import { AgentConnection } from "./connection.ts";
import { JobManager } from "./jobs.ts";

const TOKEN = "test-token";

function testConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    usingDefaultToken: false,
    heartbeatIntervalMs: 300,
    heartbeatTimeoutMs: 1_500,
    defaultJobTimeoutMs: 5_000,
    maxJobOutputBytes: 1_000_000,
    logLevel: "error",
  };
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await Bun.sleep(50);
  }
  throw new Error("waitFor timed out");
}

function startAgent(service: Service): { connection: AgentConnection; jobs: JobManager } {
  let connection: AgentConnection | null = null;
  const jobs = new JobManager({
    send: (msg: AgentMsg) => connection?.send(msg),
    log: () => {},
    maxConcurrent: 2,
  });
  connection = new AgentConnection({
    serverUrl: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "AI-01",
    host: "test-host",
    os: "Linux test",
    version: "0.2.0",
    tags: ["test"],
    caps: ["exec"],
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

test("unsupported job types get a clear error", async () => {
  const service = createService(testConfig());
  const { connection } = startAgent(service);
  try {
    await waitFor(() => (service.hub.list()[0]?.online ? true : undefined));

    const outcome = await service.hub.request("AI-01", "screenshot", {});
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/unsupported job type/);
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
    await waitFor(() => (service.hub.list()[0]?.online === true ? true : undefined), 8_000);
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
