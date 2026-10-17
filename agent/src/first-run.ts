/**
 * First-run / settings dialog (Windows only): asks the local user for the
 * machine name, server URL and token via tray/first-run.ps1, and reports back
 * one JSON line. Used by settings.ts on first run and by the tray "Settings..."
 * menu afterwards.
 *
 * The dialog is launched as a visible console child (runCommand showWindow):
 * the agent is GUI-subsystem, so with the default `windowsHide` libuv sets
 * SW_HIDE on the child's first window and the WinForms form would never show.
 */
import { resolveHelperScript } from "./helper-scripts.ts";
import { runCommand } from "./run-command.ts";

/** Default WebSocket port of the hub (config.ts MRC_PORT). */
const DEFAULT_WS_PORT = 8787;

export interface FirstRunResult {
  name: string;
  server: string;
  token: string;
}

/**
 * Accept the loose input a human types in the dialog and turn it into a
 * connectable WebSocket URL:
 *   192.168.1.50          -> ws://192.168.1.50:8787
 *   192.168.1.50:9000     -> ws://192.168.1.50:9000
 *   ws://host             -> ws://host:8787
 *   wss://host/path       -> unchanged (custom path/port kept)
 */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`;
  try {
    const url = new URL(text);
    if ((url.protocol === "ws:" || url.protocol === "wss:") && url.port === "") {
      url.port = String(DEFAULT_WS_PORT);
    }
    // Prefer the canonical "scheme://host" when there is no meaningful path.
    if (url.pathname === "/" && url.search === "" && url.hash === "") {
      return `${url.protocol}//${url.host}`;
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}

/** Run the dialog; returns null when the user cancels. Throws on misuse. */
export async function runFirstRunDialog(defaults: FirstRunResult): Promise<FirstRunResult | null> {
  const script = resolveHelperScript("first-run.ps1");
  if (!script) {
    throw new Error("setup dialog script not found (looked next to the exe, in %APPDATA% and in the checkout)");
  }
  const res = await runCommand(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Sta",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-DefaultName",
      defaults.name,
      "-DefaultServer",
      defaults.server,
      "-DefaultToken",
      defaults.token,
    ],
    { timeoutMs: 5 * 60_000, showWindow: true },
  );

  const line = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  let parsed: { name?: string; server?: string; token?: string; cancelled?: boolean; error?: string } = {};
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    const detail = res.stderr.trim().split("\n").slice(-3).join(" ").trim();
    throw new Error(`setup dialog returned no JSON (exit ${res.code})${detail ? `: ${detail}` : ""}`);
  }
  if (parsed.cancelled) return null;
  if (parsed.error === "invalid_name") {
    throw new Error(`invalid computer name '${parsed.name}' (use letters, digits, dot, dash or underscore)`);
  }
  if (!parsed.name) return null;
  return {
    name: parsed.name,
    server: normalizeServerUrl(parsed.server ?? defaults.server),
    token: parsed.token ?? defaults.token,
  };
}
