import { expect, test } from "bun:test";
import { normalizeServerUrl } from "../../agent/src/first-run.ts";

test("normalizeServerUrl turns a bare IP into a WebSocket URL", () => {
  expect(normalizeServerUrl("192.168.1.50")).toBe("ws://192.168.1.50:8787");
  expect(normalizeServerUrl("  192.168.1.50  ")).toBe("ws://192.168.1.50:8787");
  expect(normalizeServerUrl("oficina.local")).toBe("ws://oficina.local:8787");
});

test("normalizeServerUrl keeps an explicit scheme, port or path", () => {
  expect(normalizeServerUrl("192.168.1.50:9000")).toBe("ws://192.168.1.50:9000");
  expect(normalizeServerUrl("ws://192.168.1.50")).toBe("ws://192.168.1.50:8787");
  expect(normalizeServerUrl("wss://agent.example.com")).toBe("wss://agent.example.com:8787");
  expect(normalizeServerUrl("ws://host:8787/custom")).toBe("ws://host:8787/custom");
  expect(normalizeServerUrl("http://192.168.1.50:8788")).toBe("http://192.168.1.50:8788");
});

test("normalizeServerUrl leaves empty input untouched", () => {
  expect(normalizeServerUrl("")).toBe("");
  expect(normalizeServerUrl("   ")).toBe("");
});
