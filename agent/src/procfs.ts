/**
 * POSIX process-listing primitives shared by the `ps.list` job.
 *
 * - Linux: reads /proc directly (containers often lack procps).
 * - Other POSIX (macOS/BSD): parses `ps` output.
 */
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import { runCommand } from "./run-command.ts";

export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  name: string;
  user: string | null;
  cpuPercent: number | null;
  memBytes: number | null;
  command: string | null;
}

/** Best-effort executable name: basename of the first token of `args` (kernel threads keep their [name]). */
export function executableName(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (!trimmed) return "?";
  let token: string;
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    token = end > 0 ? trimmed.slice(1, end) : (trimmed.split(/\s+/)[0] ?? "");
  } else {
    token = trimmed.split(/\s+/)[0] ?? "";
  }
  if (!token) return "?";
  if (token.startsWith("[")) return token;
  const parts = token.split(/[/\\]/);
  return parts[parts.length - 1] || token;
}

/** Parse `ps -e -ww -o pid=,ppid=,user=,pcpu=,pmem=,rss=,args=` output. */
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

export async function getProcessListPosix(): Promise<ProcessInfo[]> {
  const res = await runCommand(["ps", "-e", "-ww", "-o", "pid=,ppid=,user=,pcpu=,pmem=,rss=,args="], {
    timeoutMs: 10_000,
  });
  if (res.code !== 0) throw new Error(`ps failed (exit ${res.code}): ${res.stderr.trim() || "no stderr"}`);
  return parsePsOutput(res.stdout);
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
        user: uid !== null ? (users.get(uid) ?? String(uid)) : null,
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
