import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  decideAutoUpdate,
  handleAutoUpdate,
  resolveBinaryUrl,
} from "../../agent/src/auto-update.ts";
import type { WelcomeMsg } from "../../shared/protocol.ts";

const WELCOME: WelcomeMsg = {
  type: "welcome",
  agentId: "ag_1",
  serverTime: 0,
  heartbeatIntervalMs: 10_000,
  latestAgentVersion: "0.6.0",
  agentBinaryUrl: "/agent/latest.exe",
  agentBinarySha256: "a".repeat(64),
};

test("compareVersions orders numerically, not lexically", () => {
  expect(compareVersions("0.5.10", "0.5.9")).toBe(1);
  expect(compareVersions("0.5.9", "0.5.10")).toBe(-1);
  expect(compareVersions("1.0.0", "1.0")).toBe(0);
  expect(compareVersions("0.6.0", "0.5.3")).toBe(1);
  expect(compareVersions("0.5.1-beta.2", "0.5.1")).toBe(0);
});

test("resolveBinaryUrl keeps absolute URLs and resolves relative ones", () => {
  expect(resolveBinaryUrl("https://cdn.example/a.exe", "wss://hub.example/agent")).toBe("https://cdn.example/a.exe");
  expect(resolveBinaryUrl("/agent/latest.exe", "wss://hub.example:8787/agent")).toBe("https://hub.example:8787/agent/latest.exe");
  expect(resolveBinaryUrl("latest.exe", "ws://10.0.0.5:8787/agent")).toBe("http://10.0.0.5:8787/latest.exe");
  expect(() => resolveBinaryUrl("/agent/latest.exe", undefined)).toThrow(/without the server URL/);
});

test("decideAutoUpdate only fires for a strictly newer published version", () => {
  const base = { currentVersion: "0.5.3" };
  expect(decideAutoUpdate(WELCOME, base).action).toBe("update");
  expect(decideAutoUpdate({ ...WELCOME, latestAgentVersion: "0.5.3" }, base)).toEqual({
    action: "none",
    reason: "up to date (0.5.3)",
  });
  expect(decideAutoUpdate({ ...WELCOME, latestAgentVersion: "0.5.2" }, base).action).toBe("none");
  expect(decideAutoUpdate({ ...WELCOME, latestAgentVersion: undefined }, base).action).toBe("none");
});

test("decideAutoUpdate honours the safety switches", () => {
  expect(decideAutoUpdate(WELCOME, { currentVersion: "0.5.3", enabled: false }).action).toBe("none");
  expect(decideAutoUpdate(WELCOME, { currentVersion: "0.5.3", standalone: false }).action).toBe("none");
  const noUrl = decideAutoUpdate({ ...WELCOME, agentBinaryUrl: undefined }, { currentVersion: "0.5.3" });
  expect(noUrl).toEqual({ action: "skip", reason: "server announced a version without a binary URL" });
});

test("handleAutoUpdate downloads, verifies and relaunches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mrc-au-"));
  const execPath = join(dir, "rc-agent.exe");
  await Bun.write(execPath, "old-binary");
  const relaunches: Array<{ updatePath?: string }> = [];

  const result = await handleAutoUpdate(WELCOME, {
    currentVersion: "0.5.3",
    execPath,
    platform: "win32",
    standalone: true,
    serverUrl: "wss://hub.example/agent",
    download: async (url, dest) => {
      expect(url).toBe("https://hub.example/agent/latest.exe");
      await Bun.write(dest, "new-binary");
      return "a".repeat(64); // matches the announced sha256
    },
    relaunch: (async (params: { updatePath?: string }) => {
      relaunches.push(params);
      return { meta: {} };
    }) as never,
  });

  expect(result.updated).toBe(true);
  expect(relaunches.length).toBe(1);
  expect(relaunches[0]!.updatePath).toBe(join(dir, "rc-agent.new.exe"));
  rmSync(dir, { recursive: true, force: true });
});

test("handleAutoUpdate rejects a binary whose sha256 does not match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mrc-au-"));
  const execPath = join(dir, "rc-agent.exe");
  await Bun.write(execPath, "old");
  let relaunched = false;

  await expect(
    handleAutoUpdate(WELCOME, {
      currentVersion: "0.5.3",
      execPath,
      platform: "win32",
      standalone: true,
      serverUrl: "wss://hub.example/agent",
      download: async (_url, dest) => {
        await Bun.write(dest, "tampered");
        return "b".repeat(64); // does NOT match "a" * 64
      },
      relaunch: (async () => {
        relaunched = true;
        return { meta: {} };
      }) as never,
    }),
  ).rejects.toThrow(/sha256 mismatch/);
  expect(relaunched).toBe(false); // never swap an unverified binary
  rmSync(dir, { recursive: true, force: true });
});

test("handleAutoUpdate is a no-op when up to date", async () => {
  const result = await handleAutoUpdate(WELCOME, {
    currentVersion: "0.6.0",
    standalone: true,
    download: async () => {
      throw new Error("must not download");
    },
  });
  expect(result.updated).toBeUndefined();
  expect(result.decision.action).toBe("none");
});
