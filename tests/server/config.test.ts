import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@mrc/shared/version";
import { loadConfig } from "../../server/src/config.ts";

/**
 * The deployment should need as few environment variables as possible: paths
 * derive from MRC_DATA_DIR, the OTA version comes from the build and the agent
 * binary is found on its own inside the image layout.
 */
test("paths derive from MRC_DATA_DIR", () => {
  const config = loadConfig({ MRC_DATA_DIR: "/app/server/data" });
  expect(config.dataDir).toBe("/app/server/data");
  expect(config.dbPath).toBe("/app/server/data/mcp.db");
  expect(config.auditPath).toBe("/app/server/data/audit.jsonl");
  expect(config.screenshotDir).toBe("/app/server/data/screenshots");
});

test("the OTA version comes from the build, not from the environment", () => {
  expect(loadConfig({}).agentLatestVersion).toBe(VERSION);
  expect(loadConfig({ MRC_AGENT_LATEST_VERSION: "9.9.9" }).agentLatestVersion).toBe(VERSION);
});

test("the agent binary is auto-detected next to the data directory", () => {
  const root = mkdtempSync(join(tmpdir(), "mrc-cfg-"));
  const dataDir = join(root, "server", "data");
  mkdirSync(join(root, "agent"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const binary = join(root, "agent", "rc-agent.exe");
  writeFileSync(binary, "fake-agent");

  expect(loadConfig({ MRC_DATA_DIR: dataDir }).agentBinaryPath).toBe(binary);
});

test("no agent binary means OTA stays off", () => {
  const root = mkdtempSync(join(tmpdir(), "mrc-cfg-empty-"));
  const dataDir = join(root, "server", "data");
  mkdirSync(dataDir, { recursive: true });
  expect(loadConfig({ MRC_DATA_DIR: dataDir }).agentBinaryPath).toBe("");
});

test("explicit MRC_AGENT_BINARY_PATH still wins", () => {
  const config = loadConfig({ MRC_AGENT_BINARY_PATH: "/opt/rc-agent.exe" });
  expect(config.agentBinaryPath).toBe("/opt/rc-agent.exe");
});
