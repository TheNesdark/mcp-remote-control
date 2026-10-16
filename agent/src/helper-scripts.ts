/**
 * Locates the PowerShell helpers (tray.ps1, first-run.ps1) on Windows.
 *
 * Lookup order:
 * 1. Next to the running executable (installed layout: install.ps1 copies
 *    rc-agent.exe + tray/*.ps1 side by side).
 * 2. %APPDATA%\\mcp-remote-control (F5 fallback copy location).
 * 3. The repo checkout (dev: agent/tray/*.ps1 next to the sources).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveHelperScript(filename: string): string | null {
  const candidates = [
    join(dirname(process.execPath), filename),
    join(process.env.APPDATA ?? "", "mcp-remote-control", filename),
    join(import.meta.dir, "..", "tray", filename),
  ];
  return candidates.find((path) => path.length > 0 && existsSync(path)) ?? null;
}
