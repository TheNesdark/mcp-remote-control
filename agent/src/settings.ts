/**
 * Agent settings: CLI flags > environment > config file.
 *
 * The config file lives in %APPDATA%\mcp-remote-control\agent.json on Windows
 * (~/.config/mcp-remote-control/agent.json on POSIX for development) and keeps
 * the token encrypted with DPAPI on Windows. On first run (Windows, no config,
 * no CLI values) it launches the first-run dialog (tray/first-run.ps1).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { protectString, unprotectString } from "./dpapi.ts";
import { runCommand } from "./run-command.ts";

const DEFAULT_SERVER = "ws://127.0.0.1:8787";
const DEV_TOKEN = "dev-token";
const AUTOSTART_NAME = "mcp-remote-control";
const AUTOSTART_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

interface ConfigFile {
  name?: string;
  server?: string;
  /** DPAPI-encrypted token (base64), Windows. */
  tokenProtected?: string;
  /** Plaintext token (POSIX development only). */
  token?: string;
  tags?: string[];
  id?: string;
  paused?: boolean;
  logFile?: string;
}

export interface SettingsInput {
  configPath?: string;
  name?: string;
  server?: string;
  token?: string;
  tags?: string;
  id?: string;
  paused?: boolean;
  /** Allow the first-run dialog on Windows when the config is missing. */
  interactive?: boolean;
}

export interface AgentSettings {
  name: string;
  server: string;
  token: string;
  tags: string[];
  agentId: string | undefined;
  paused: boolean;
  autostart: boolean;
  usingDefaultToken: boolean;
  configPath: string;
  logDir: string;
  logFile: string | null;
  setAutostart(enabled: boolean): Promise<void>;
  /** Persist the server-assigned agent id so reconnects keep the same identity. */
  setAgentId(id: string): Promise<void>;
  openLogs(): void;
}

export interface SettingsDeps {
  /** Override for tests: where the config/appdata directory lives. */
  dataDir?: string;
  /** Override for tests: replace the first-run dialog. */
  firstRun?: (defaults: { name: string; server: string; token: string }) => Promise<{
    name: string;
    server: string;
    token: string;
  } | null>;
}

export function defaultDataDir(): string {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appdata, "mcp-remote-control");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "mcp-remote-control");
}

export function parseTags(raw: string | string[] | undefined): string[] {
  if (Array.isArray(raw)) return raw.filter(Boolean).slice(0, 16);
  return (raw ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function readConfig(path: string): ConfigFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

export async function loadSettings(input: SettingsInput = {}, deps: SettingsDeps = {}): Promise<AgentSettings> {
  const dataDir = deps.dataDir ?? defaultDataDir();
  const configPath = input.configPath ?? join(dataDir, "agent.json");
  const file = readConfig(configPath);

  let name = input.name ?? file.name ?? process.env.MRC_NAME ?? "";
  let server = input.server ?? file.server ?? process.env.MRC_SERVER ?? DEFAULT_SERVER;
  let token = input.token ?? process.env.MRC_TOKEN ?? "";
  const tags = parseTags(input.tags ?? file.tags);
  const agentId = input.id ?? file.id;
  const paused = input.paused ?? file.paused ?? false;
  const usingDefaultTokenFromEnv = process.env.MRC_TOKEN === DEV_TOKEN;

  // Token from the config file (DPAPI on Windows).
  if (!token && file.tokenProtected && process.platform === "win32") {
    try {
      token = await unprotectString(file.tokenProtected);
    } catch {
      token = "";
    }
  }
  if (!token && file.token) token = file.token;

  // Default machine name (the dialog prefills with %COMPUTERNAME%).
  if (!name) name = process.env.COMPUTERNAME ?? hostname();

  // First run: no config file and no explicit values -> ask (dialog on
  // Windows, or the injected firstRun dep in tests).
  const missingBasics = !existsSync(configPath) && !input.name && !input.server && !input.token;
  const wantFirstRun =
    missingBasics && (deps.firstRun !== undefined || (process.platform === "win32" && input.interactive !== false));
  let wroteConfig = false;
  if (wantFirstRun) {
    const result = deps.firstRun
      ? await deps.firstRun({ name, server, token: token || "" })
      : await runFirstRunDialog({ name, server, token: token || "" });
    if (!result) {
      throw new Error("first-run setup was cancelled");
    }
    name = result.name || name;
    server = result.server || server;
    token = result.token || token;
    wroteConfig = true;
  }

  if (!token) {
    token = DEV_TOKEN;
  }

  // Persist on first-run (or when only environment values were provided).
  if (wroteConfig) {
    const toWrite: ConfigFile = { name, server, tags, ...(agentId ? { id: agentId } : {}) };
    if (process.platform === "win32") {
      try {
        toWrite.tokenProtected = await protectString(token);
      } catch {
        toWrite.token = token;
      }
    } else {
      toWrite.token = token;
    }
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
    } catch {
      // Best effort: the agent still runs with the in-memory values.
    }
  }

  const logDir = join(dataDir, "logs");
  const defaultLogFile = process.platform === "win32" ? join(logDir, "agent.log") : null;
  const logFile = file.logFile ?? process.env.MRC_LOG_FILE ?? (input.configPath ? null : defaultLogFile);

  const settings: AgentSettings = {
    name,
    server,
    token,
    tags,
    agentId,
    paused,
    autostart: readAutostart(),
    usingDefaultToken: token === DEV_TOKEN || usingDefaultTokenFromEnv,
    configPath,
    logDir,
    logFile: logFile ?? null,
    async setAgentId(id: string): Promise<void> {
      settings.agentId = id;
      // Best-effort write-back: keep the same identity across restarts.
      try {
        const previous = readConfig(configPath);
        const next: ConfigFile = {
          ...previous,
          name,
          server,
          tags,
          id,
          ...(previous.paused === undefined && !paused ? {} : { paused }),
          // Keep the effective token so a reload resolves identically. When the
          // file already carries a DPAPI blob (Windows), it stays untouched.
          ...(previous.tokenProtected ? {} : { token }),
        };
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      } catch {
        // The agent still runs with the in-memory id.
      }
    },
    async setAutostart(enabled: boolean): Promise<void> {
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
      settings.autostart = enabled;
    },
    openLogs(): void {
      try {
        mkdirSync(logDir, { recursive: true });
      } catch {
        // ignore
      }
      const cmd = process.platform === "win32" ? ["explorer", logDir] : ["xdg-open", logDir];
      try {
        Bun.spawn({ cmd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      } catch {
        // Opening the folder is best-effort.
      }
    },
  };
  return settings;
}

function readAutostart(): boolean {
  if (process.platform !== "win32") return false;
  try {
    const result = Bun.spawnSync({ cmd: ["reg", "query", AUTOSTART_KEY, "/v", AUTOSTART_NAME], stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export interface FirstRunResult {
  name: string;
  server: string;
  token: string;
}

/** Windows-only: ask the local user for name/server/token (tray/first-run.ps1). */
export async function runFirstRunDialog(defaults: FirstRunResult): Promise<FirstRunResult | null> {
  const script = join(import.meta.dir, "..", "tray", "first-run.ps1");
  if (!existsSync(script)) {
    throw new Error(`first-run dialog script not found at ${script}`);
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
