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
import { isAutostartEnabled, setAutostartEnabled } from "./autostart.ts";
import { protectString, unprotectString } from "./dpapi.ts";
import { runFirstRunDialog } from "./first-run.ts";

const DEFAULT_SERVER = "ws://127.0.0.1:8787";
const DEV_TOKEN = "dev-token";

/**
 * Compile-time defaults baked with: bun run build:exe --server ws://... --name ...
 * Bun's --define replaces the whole member expression with the literal, so in
 * dev (`bun run agent`) these just read the (usually unset) environment.
 * Precedence: CLI flags > environment > config file > built-in > hardcoded.
 */
const BUILT_IN_SERVER = process.env.MRC_BUILT_IN_SERVER || "";
const BUILT_IN_NAME = process.env.MRC_BUILT_IN_NAME || "";

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

  let name = input.name ?? file.name ?? process.env.MRC_NAME ?? BUILT_IN_NAME;
  let server = input.server ?? file.server ?? process.env.MRC_SERVER ?? BUILT_IN_SERVER ?? DEFAULT_SERVER;
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

  // First run: no config file and something essential still missing -> ask
  // (dialog on Windows, or the injected firstRun dep in tests). Every source
  // counts (flags, env, file, built-in): a fully-configured exe never pops
  // the dialog.
  const hasName = Boolean(input.name ?? file.name ?? process.env.MRC_NAME ?? BUILT_IN_NAME);
  const hasServer = Boolean(input.server ?? file.server ?? process.env.MRC_SERVER ?? BUILT_IN_SERVER);
  const hasToken = Boolean(input.token ?? process.env.MRC_TOKEN ?? file.token ?? file.tokenProtected);
  const missingBasics = !existsSync(configPath) && (!hasName || !hasServer || !hasToken);
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
    autostart: isAutostartEnabled(),
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
      await setAutostartEnabled(enabled);
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
