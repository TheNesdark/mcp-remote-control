import { expect, test } from "bun:test";
import type { AgentMsg } from "@mrc/shared";
import type { ServerConfig } from "../../server/src/config.ts";
import { createService, type Service } from "../../server/src/service.ts";
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
