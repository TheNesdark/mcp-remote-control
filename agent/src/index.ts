#!/usr/bin/env bun
/**
 * mcp-remote-control agent (rc-agent).
 *
 * Connects outbound to the central server and serves jobs: exec, files,
 * inventory, processes and screenshots. On Windows it also runs the tray icon
 * (states, enable/disable, reconnect, open logs, autostart, exit).
 *
 * Usage:
 *   bun run agent -- --server ws://127.0.0.1:8787 --token dev-token --name PC-01 [--tags a,b]
 *                   [--paused] [--id ag_xxx] [--log-level debug] [--max-jobs 4]
 *                   [--config <file>] [--log-file <file>] [--tray|--no-tray]
 *   stdin commands: pause | resume | quit
 */
import os from "node:os";
import { argFlag, argString, parseArgv } from "@mrc/shared/args";
import { logger, setLogFile, setLogLevel, type LogLevel } from "@mrc/shared/log";
import { AgentConnection, type ConnectionState } from "./connection.ts";
import { JobManager } from "./jobs.ts";
import { handleAutoUpdate } from "./auto-update.ts";
import { loadSettings, readConfig } from "./settings.ts";
import { protectString } from "./dpapi.ts";
import { runFirstRunDialog } from "./first-run.ts";
import { restartAgent } from "./restart.ts";
import { TrayIntegration } from "./tray.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VERSION = "0.6.10";

const args = parseArgv(process.argv.slice(2));
setLogLevel((argString(args, "log-level") ?? process.env.MRC_LOG_LEVEL ?? "info") as LogLevel);

// Self-signed server certificates on a trusted LAN: --tls-insecure (or
// MRC_TLS_INSECURE=1) disables TLS verification for the agent's own
// WebSocket connection. Bun's WebSocket reads NODE_TLS_REJECT_UNAUTHORIZED
// per connection, so setting it here covers every reconnect.
const tlsInsecure = argFlag(args, "tls-insecure") || ["1", "true", "yes"].includes((process.env.MRC_TLS_INSECURE ?? "").toLowerCase());
if (tlsInsecure) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  logger.warn("TLS certificate verification is DISABLED (--tls-insecure); trusted LANs only");
}

// ---------------------------------------------------------------------------
// Settings: CLI flags > environment > config file (%APPDATA%/agent.json)
// ---------------------------------------------------------------------------
const settings = await loadSettings({
  configPath: argString(args, "config"),
  name: argString(args, "name"),
  server: argString(args, "server"),
  token: argString(args, "token"),
  tags: argString(args, "tags"),
  id: argString(args, "id"),
  paused: argFlag(args, "paused"),
  interactive: process.platform === "win32",
});

let serverUrl = settings.server;
let token = settings.token;
let name = settings.name;
const tags = settings.tags;

// File logging (so the tray "Open logs" menu has something to open).
const logFile = settings.logFile;
if (logFile) setLogFile(logFile);

if (settings.usingDefaultToken) {
  logger.warn("using the insecure development token; set --token or MRC_TOKEN in production");
}

let connection: AgentConnection | null = null;
// Auto-update: pull the published build on connect (--no-auto-update to opt out).
const autoUpdateEnabled = !argFlag(args, "no-auto-update") && !["0", "false", "no"].includes((process.env.MRC_AUTO_UPDATE ?? "").toLowerCase());
let autoUpdateScheduled = false;
let trayWanted = argFlag(args, "tray") || (process.platform === "win32" && !argFlag(args, "no-tray"));
if (argFlag(args, "no-tray")) trayWanted = false;

const CAPS = ["exec", "fs", "info", "ps", "screenshot", "restart"];

const agentContext = () => ({
  name,
  version: VERSION,
  agentId: connection?.agentId ?? settings.agentId ?? null,
  server: serverUrl,
  caps: CAPS,
});

const jobs = new JobManager({
  send: (msg) => connection?.send(msg),
  log: (msg, fields) => logger.debug(msg, fields),
  maxConcurrent: Number(argString(args, "max-jobs") ?? 4),
  context: agentContext,
});

let lastConnectionState: ConnectionState = "connecting";

const tray = new TrayIntegration({
  enabled: trayWanted,
  label: name,
  detail: serverUrl,
  logDir: settings.logDir,
  autostart: settings.autostart,
  log: (level, msg, fields) => logger[level](msg, fields),
  onToggle: () => {
    if (!connection) return;
    if (connection.isPaused) connection.resume();
    else connection.pause();
    // The connection only emits state changes while connected; refresh so the
    // tray reflects paused/resumed even when offline.
    tray.setState(currentTrayState());
  },
  onReconnect: () => connection?.reconnectNow(),
  onOpenLogs: () => settings.openLogs(),
  onSettings: () => {
    void runSettingsDialog().catch((err) => logger.warn(`settings dialog failed: ${String(err)}`));
  },
  onAutostart: (enabled) => {
    void settings.setAutostart(enabled).catch((err) => logger.warn(`autostart change failed: ${String(err)}`));
  },
  onExit: () => void shutdown("tray exit"),
});

/** Open the settings dialog and apply changes (restart the agent if needed). */
async function runSettingsDialog(): Promise<void> {
  let result: Awaited<ReturnType<typeof runFirstRunDialog>>;
  try {
    result = await runFirstRunDialog({ name, server: serverUrl, token });
  } catch (err) {
    logger.warn(`settings dialog failed: ${String(err)}`);
    return;
  }
  if (!result) return; // cancelled

  const newName = result.name.trim() || name;
  const newServer = result.server.trim() || serverUrl;
  const newToken = result.token.trim() || token;
  const changed = newName !== name || newServer !== serverUrl || newToken !== token;

  // Persist to agent.json (DPAPI on Windows).
  try {
    const previous = readConfig(settings.configPath);
    const toWrite: Record<string, unknown> = { ...previous, name: newName, server: newServer, tags };
    if (settings.agentId) toWrite.id = settings.agentId;
    if (process.platform === "win32") {
      try {
        toWrite.tokenProtected = await protectString(newToken);
      } catch {
        toWrite.token = newToken;
      }
    } else {
      toWrite.token = newToken;
    }
    mkdirSync(dirname(settings.configPath), { recursive: true });
    writeFileSync(settings.configPath, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
  } catch (err) {
    logger.warn(`could not persist settings: ${String(err)}`);
  }

  if (changed) {
    logger.info("settings changed; restarting agent to apply");
    tray.setState("connecting", newServer);
    try {
      await restartAgent({}, { platform: process.platform, execPath: process.execPath });
    } catch (err) {
      logger.warn(`restart failed: ${String(err)}; apply changes on next launch`);
    }
  }
}

function currentTrayState(): ConnectionState {
  if (!connection) return "connecting";
  if (connection.isPaused) return "paused";
  if (connection.isConnected) return "connected";
  return lastConnectionState === "paused" ? "disconnected" : lastConnectionState;
}

connection = new AgentConnection({
  serverUrl,
  token,
  name,
  agentId: settings.agentId,
  paused: settings.paused,
  host: os.hostname(),
  os: `${os.type()} ${os.release()}`,
  version: VERSION,
  tags,
  caps: CAPS,
  onJobRequest: (msg) => jobs.handleRequest(msg),
  onJobCancel: (msg) => jobs.handleCancel(msg),
  onIdAssigned: (id) => {
    void settings.setAgentId(id).catch((err) => logger.debug(`could not persist agent id: ${String(err)}`));
  },
  onWelcome: (msg) => {
    if (autoUpdateScheduled) return; // one attempt per process; a failure retries next start
    autoUpdateScheduled = true;
    void handleAutoUpdate(msg, {
      currentVersion: VERSION,
      enabled: autoUpdateEnabled,
      serverUrl,
      platform: process.platform,
      standalone: Bun.isStandaloneExecutable,
      log: (line, fields) => logger.info(line, fields),
    }).catch((err) => logger.error(`auto-update failed: ${err instanceof Error ? err.message : String(err)}`));
  },
  onStateChange: (state) => {
    lastConnectionState = state;
    logger.info(`state: ${state}`);
    if (state === "disconnected") jobs.cancelAll();
    tray.setState(currentTrayState());
  },
  onFatal: (reason) => {
    logger.error(`fatal: ${reason}`);
    tray.setState("disconnected", reason);
    void shutdown(`fatal: ${reason}`, 1);
  },
  log: (level, msg, fields) => logger[level](msg, fields),
});

logger.info("agent starting", {
  version: VERSION,
  name,
  server: serverUrl,
  host: os.hostname(),
  os: `${os.type()} ${os.release()}`,
  tags,
  paused: settings.paused,
  configFile: settings.configPath ?? null,
  logFile: logFile ?? null,
  tray: trayWanted,
});

tray.start();
tray.setState(currentTrayState());
connection.start();

function shutdown(signal: string, exitCode = 0): void {
  logger.info("shutting down", { signal });
  jobs.cancelAll();
  connection?.stop();
  void tray.stop().then(() => process.exit(exitCode));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Dev convenience: pause/resume/quit on stdin (ignored when there is no stdin).
try {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    for (const raw of String(chunk).split("\n")) {
      const cmd = raw.trim().toLowerCase();
      if (cmd === "pause") connection?.pause();
      else if (cmd === "resume") connection?.resume();
      else if (cmd === "quit") shutdown("stdin quit");
      else if (cmd) logger.info(`unknown stdin command '${cmd}'`);
    }
  });
} catch {
  // No stdin (e.g. compiled exe with a hidden console): nothing to read.
}
