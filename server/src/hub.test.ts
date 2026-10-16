import { afterEach, expect, test } from "bun:test";
import { FakeAgent } from "../../scripts/fake-agent.ts";
import type { ServerConfig } from "./config.ts";
import { createService, type Service } from "./service.ts";

const TOKEN = "test-token";

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    usingDefaultToken: false,
    heartbeatIntervalMs: 300,
    heartbeatTimeoutMs: 1_500,
    defaultJobTimeoutMs: 2_000,
    maxJobOutputBytes: 1_000_000,
    screenshotDir: "/tmp/mrc-test-screenshots",
    logLevel: "error",
    ...overrides,
  };
}

let service: Service | null = null;
const agents: FakeAgent[] = [];

function makeService(overrides: Partial<ServerConfig> = {}): Service {
  service = createService(testConfig(overrides));
  return service;
}

function makeAgent(overrides: Partial<ConstructorParameters<typeof FakeAgent>[0]> = {}): FakeAgent {
  if (!service) throw new Error("service not started");
  const agent = new FakeAgent({
    url: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "T-01",
    onLog: () => {},
    ...overrides,
  });
  agents.push(agent);
  return agent;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error("waitFor timed out");
}

afterEach(() => {
  for (const agent of agents) agent.stop();
  agents.length = 0;
  service?.close();
  service = null;
});

test("agent connects, gets a welcome and shows up in list()", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "T-01" });
  const welcome = await agent.start();

  expect(welcome.agentId.startsWith("ag_")).toBe(true);
  expect(welcome.heartbeatIntervalMs).toBe(300);

  const listed = svc.hub.list();
  expect(listed.length).toBe(1);
  expect(listed[0]!.name).toBe("T-01");
  expect(listed[0]!.online).toBe(true);
  expect(listed[0]!.paused).toBe(false);
});

test("bad token is rejected before welcome", async () => {
  const svc = makeService();
  const agent = makeAgent({ token: "wrong-token", name: "T-BAD" });

  await expect(agent.start(3_000)).rejects.toThrow(/closed before welcome/);
  expect(agent.lastError?.code).toBe("auth_failed");
  expect(svc.hub.list().length).toBe(0);
});

test("presence pause/resume is reflected in list()", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "T-02" });
  await agent.start();

  agent.pause();
  await waitFor(() => (svc.hub.list()[0]?.paused ? true : undefined));
  expect(svc.hub.list()[0]!.paused).toBe(true);

  agent.resume();
  await waitFor(() => (svc.hub.list()[0]?.paused === false ? true : undefined));
  expect(svc.hub.list()[0]!.paused).toBe(false);
});

test("request resolves with echoed output", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "T-03" });
  await agent.start();

  const outcome = await svc.hub.request("T-03", "exec", { echo: "hello world" });
  expect(outcome.ok).toBe(true);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.stdout).toBe("hello world\n");
  expect(outcome.truncated).toBe(false);
  expect(agent.jobsSeen.length).toBe(1);
});

test("request to a paused agent is rejected locally", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "T-04", paused: true });
  await agent.start();

  await expect(svc.hub.request("T-04", "exec", { echo: "x" })).rejects.toThrow(/paused locally/);
});

test("request to an unknown agent is rejected", async () => {
  const svc = makeService();
  await expect(svc.hub.request("ghost", "exec", {})).rejects.toThrow(/Unknown agent/);
});

test("job timeout sends cancel and settles with the cancel ack", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "T-05" });
  await agent.start();

  const outcome = await svc.hub.request("T-05", "exec", { echo: "slow", sleepMs: 10_000 }, 300);
  expect(outcome.ok).toBe(false);
  expect(outcome.error).toMatch(/cancelled|timed out/);
  expect(agent.cancelledJobs.length).toBe(1);
});

test("disconnect during a pending job settles it with an error", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "T-06" });
  await agent.start();

  const promise = svc.hub.request("T-06", "exec", { echo: "bye", sleepMs: 10_000 }, 60_000);
  await waitFor(() => (agent.jobsSeen.length === 1 ? true : undefined));
  agent.stop();

  const outcome = await promise;
  expect(outcome.ok).toBe(false);
  expect(outcome.error).toMatch(/disconnected/);
});

test("output larger than the cap is truncated", async () => {
  const svc = makeService({ maxJobOutputBytes: 32 });
  const agent = makeAgent({ name: "T-07" });
  await agent.start();

  const outcome = await svc.hub.request("T-07", "exec", { echo: "x".repeat(200) });
  expect(outcome.truncated).toBe(true);
  expect(outcome.stdout.length).toBeLessThanOrEqual(33);
});

test("heartbeat sweeper drops silent agents", async () => {
  const svc = makeService({ heartbeatIntervalMs: 200, heartbeatTimeoutMs: 700 });
  const agent = makeAgent({ name: "T-08", silent: true });
  await agent.start();

  await waitFor(() => (svc.hub.list()[0]?.online === false ? true : undefined), 4_000);
  expect(svc.hub.list()[0]!.online).toBe(false);
});

test("reconnecting with the same agentId reattaches the record", async () => {
  const svc = makeService();
  const first = makeAgent({ name: "T-09", agentId: "ag_fixed01" });
  const welcome = await first.start();
  expect(welcome.agentId).toBe("ag_fixed01");
  first.stop();
  await waitFor(() => (svc.hub.list()[0]?.online === false ? true : undefined));

  const second = makeAgent({ name: "T-09", agentId: "ag_fixed01" });
  await second.start();
  const listed = svc.hub.list();
  expect(listed.length).toBe(1);
  expect(listed[0]!.online).toBe(true);
});
