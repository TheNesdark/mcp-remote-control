import { afterEach, expect, test } from "bun:test";
import { FakeAgent } from "../../scripts/fake-agent.ts";
import { readJsonLines, testServerConfig, waitFor } from "../../scripts/test-utils.ts";
import type { ServerConfig } from "../../server/src/config.ts";
import { createService, type Service } from "../../server/src/service.ts";

const TOKEN = "test-token";

let service: Service | null = null;
const agents: FakeAgent[] = [];

function makeService(overrides: Partial<ServerConfig> = {}): Service {
  service = createService(testServerConfig(TOKEN, overrides));
  return service;
}

function makeAgent(overrides: Partial<ConstructorParameters<typeof FakeAgent>[0]> = {}): FakeAgent {
  if (!service) throw new Error("service not started");
  const agent = new FakeAgent({
    url: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "A-01",
    onLog: () => {},
    ...overrides,
  });
  agents.push(agent);
  return agent;
}

afterEach(() => {
  for (const agent of agents) agent.stop();
  agents.length = 0;
  service?.close();
  service = null;
});

test("requestAsync returns a handle and jobStatus follows the job to completion", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "A-01" });
  await agent.start();

  const handle = svc.hub.requestAsync("A-01", "exec", { echo: "hello", sleepMs: 200 });
  expect(handle.jobId.length).toBeGreaterThan(0);
  expect(handle.agentName).toBe("A-01");
  expect(handle.jobType).toBe("exec");
  expect(Number.isNaN(Date.parse(handle.startedAt))).toBe(false);

  // The agent streams stdout before the result, so it is visible while running.
  const running = await waitFor(() => {
    const status = svc.hub.jobStatus(handle.jobId);
    return status?.stdout === "hello\n" ? status : undefined;
  });
  expect(running.state).toBe("running");
  expect(running.exitCode).toBeNull();
  expect(running.finishedAt).toBeNull();

  const done = await waitFor(() => {
    const status = svc.hub.jobStatus(handle.jobId);
    return status && status.state !== "running" ? status : undefined;
  });
  expect(done.state).toBe("ok");
  expect(done.exitCode).toBe(0);
  expect(done.stdout).toBe("hello\n");
  expect(done.finishedAt).not.toBeNull();
  expect(done.durationMs).toBeGreaterThanOrEqual(0);
});

test("a failed async job keeps its error and exit code", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "A-02" });
  await agent.start();

  const handle = svc.hub.requestAsync("A-02", "exec", { fail: true });
  const status = await waitFor(() => {
    const current = svc.hub.jobStatus(handle.jobId);
    return current && current.state !== "running" ? current : undefined;
  });
  expect(status.state).toBe("failed");
  expect(status.exitCode).toBe(1);
  expect(status.error).toBe("requested failure");
});

test("jobList shows running jobs of any kind but only retains async ones", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "A-03" });
  await agent.start();

  const sync = svc.hub.request("A-03", "exec", { echo: "sync", sleepMs: 300 }, 5_000);
  await waitFor(() => (svc.hub.jobList().length === 1 ? true : undefined));
  expect(svc.hub.jobList()[0]!.state).toBe("running");
  await sync;
  expect(svc.hub.jobList().length).toBe(0);

  const async_ = svc.hub.requestAsync("A-03", "exec", { echo: "async" });
  await waitFor(() => {
    const listed = svc.hub.jobList({ state: "ok" });
    return listed.some((job) => job.jobId === async_.jobId) ? listed : undefined;
  });
  expect(svc.hub.jobList({ agent: "a-03" }).length).toBe(1);
  expect(svc.hub.jobList({ agent: "a-03" })[0]!.jobType).toBe("exec");
  expect(svc.hub.jobList({ agent: "nobody" }).length).toBe(0);
  expect(svc.hub.jobList({ state: "running" }).length).toBe(0);
});

test("jobCancel stops a running async job and records the cancellation", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "A-04" });
  await agent.start();

  const handle = svc.hub.requestAsync("A-04", "exec", { echo: "long", sleepMs: 10_000 });
  await waitFor(() => (agent.jobsSeen.length === 1 ? true : undefined));

  const result = svc.hub.jobCancel(handle.jobId);
  expect(result.cancelRequested).toBe(true);
  await waitFor(() => (agent.cancelledJobs.includes(handle.jobId) ? true : undefined));

  const status = await waitFor(() => {
    const current = svc.hub.jobStatus(handle.jobId);
    return current && current.state !== "running" ? current : undefined;
  });
  expect(status.state).toBe("failed");
  expect(status.error).toContain("cancelled");
});

test("cancelling a finished job is a no-op", async () => {
  const svc = makeService();
  const agent = makeAgent({ name: "A-05" });
  await agent.start();

  const handle = svc.hub.requestAsync("A-05", "exec", { echo: "quick" });
  await waitFor(() => (svc.hub.jobStatus(handle.jobId)?.state === "ok" ? true : undefined));

  const result = svc.hub.jobCancel(handle.jobId);
  expect(result.cancelRequested).toBe(false);
  expect(result.status?.state).toBe("ok");
});

test("unknown job ids report unknown_job instead of throwing in status", async () => {
  const svc = makeService();
  expect(svc.hub.jobStatus("nope")).toBeNull();
  expect(() => svc.hub.jobCancel("nope")).toThrow(/Unknown job/);
});

test("the job history is bounded by maxRetainedJobs", async () => {
  const svc = makeService({ maxRetainedJobs: 2 });
  const agent = makeAgent({ name: "A-06" });
  await agent.start();

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const handle = svc.hub.requestAsync("A-06", "exec", { echo: `n${i}` });
    ids.push(handle.jobId);
    await waitFor(() => (svc.hub.jobStatus(handle.jobId)?.state === "ok" ? true : undefined));
  }

  expect(svc.hub.jobStatus(ids[0]!)).toBeNull();
  expect(svc.hub.jobStatus(ids[1]!)).not.toBeNull();
  expect(svc.hub.jobStatus(ids[2]!)).not.toBeNull();
});

test("an async job settles into the audit trail exactly once", async () => {
  const svc = makeService();
  const name = `A-audit-${Date.now().toString(36)}`;
  const agent = makeAgent({ name });
  await agent.start();

  const handle = svc.hub.requestAsync(name, "exec", { echo: "audited" }, undefined, {
    op: "agent_exec_async",
    params: { agent: name, command: "echo audited" },
  });
  await waitFor(() => (svc.hub.jobStatus(handle.jobId)?.state === "ok" ? true : undefined));

  const entries = (await readJsonLines("/tmp/mrc-test-audit.jsonl")) as Array<Record<string, unknown>>;
  const matches = entries.filter((entry) => entry.op === "agent_exec_async" && entry.agent === name);
  expect(matches.length).toBe(1);
  expect(matches[0]).toMatchObject({ actor: "tool", ok: true });
});

test("a rejected async job is audited without ever reaching the agent", async () => {
  const svc = makeService();
  const name = `A-ghost-${Date.now().toString(36)}`;
  expect(() => svc.hub.requestAsync(name, "exec", { echo: "nope" }, undefined, { op: "agent_exec_async" })).toThrow(
    /Unknown agent/,
  );
  const entries = (await readJsonLines("/tmp/mrc-test-audit.jsonl")) as Array<Record<string, unknown>>;
  const rejected = entries.filter((entry) => entry.op === "agent_exec_async" && entry.agent === name);
  expect(rejected.length).toBe(1);
  expect(rejected[0]).toMatchObject({ actor: "tool", ok: false });
});
