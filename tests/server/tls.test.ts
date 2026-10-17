import { afterAll, afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { FakeAgent } from "../../scripts/fake-agent.ts";
import { testServerConfig } from "../../scripts/test-utils.ts";
import { createService, type Service } from "../../server/src/service.ts";

const TOKEN = "tls-token";
const FIXTURES = join(import.meta.dir, "..", "fixtures");
const CERT = join(FIXTURES, "tls-test.crt");
const KEY = join(FIXTURES, "tls-test.key");

let service: Service | null = null;
const agents: FakeAgent[] = [];

function cleanup() {
  for (const agent of agents) agent.stop();
  agents.length = 0;
  service?.close();
  service = null;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}
afterEach(cleanup);
afterAll(cleanup);

test("tls requires cert and key together", () => {
  expect(() => createService(testServerConfig(TOKEN, { tlsCertPath: CERT } as never))).toThrow(/must be set together/);
});

test("service serves wss:// when tls is configured", async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed fixture, same as MRC_TLS_INSECURE=1
  service = createService(testServerConfig(TOKEN, { tlsCertPath: CERT, tlsKeyPath: KEY }));
  expect(service.wsUrl.startsWith("wss://")).toBe(true);

  const agent = new FakeAgent({ url: service.wsUrl, token: TOKEN, name: "TLS-01", onLog: () => {} });
  agents.push(agent);
  await agent.start(); // resolves on `welcome`: connected over wss://
  expect(agent.connected).toBe(true);

  // Plain ws:// against the same port must fail (the face really is TLS).
  const plain = new WebSocket(`ws://127.0.0.1:${service.port}/agent`);
  const failed = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 4_000);
    plain.onerror = () => { clearTimeout(t); resolve(true); };
    plain.onopen = () => { clearTimeout(t); resolve(false); };
  });
  expect(failed).toBe(true);
});
