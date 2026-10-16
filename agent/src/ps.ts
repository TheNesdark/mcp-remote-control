/**
 * Process listing and killing (`ps.list` / `ps.kill` jobs).
 *
 * Listing primitives live in procfs.ts (POSIX); this module filters, sorts,
 * dispatches per platform, and implements killing (with tree walks).
 * Windows uses PowerShell `Get-Process` (two CPU samples for a percent) and
 * `taskkill /PID <pid> /T /F`.
 *
 * Safety: the agent never kills itself (or pid 1), and `name` must match at
 * least one process ("no process named 'x'" otherwise).
 */
import { existsSync } from "node:fs";
import type { PsKillParams, PsListParams } from "@mrc/shared";
import type { ShortJobResult } from "./job-result.ts";
import { getProcessListLinux, getProcessListPosix, type ProcessInfo } from "./procfs.ts";
import { runCommand } from "./run-command.ts";
import { parseJsonArray } from "./sysinfo.ts";

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
