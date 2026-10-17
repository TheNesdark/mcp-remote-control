import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeAgent } from "../../scripts/fake-agent.ts";
import { testServerConfig } from "../../scripts/test-utils.ts";
import { createService, type Service } from "../../server/src/service.ts";

const TOKEN = "auto-update-token";
let service: Service | null = null;
let agent: FakeAgent | null = null;
let dir = "";

afterEach(() => {
  agent?.stop();
  agent = null;
  service?.close();
  service = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function startWith(overrides: Record<string, unknown>): Service {
  service = createService(testServerConfig(TOKEN, overrides as never));
  return service;
}

test("welcome omits update fields when the server publishes nothing", async () => {
  const svc = startWith({});
  agent = new FakeAgent({ url: svc.wsUrl, token: TOKEN, name: "AU-0", onLog: () => {} });
  const welcome = await agent.start();
  expect(welcome.latestAgentVersion).toBeUndefined();
  expect(welcome.agentBinaryUrl).toBeUndefined();
});

test("welcome advertises the published agent version and binary", async () => {
  dir = mkdtempSync(join(tmpdir(), "mrc-au-srv-"));
  const binary = join(dir, "rc-agent.exe");
  await Bun.write(binary, "fake-windows-binary");

  const svc = startWith({
    agentLatestVersion: "0.9.0",
    agentBinaryPath: binary,
    agentBinarySha256: "c".repeat(64),
  });

  agent = new FakeAgent({ url: svc.wsUrl, token: TOKEN, name: "AU-1", onLog: () => {} });
  const welcome = await agent.start();
  expect(welcome.latestAgentVersion).toBe("0.9.0");
  expect(welcome.agentBinaryUrl).toBe("/agent/latest.exe");
  expect(welcome.agentBinarySha256).toBe("c".repeat(64));

  // and the hub really serves it
  const res = await fetch(`http://127.0.0.1:${svc.port}/agent/latest.exe`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("fake-windows-binary");
});

test("the sha256 is computed from the binary when MRC_AGENT_BINARY_SHA256 is unset", async () => {
  dir = mkdtempSync(join(tmpdir(), "mrc-au-sha-"));
  const binary = join(dir, "rc-agent.exe");
  const content = "rebuilt-on-every-deploy";
  await Bun.write(binary, content);

  const svc = startWith({ agentLatestVersion: "0.9.0", agentBinaryPath: binary });
  agent = new FakeAgent({ url: svc.wsUrl, token: TOKEN, name: "AU-3", onLog: () => {} });
  const welcome = await agent.start();
  expect(welcome.agentBinarySha256).toBe(createHash("sha256").update(content).digest("hex"));
});

test("the binary endpoint 404s when no build is configured", async () => {
  const svc = startWith({});
  const res = await fetch(`http://127.0.0.1:${svc.port}/agent/latest.exe`);
  expect(res.status).toBe(404);
});

test("an absolute MRC_AGENT_BINARY_URL overrides the local endpoint", async () => {
  const svc = startWith({
    agentLatestVersion: "0.9.0",
    agentBinaryUrl: "https://cdn.example/rc-agent.exe",
  });
  agent = new FakeAgent({ url: svc.wsUrl, token: TOKEN, name: "AU-2", onLog: () => {} });
  const welcome = await agent.start();
  expect(welcome.agentBinaryUrl).toBe("https://cdn.example/rc-agent.exe");
});
