import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrayIntegration } from "./tray.ts";

/**
 * Fake tray helper: speaks the same JSON-lines protocol as tray.ps1, records
 * every state line it receives and emits actions once, so we can test the Bun
 * side without Windows.
 */
const FAKE_HELPER = String.raw`
const { appendFileSync } = require("node:fs");
const outFile = process.env.FAKE_TRAY_OUT;
let buffer = "";
let sent = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    appendFileSync(outFile, line + "\n");
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "exit") process.exit(0);
    if (msg.type === "state" && msg.state === "connected" && !sent) {
      sent = true;
      console.log(JSON.stringify({ type: "action", action: "toggle" }));
      console.log(JSON.stringify({ type: "action", action: "autostart", enabled: true }));
    }
  }
});
`;

function waitFor(fn: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("tray integration exchanges state and actions with the helper", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mrc-tray-"));
  const helperPath = join(dir, "fake-tray.js");
  const outFile = join(dir, "states.jsonl");
  await Bun.write(helperPath, FAKE_HELPER);

  const toggles: number[] = [];
  const autostart: boolean[] = [];
  const tray = new TrayIntegration({
    enabled: true,
    label: "PC-01",
    detail: "ws://127.0.0.1:8787",
    logDir: join(dir, "logs"),
    autostart: false,
    helperCommand: ["bun", helperPath],
    onToggle: () => toggles.push(Date.now()),
    onAutostart: (enabled) => autostart.push(enabled),
    log: () => {},
    // the fake helper reads the output path from the environment
    // (see TrayIntegration: spawn inherits process.env)
  });
  process.env.FAKE_TRAY_OUT = outFile;

  try {
    tray.start();
    expect(tray.isRunning).toBe(true);
    tray.setState("connected");
    await waitFor(() => toggles.length >= 1 && autostart.length >= 1);

    expect(toggles.length).toBe(1);
    expect(autostart).toEqual([true]);

    const lines = readFileSync(outFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const connectedState = lines.find((line) => line.type === "state" && line.state === "connected");
    expect(connectedState).toBeDefined();
    expect(connectedState!.label).toBe("PC-01");
    expect(connectedState!.detail).toBe("ws://127.0.0.1:8787");
    expect(connectedState!.logDir).toBe(join(dir, "logs"));

    await tray.stop();
    expect(tray.isRunning).toBe(false);
  } finally {
    delete process.env.FAKE_TRAY_OUT;
  }
});

test("tray integration is a no-op when disabled", async () => {
  const tray = new TrayIntegration({ enabled: false, label: "x", detail: "", logDir: "", autostart: false });
  tray.start();
  expect(tray.isRunning).toBe(false);
  tray.setState("connected");
  await tray.stop();
});
