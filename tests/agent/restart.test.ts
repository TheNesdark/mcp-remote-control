import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWindowsRestartScript, restartAgent } from "../../agent/src/restart.ts";

test("windows restart script waits, swaps and relaunches", () => {
  const script = buildWindowsRestartScript("C:\\rc-agent.exe", "C:\\new.exe", ["--name", "PC-01"]);
  const atSelf = script.indexOf('move /y "C:\\rc-agent.exe" "C:\\rc-agent.exe.old"');
  const atNew = script.indexOf('move /y "C:\\new.exe" "C:\\rc-agent.exe"');
  const atStart = script.indexOf('start "" "C:\\rc-agent.exe" "--name" "PC-01"');
  const atClean = script.indexOf('del /f /q "C:\\rc-agent.exe.old"');
  expect(atSelf).toBeGreaterThanOrEqual(0);
  expect(atNew).toBeGreaterThan(atSelf); // stage lands only after the self rename
  expect(atStart).toBeGreaterThan(atNew); // relaunch after both swaps
  expect(atClean).toBeGreaterThan(atStart); // .old cleanup is last
  expect(script.indexOf("ping -n 6")).toBeLessThan(atSelf); // grace to flush job.result
});

test("plain restart script relaunches without swapping", () => {
  const script = buildWindowsRestartScript("C:\\a.exe", null, []);
  expect(script).not.toContain("move /y");
  expect(script).toContain('start "" "C:\\a.exe"');
});

test("restart rejects updatePath on non-windows agents", async () => {
  await expect(restartAgent({ updatePath: "C:\\new.exe" }, { platform: "linux" })).rejects.toThrow(/only supported on Windows/);
});

test("restart on posix validates and defers to the supervisor", async () => {
  const res = await restartAgent({}, { platform: "linux", execPath: "/usr/bin/bun" });
  const meta = res.meta as { ok: boolean; platform: string; execPath: string };
  expect(meta.ok).toBe(true);
  expect(meta.platform).toBe("linux");
  expect(meta.execPath).toBe("/usr/bin/bun");
});

test("windows restart spawns the detached script and reports it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mrc-restart-"));
  const spawned: string[] = [];
  // execPath inside a temp dir so the .bat lands somewhere cleanable on any OS
  const res = await restartAgent(
    { updatePath: "C:\\staged\\new.exe", args: ["--name", "X"] },
    {
      platform: "win32",
      execPath: join(dir, "rc-agent.exe"),
      spawnDetached: (script) => void spawned.push(script),
    },
  );
  const meta = res.meta as { updating: boolean; script: string };
  expect(meta.updating).toBe(true);
  expect(meta.script.endsWith(".bat")).toBe(true);
  expect(spawned.length).toBe(1);
  expect(spawned[0]!.endsWith(meta.script)).toBe(true);

  const content = await Bun.file(spawned[0]!).text();
  expect(content).toContain('move /y "C:\\staged\\new.exe"');
  expect(content).toContain('"--name" "X"');
  rmSync(dir, { recursive: true, force: true });
});
