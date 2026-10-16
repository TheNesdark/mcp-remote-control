/**
 * Locates the PowerShell helpers (tray.ps1, first-run.ps1) on Windows.
 *
 * Lookup order:
 * 1. Next to the running executable (installed layout: install.ps1 copies
 *    rc-agent.exe + tray/*.ps1 side by side).
 * 2. The repo checkout (dev: agent/tray/*.ps1 next to the sources).
 * 3. Embedded copy materialized to %APPDATA%\\mcp-remote-control\\helpers
 *    (always available: the sources are compiled into rc-agent.exe, so even
 *    a bare exe with no sidecar files can show the first-run dialog and the
 *    tray icon).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import FIRST_RUN_PS1 from "../tray/first-run.ps1" with { type: "text" };
import TRAY_PS1 from "../tray/tray.ps1" with { type: "text" };

const EMBEDDED: Record<string, string> = {
  "tray.ps1": TRAY_PS1,
  "first-run.ps1": FIRST_RUN_PS1,
};

function appDataDir(): string {
  if (process.env.APPDATA) return join(process.env.APPDATA, "mcp-remote-control", "helpers");
  return join(import.meta.dir, "..", "..", ".helpers-fallback");
}

/**
 * Write the embedded helper to disk (only when missing or outdated) and
 * return its path. Throws when the directory is not writable.
 */
export function materializeHelper(filename: string, dir?: string): string {
  const content = EMBEDDED[filename];
  if (content === undefined) throw new Error(`no embedded helper named '${filename}'`);
  const targetDir = dir ?? appDataDir();
  mkdirSync(targetDir, { recursive: true });
  const path = join(targetDir, filename);
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = null;
  }
  if (current !== content) writeFileSync(path, content, "utf8");
  return path;
}

export function resolveHelperScript(filename: string): string | null {
  const candidates = [
    join(dirname(process.execPath), filename),
    join(import.meta.dir, "..", "tray", filename),
  ];
  for (const path of candidates) {
    if (path.length > 0 && existsSync(path)) return path;
  }
  if (EMBEDDED[filename] === undefined) return null;
  try {
    return materializeHelper(filename);
  } catch {
    return null;
  }
}
