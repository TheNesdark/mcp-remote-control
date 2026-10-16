import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, parseTags } from "./settings.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mrc-settings-"));
}

test("parseTags splits, trims and caps", () => {
  expect(parseTags("oficina, dev ,,prod")).toEqual(["oficina", "dev", "prod"]);
  expect(parseTags(["a", "b"])).toEqual(["a", "b"]);
  expect(parseTags(undefined)).toEqual([]);
  expect(parseTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length).toBe(16);
});

test("loadSettings prefers CLI values over the config file", async () => {
  const dir = tempDir();
  const configPath = join(dir, "agent.json");
  writeFileSync(
    configPath,
    JSON.stringify({ name: "from-file", server: "ws://file:1", token: "file-token", tags: ["file"], paused: true }),
  );

  const settings = await loadSettings({
    configPath,
    name: "from-cli",
    server: "ws://cli:2",
    token: "cli-token",
    tags: "cli-tag",
    id: "ag_test",
  });

  expect(settings.name).toBe("from-cli");
  expect(settings.server).toBe("ws://cli:2");
  expect(settings.token).toBe("cli-token");
  expect(settings.tags).toEqual(["cli-tag"]);
  expect(settings.agentId).toBe("ag_test");
  expect(settings.paused).toBe(true); // from the file
  expect(settings.logFile).toBeNull(); // custom config path disables file logging
});

test("loadSettings falls back to the config file", async () => {
  const dir = tempDir();
  const configPath = join(dir, "agent.json");
  writeFileSync(configPath, JSON.stringify({ name: "PC-FILE", server: "ws://file:1", token: "tok", tags: ["x"] }));

  const settings = await loadSettings({ configPath });
  expect(settings.name).toBe("PC-FILE");
  expect(settings.server).toBe("ws://file:1");
  expect(settings.token).toBe("tok");
  expect(settings.tags).toEqual(["x"]);
  expect(settings.usingDefaultToken).toBe(false);
});

test("loadSettings uses the development token when nothing is configured", async () => {
  const dir = tempDir();
  const settings = await loadSettings({ configPath: join(dir, "missing.json"), name: "PC-X", server: "ws://x:1" });
  expect(settings.token).toBe("dev-token");
  expect(settings.usingDefaultToken).toBe(true);
});

test("setAgentId persists the id to the config file", async () => {
  const dir = tempDir();
  const configPath = join(dir, "agent.json");
  const settings = await loadSettings({ configPath, name: "PC-Y", server: "ws://x:1", token: "tok" });
  expect(settings.agentId).toBeUndefined();
  await settings.setAgentId("ag_persist1");
  expect(settings.agentId).toBe("ag_persist1");

  const reloaded = await loadSettings({ configPath });
  expect(reloaded.agentId).toBe("ag_persist1");
  expect(reloaded.name).toBe("PC-Y");
  expect(reloaded.token).toBe("tok");
});

test("loadSettings throws when the first-run dialog is cancelled", async () => {
  const dir = tempDir();
  // Simulate the Windows first-run path by removing every explicit value and
  // injecting a firstRun dep that reports "cancelled".
  await expect(
    loadSettings(
      { configPath: join(dir, "agent.json") },
      { dataDir: dir, firstRun: async () => null },
    ),
  ).rejects.toThrow(/cancelled/);
});
