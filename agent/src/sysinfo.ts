/**
 * System inventory (`info` job): host, OS, CPU, memory, IPs and disks.
 *
 * Disks are read with `df -kP` on POSIX and `Get-CimInstance Win32_LogicalDisk`
 * via PowerShell on Windows. Everything else comes from node:os.
 */
import os from "node:os";
import type { InfoParams } from "@mrc/shared";
import type { ShortJobResult } from "./job-result.ts";
import { runCommand } from "./run-command.ts";

export interface DiskInfo {
  mount: string;
  label?: string | null;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent?: number | null;
}

export interface AgentInfoContext {
  name: string;
  version: string;
  agentId: string | null;
  server: string;
  caps: string[];
}

function listNetworkAddresses(): Array<{ iface: string; address: string; family: string; internal: boolean; mac: string }> {
  const addresses: Array<{ iface: string; address: string; family: string; internal: boolean; mac: string }> = [];
  for (const [iface, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      addresses.push({
        iface,
        address: entry.address,
        family: entry.family,
        internal: entry.internal,
        mac: entry.mac,
      });
    }
  }
  return addresses;
}

export async function listDisks(): Promise<DiskInfo[]> {
  if (process.platform === "win32") return listDisksWindows();
  return listDisksPosix();
}

async function listDisksPosix(): Promise<DiskInfo[]> {
  const res = await runCommand(["df", "-kP"], { timeoutMs: 10_000 });
  if (res.code !== 0) return [];
  const disks: DiskInfo[] = [];
  for (const line of res.stdout.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [filesystem, blocksKb, usedKb, freeKb, percent, ...mountParts] = parts;
    const totalBytes = Number(blocksKb) * 1024;
    const usedBytes = Number(usedKb) * 1024;
    const freeBytes = Number(freeKb) * 1024;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) continue;
    disks.push({
      mount: mountParts.join(" "),
      label: filesystem ?? null,
      totalBytes,
      usedBytes,
      freeBytes,
      usedPercent: percent ? Number(String(percent).replace("%", "")) : null,
    });
  }
  return disks;
}

async function listDisksWindows(): Promise<DiskInfo[]> {
  const script =
    "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | " +
    "Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress";
  const res = await runCommand(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    timeoutMs: 20_000,
  });
  if (res.code !== 0) return [];
  const parsed = parseJsonArray<{ DeviceID?: string; VolumeName?: string | null; Size?: number; FreeSpace?: number }>(
    res.stdout,
  );
  return parsed
    .filter((disk) => typeof disk.Size === "number" && disk.Size > 0)
    .map((disk) => {
      const totalBytes = Number(disk.Size ?? 0);
      const freeBytes = Number(disk.FreeSpace ?? 0);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      return {
        mount: String(disk.DeviceID ?? "?"),
        label: disk.VolumeName ?? null,
        totalBytes,
        usedBytes,
        freeBytes,
        usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : null,
      };
    });
}

/** ConvertTo-Json returns a bare object for single-item results; normalize to an array. */
export function parseJsonArray<T>(text: string): T[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as T | T[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export async function collectInfo(_params: InfoParams, ctx: AgentInfoContext): Promise<ShortJobResult> {
  const cpus = os.cpus();
  const info = {
    agent: {
      name: ctx.name,
      version: ctx.version,
      id: ctx.agentId,
      server: ctx.server,
      caps: ctx.caps,
      uptimeSec: Math.round(process.uptime()),
    },
    host: os.hostname(),
    os: {
      platform: os.platform(),
      type: os.type(),
      release: os.release(),
      arch: os.arch(),
    },
    user: safeUser(),
    uptimeSec: Math.round(os.uptime()),
    cpu: {
      model: cpus[0]?.model ?? null,
      cores: cpus.length,
      speedMhz: cpus[0]?.speed ?? null,
      loadAvg: os.loadavg().map((value) => Math.round(value * 100) / 100),
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
    },
    ips: listNetworkAddresses(),
    disks: await listDisks(),
    time: new Date().toISOString(),
  };

  return {
    outputs: [{ stream: "stdout", data: JSON.stringify(info), encoding: "utf8" }],
    meta: { host: info.host, platform: info.os.platform },
  };
}

function safeUser(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}
