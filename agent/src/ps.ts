/**
 * Process listing and killing (`ps.list` / `ps.kill` jobs).
 *
 * - POSIX: `ps -e -ww -o pid=,ppid=,user=,pcpu=,pmem=,rss=,args=` and signals.
 *   Tree kills walk the ppid map and signal descendants deepest-first.
 * - Windows: PowerShell `Get-Process` (two CPU samples for a percent) and
 *   `taskkill /PID <pid> /T /F`.
 *
 * Safety: the agent never kills itself (or pid 1), and `name` must match at
 * least one process ("no process named 'x'" otherwise).
 */
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import type { PsKillParams, PsListParams } from "@mrc/shared";
import type { ShortJobResult } from "./job-result.ts";
import { runCommand } from "./run-command.ts";
import { parseJsonArray } from "./sysinfo.ts";

export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  name: string;
  user: string | null;
  cpuPercent: number | null;
  memBytes: number | null;
  command: string | null;
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export async function listProcesses(params: PsListParams): Promise<ShortJobResult> {
  const all = await getProcessList();

  const filter = params.filter?.toLowerCase();
  const matched = filter
    ? all.filter(
        (proc) =>
          proc.name.toLowerCase().includes(filter) || (proc.command?.toLowerCase().includes(filter) ?? false),
      )
    : all;

  const sorted = sortProcesses(matched, params.sort);
  const processes = sorted.slice(0, params.top);

  return {
    outputs: [{ stream: "stdout", data: JSON.stringify({ total: all.length, matched: matched.length, processes }), encoding: "utf8" }],
    meta: { total: all.length, matched: matched.length, returned: processes.length },
  };
}

export function sortProcesses(processes: ProcessInfo[], sort: PsListParams["sort"]): ProcessInfo[] {
  const copy = [...processes];
  switch (sort) {
    case "pid":
      return copy.sort((a, b) => b.pid - a.pid);
    case "name":
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    case "cpu":
      return copy.sort((a, b) => (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1));
    case "mem":
    default:
      return copy.sort((a, b) => (b.memBytes ?? -1) - (a.memBytes ?? -1));
  }
}

export async function getProcessList(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") return getProcessListWindows();
  // Linux containers often ship without procps; reading /proc is dependency-free.
  if (process.platform === "linux" && existsSync("/proc/self/stat")) return getProcessListLinux();
  return getProcessListPosix();
}

// ---------------------------------------------------------------------------
// Linux: /proc reader (no procps needed)
// ---------------------------------------------------------------------------

/** Linux USER_HZ and page size: fixed values on every real Linux userspace. */
const CLK_TCK = 100;
const PAGE_SIZE = 4096;

export async function getProcessListLinux(): Promise<ProcessInfo[]> {
  const btime = await readBootTimeSeconds();
  const users = await readPasswdUsers();
  const entries = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  const processes: ProcessInfo[] = [];

  for (const entry of entries) {
    const pid = Number(entry);
    try {
      const stat = await readFile(`/proc/${entry}/stat`, "utf8");
      const open = stat.indexOf("(");
      const close = stat.lastIndexOf(")");
      if (open < 0 || close < 0) continue;
      const comm = stat.slice(open + 1, close);
      const rest = stat.slice(close + 2).trim().split(/\s+/);
      // Fields after comm: 3=state, 4=ppid, ..., 14/15=utime/stime, 22=starttime, 24=rss
      const ppid = Number(rest[1]);
      const utime = Number(rest[11]);
      const stime = Number(rest[12]);
      const starttime = Number(rest[19]);
      const rssPages = Number(rest[21]);
      if (!Number.isFinite(ppid)) continue;

      let command = "";
      try {
        const raw = await readFile(`/proc/${entry}/cmdline`, "utf8");
        command = raw.split("\0").filter(Boolean).join(" ").trim();
      } catch {
        // vanished mid-read
      }

      const uid = await readProcUid(entry);
      const startedSec = btime + starttime / CLK_TCK;
      const elapsedSec = Math.max(0.001, Date.now() / 1000 - startedSec);
      const cpuPercent = Math.round((((utime + stime) / CLK_TCK / elapsedSec) * 100) * 10) / 10;

      processes.push({
        pid,
        ppid,
        name: command ? executableName(command) : comm,
        user: uid !== null ? users.get(uid) ?? String(uid) : null,
        cpuPercent,
        memBytes: rssPages * PAGE_SIZE,
        command: command || `[${comm}]`,
      });
    } catch {
      // Process vanished between readdir and read: skip.
    }
  }
  return processes;
}

async function readBootTimeSeconds(): Promise<number> {
  try {
    const stat = await readFile("/proc/stat", "utf8");
    const match = /^btime (\d+)$/m.exec(stat);
    if (match) return Number(match[1]);
  } catch {
    // fall through
  }
  return Math.floor(Date.now() / 1000 - os.uptime());
}

async function readProcUid(pid: string): Promise<number | null> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^Uid:\s+(\d+)/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

let passwdCache: Map<number, string> | null = null;

async function readPasswdUsers(): Promise<Map<number, string>> {
  if (passwdCache) return passwdCache;
  const users = new Map<number, string>();
  try {
    const passwd = await readFile("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 3) {
        const uid = Number(parts[2]);
        if (Number.isInteger(uid) && parts[0]) users.set(uid, parts[0]);
      }
    }
  } catch {
    // no /etc/passwd: uids stay numeric
  }
  passwdCache = users;
  return users;
}

async function getProcessListPosix(): Promise<ProcessInfo[]> {
  const res = await runCommand(["ps", "-e", "-ww", "-o", "pid=,ppid=,user=,pcpu=,pmem=,rss=,args="], {
    timeoutMs: 10_000,
  });
  if (res.code !== 0) throw new Error(`ps failed (exit ${res.code}): ${res.stderr.trim() || "no stderr"}`);
  return parsePsOutput(res.stdout);
}

export function parsePsOutput(text: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, user, cpu, , rss, command] = match;
    const commandLine = (command ?? "").trim();
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      name: executableName(commandLine),
      user: user ?? null,
      cpuPercent: Number(cpu),
      memBytes: Number(rss) * 1024,
      command: commandLine || null,
    });
  }
  return processes;
}

/** Best-effort executable name: basename of the first token of `args` (kernel threads keep their [name]). */
export function executableName(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return "?";
  let token: string;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    token = end > 0 ? trimmed.slice(1, end) : trimmed.split(/\s+/)[0] ?? "";
  } else {
    token = trimmed.split(/\s+/)[0] ?? "";
  }
  if (!token) return "?";
  if (token.startsWith("[")) return token;
  const parts = token.split(/[/\\]/);
  return parts[parts.length - 1] || token;
}

async function getProcessListWindows(): Promise<ProcessInfo[]> {
  const script = [
    "$c1 = @{}",
    "Get-Process | ForEach-Object { $c1[$_.Id] = $_.TotalProcessorTime.TotalMilliseconds }",
    "Start-Sleep -Milliseconds 500",
    "$cores = [Environment]::ProcessorCount",
    "$users = $null",
    "try { $users = @{}; Get-Process -IncludeUserName -ErrorAction Stop | ForEach-Object { $users[$_.Id] = $_.UserName } } catch { $users = $null }",
    "$list = Get-Process | ForEach-Object {",
    "  $ms = $_.TotalProcessorTime.TotalMilliseconds",
    "  $prev = if ($c1.ContainsKey($_.Id)) { $c1[$_.Id] } else { $ms }",
    "  [pscustomobject]@{",
    "    pid = $_.Id",
    "    name = $_.ProcessName",
    "    cpuPercent = [math]::Round((($ms - $prev) / 500.0 / $cores) * 100, 1)",
    "    memBytes = $_.WorkingSet64",
    "    user = if ($users -and $users.ContainsKey($_.Id)) { $users[$_.Id] } else { $null }",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($list) -Compress -Depth 3",
  ].join("\n");

  const res = await runCommand(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    timeoutMs: 30_000,
  });
  if (res.code !== 0) throw new Error(`process list failed (exit ${res.code}): ${res.stderr.trim() || "no stderr"}`);

  return parseJsonArray<{ pid?: number; name?: string; cpuPercent?: number; memBytes?: number; user?: string | null }>(
    res.stdout,
  )
    .filter((proc) => typeof proc.pid === "number")
    .map((proc) => ({
      pid: Number(proc.pid),
      ppid: null,
      name: String(proc.name ?? "?"),
      user: proc.user ?? null,
      cpuPercent: typeof proc.cpuPercent === "number" ? proc.cpuPercent : null,
      memBytes: typeof proc.memBytes === "number" ? proc.memBytes : null,
      command: null,
    }));
}

// ---------------------------------------------------------------------------
// Killing
// ---------------------------------------------------------------------------

export interface KillOutcome {
  pid: number;
  ok: boolean;
  error?: string;
}

export async function killProcesses(params: PsKillParams): Promise<ShortJobResult> {
  const all = await getProcessList();

  let targets: ProcessInfo[];
  if (params.pid !== undefined) {
    const target = all.find((proc) => proc.pid === params.pid);
    if (!target) throw new Error(`no process with pid ${params.pid}`);
    targets = [target];
  } else {
    const wanted = normalizeName(params.name!);
    targets = all.filter((proc) => normalizeName(proc.name) === wanted);
    if (targets.length === 0) throw new Error(`no process named '${params.name}'`);
  }

  // Never kill ourselves: that would break the connection instead of helping.
  targets = targets.filter((proc) => proc.pid !== process.pid);
  if (targets.length === 0) throw new Error("refusing to kill the agent's own process");

  const targetPids = new Set(targets.map((proc) => proc.pid));
  let rootPids = [...targetPids];
  if (params.tree) {
    const roots = rootsOf(targetPids, all);
    if (roots.length !== rootPids.length) {
      // A target that is a descendant of another target is covered by the tree kill.
      rootPids = roots;
    }
  }

  const outcomes = process.platform === "win32"
    ? await killWindows(rootPids, params)
    : killPosix(rootPids, all, params);

  const killed = outcomes.filter((outcome) => outcome.ok);
  return {
    outputs: [
      {
        stream: "stdout",
        data: JSON.stringify({
          requested: params.pid !== undefined ? { pid: params.pid } : { name: params.name },
          tree: params.tree,
          force: params.force,
          killedCount: killed.length,
          outcomes,
        }),
        encoding: "utf8",
      },
    ],
    meta: { killedCount: killed.length, outcomes },
  };
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.exe$/, "");
}

/** Keep only pids that are not descendants of another target. */
function rootsOf(targetPids: Set<number>, all: ProcessInfo[]): number[] {
  return [...targetPids].filter((pid) => {
    let current = all.find((proc) => proc.pid === pid);
    const seen = new Set<number>();
    while (current?.ppid && !seen.has(current.pid)) {
      if (targetPids.has(current.ppid)) return false;
      seen.add(current.pid);
      current = all.find((proc) => proc.pid === current!.ppid);
    }
    return true;
  });
}

/** Collect the descendants of `pid` (deepest last). */
export function descendantsOf(pid: number, all: ProcessInfo[]): number[] {
  const children = new Map<number, number[]>();
  for (const proc of all) {
    if (proc.ppid === null) continue;
    const list = children.get(proc.ppid) ?? [];
    list.push(proc.pid);
    children.set(proc.ppid, list);
  }
  const result: number[] = [];
  const stack = [...(children.get(pid) ?? [])];
  while (stack.length > 0) {
    const child = stack.pop()!;
    result.push(child);
    stack.push(...(children.get(child) ?? []));
  }
  return result;
}

async function killWindows(rootPids: number[], params: PsKillParams): Promise<KillOutcome[]> {
  const outcomes: KillOutcome[] = [];
  for (const pid of rootPids) {
    const cmd = ["taskkill", "/PID", String(pid)];
    if (params.tree) cmd.push("/T");
    if (params.force) cmd.push("/F");
    const res = await runCommand(cmd, { timeoutMs: 15_000 });
    if (res.code === 0) {
      outcomes.push({ pid, ok: true });
    } else {
      const message = `${res.stdout} ${res.stderr}`.trim() || `taskkill exit ${res.code}`;
      outcomes.push({ pid, ok: false, error: message.split("\n")[0] });
    }
  }
  return outcomes;
}

function killPosix(rootPids: number[], all: ProcessInfo[], params: PsKillParams): KillOutcome[] {
  if (rootPids.includes(1)) throw new Error("refusing to kill pid 1");
  const signal: NodeJS.Signals = params.force ? "SIGKILL" : "SIGTERM";

  const toSignal: number[] = [];
  for (const root of rootPids) {
    if (params.tree) toSignal.push(...descendantsOf(root, all));
    toSignal.push(root);
  }

  const outcomes: KillOutcome[] = [];
  for (const pid of toSignal) {
    try {
      process.kill(pid, signal);
      outcomes.push({ pid, ok: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        outcomes.push({ pid, ok: false, error: "process not found (already gone)" });
      } else if (code === "EPERM") {
        outcomes.push({ pid, ok: false, error: "permission denied" });
      } else {
        outcomes.push({ pid, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return outcomes;
}
