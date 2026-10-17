/**
 * First-run setup dialog (Windows only): asks the local user for the machine
 * name, server URL and token via tray/first-run.ps1, and reports back one
 * JSON line. Used by settings.ts when there is no config file yet.
 */
import { resolveHelperScript } from "./helper-scripts.ts";
import { runCommand } from "./run-command.ts";

export interface FirstRunResult {
  name: string;
  server: string;
  token: string;
}

/** Run the dialog; returns null when the user cancels. Throws on misuse. */
export async function runFirstRunDialog(defaults: FirstRunResult): Promise<FirstRunResult | null> {
  const script = resolveHelperScript("first-run.ps1");
  if (!script) {
    throw new Error("first-run dialog script not found (looked next to the exe, in %APPDATA% and in the checkout)");
  }
  const res = await runCommand(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Sta",
      "-WindowStyle",
      "Hidden",
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
    { timeoutMs: 5 * 60_000 },
  );

  const line = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  let parsed: { name?: string; server?: string; token?: string; cancelled?: boolean; error?: string } = {};
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    throw new Error(`first-run dialog returned no JSON (exit ${res.code})`);
  }
  if (parsed.cancelled) return null;
  if (parsed.error === "invalid_name") {
    throw new Error(`invalid computer name '${parsed.name}' (use letters, digits, dot, dash or underscore)`);
  }
  if (!parsed.name) return null;
  return { name: parsed.name, server: parsed.server ?? defaults.server, token: parsed.token ?? defaults.token };
}
