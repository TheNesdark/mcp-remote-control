/**
 * Windows autostart via the per-user Run registry key (no admin needed).
 * Only meaningful for the compiled rc-agent.exe: under `bun run` the entry
 * would point at the bun binary, so enabling refuses with a clear error.
 */
import { runCommand } from "./run-command.ts";

const AUTOSTART_NAME = "mcp-remote-control";
const AUTOSTART_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/** True when the Run entry points at this executable. Always false off-Windows. */
export function isAutostartEnabled(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const result = Bun.spawnSync({
      cmd: ["reg", "query", AUTOSTART_KEY, "/v", AUTOSTART_NAME],
      stdout: "pipe",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Write or delete the Run entry. Throws off-Windows or when running under bun. */
export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("autostart is only supported on Windows");
  }
  const execPath = process.execPath;
  if (/[/\\]bun(\.exe)?$/i.test(execPath)) {
    throw new Error("autostart needs the compiled rc-agent.exe (running under bun)");
  }
  if (enabled) {
    const res = await runCommand([
      "reg",
      "add",
      AUTOSTART_KEY,
      "/v",
      AUTOSTART_NAME,
      "/t",
      "REG_SZ",
      "/d",
      `"${execPath}"`,
      "/f",
    ]);
    if (res.code !== 0) throw new Error(`reg add failed: ${res.stderr.trim() || `exit ${res.code}`}`);
  } else {
    const res = await runCommand(["reg", "delete", AUTOSTART_KEY, "/v", AUTOSTART_NAME, "/f"]);
    if (res.code !== 0 && !/cannot find|no se encuentra/i.test(res.stderr)) {
      throw new Error(`reg delete failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
  }
}
