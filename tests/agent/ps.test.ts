import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descendantsOf, killProcesses, listProcesses, sortProcesses } from "../../agent/src/ps.ts";
import { executableName, parsePsOutput, type ProcessInfo } from "../../agent/src/procfs.ts";

const PS_SAMPLE = `   1     0 root     0.0  0.1  168192 /sbin/init
 412     1 msg+     0.3  0.9  301056 /usr/bin/dbus-daemon --system --address=systemd: --nofork
 777   412 user     1.5  2.0 1048576 node /opt/app/server.js --port 8080
  99     2 root     0.0  0.0       0 [kworker/0:1]`;

test("parsePsOutput extracts fields and derives names", () => {
  const processes = parsePsOutput(PS_SAMPLE);
  expect(processes.length).toBe(4);
  expect(processes[0]).toMatchObject({ pid: 1, ppid: 0, name: "init", user: "root" });
  expect(processes[2]).toMatchObject({ pid: 777, name: "node", cpuPercent: 1.5, memBytes: 1048576 * 1024 });
  expect(processes[2]!.command).toContain("--port 8080");
  expect(processes[3]).toMatchObject({ pid: 99, name: "[kworker/0:1]" });
});

test("executableName handles paths, quotes, brackets and empty input", () => {
  expect(executableName("/usr/bin/dbus-daemon --system")).toBe("dbus-daemon");
  expect(executableName('"C:\\Program Files\\app.exe" -x')).toBe("app.exe");
  expect(executableName("C:\\Windows\\notepad.exe -f")).toBe("notepad.exe");
  expect(executableName("[kthreadd]")).toBe("[kthreadd]");
  expect(executableName("")).toBe("?");
});

test("sortProcesses orders by cpu, mem, pid and name", () => {
  const processes: ProcessInfo[] = [
    { pid: 1, ppid: 0, name: "b", user: null, cpuPercent: 1, memBytes: 300, command: null },
    { pid: 3, ppid: 0, name: "a", user: null, cpuPercent: 5, memBytes: 100, command: null },
    { pid: 2, ppid: 0, name: "c", user: null, cpuPercent: null, memBytes: 200, command: null },
  ];
  expect(sortProcesses(processes, "cpu").map((p) => p.pid)).toEqual([3, 1, 2]);
  expect(sortProcesses(processes, "mem").map((p) => p.pid)).toEqual([1, 2, 3]);
  expect(sortProcesses(processes, "pid").map((p) => p.pid)).toEqual([3, 2, 1]);
  expect(sortProcesses(processes, "name").map((p) => p.pid)).toEqual([3, 1, 2]);
});

test("descendantsOf walks the ppid tree", () => {
  const processes: ProcessInfo[] = [
    { pid: 10, ppid: 1, name: "root", user: null, cpuPercent: 0, memBytes: 0, command: null },
    { pid: 11, ppid: 10, name: "child-a", user: null, cpuPercent: 0, memBytes: 0, command: null },
    { pid: 12, ppid: 10, name: "child-b", user: null, cpuPercent: 0, memBytes: 0, command: null },
    { pid: 13, ppid: 11, name: "grandchild", user: null, cpuPercent: 0, memBytes: 0, command: null },
    { pid: 14, ppid: 1, name: "unrelated", user: null, cpuPercent: 0, memBytes: 0, command: null },
  ];
  const descendants = descendantsOf(10, processes);
  expect(descendants.sort((a, b) => a - b)).toEqual([11, 12, 13]);
});

test("listProcesses includes the current process", async () => {
  const outcome = await listProcesses({ top: 5_000, sort: "pid" });
  const payload = JSON.parse(outcome.outputs![0]!.data) as { total: number; processes: ProcessInfo[] };
  expect(payload.total).toBeGreaterThan(0);
  expect(payload.processes.some((proc) => proc.pid === process.pid)).toBe(true);
  expect(outcome.meta.total).toBe(payload.total);
});

test("listProcesses filters by name substring", async () => {
  const outcome = await listProcesses({ filter: "bun", top: 100, sort: "mem" });
  const payload = JSON.parse(outcome.outputs![0]!.data) as { processes: ProcessInfo[] };
  expect(payload.processes.length).toBeGreaterThan(0);
  expect(payload.processes.every((proc) => proc.name.toLowerCase().includes("bun") || proc.command?.toLowerCase().includes("bun"))).toBe(true);
});

test("killProcesses refuses to kill the agent itself", async () => {
  await expect(killProcesses({ pid: process.pid, force: true, tree: true })).rejects.toThrow(/own process/);
});

test("killProcesses kills by pid and reports it", async () => {
  const victim = Bun.spawn({ cmd: ["sleep", "60"], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const outcome = await killProcesses({ pid: victim.pid, force: true, tree: true });
  expect(outcome.meta.killedCount).toBe(1);
  const exited = await Promise.race([victim.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
  expect(exited).toBe(true);
});

test("killProcesses kills by name through a symlink", async () => {
  const dir = join(tmpdir(), `mrc-kt-${Date.now()}`);
  const link = join(dir, "mrc-kill-test");
  mkdirSync(dir, { recursive: true });
  symlinkSync("/usr/bin/sleep", link);
  try {
    const victim = Bun.spawn({ cmd: [link, "60"], stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const outcome = await killProcesses({ name: "mrc-kill-test", force: true, tree: true });
    expect(outcome.meta.killedCount).toBeGreaterThanOrEqual(1);
    const exited = await Promise.race([victim.exited.then(() => true), Bun.sleep(3_000).then(() => false)]);
    expect(exited).toBe(true);
  } finally {
    try {
      unlinkSync(link);
    } catch {
      // already gone
    }
  }
});

test("killProcesses with tree=true kills descendants", async () => {
  const parent = Bun.spawn({
    cmd: ["sh", "-c", "sleep 61 & sleep 62 & wait"],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await Bun.sleep(250); // let sh spawn its two children
  const outcome = await killProcesses({ pid: parent.pid, force: true, tree: true });
  expect(outcome.meta.killedCount).toBeGreaterThanOrEqual(2);
  await Bun.sleep(150);
  const listing = await listProcesses({ filter: "sleep 6", top: 100, sort: "pid" });
  const payload = JSON.parse(listing.outputs![0]!.data) as { processes: Array<{ command: string | null }> };
  const leftovers = payload.processes.filter((proc) => /sleep 6[12]/.test(proc.command ?? ""));
  expect(leftovers.length).toBe(0);
});
