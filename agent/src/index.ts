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
import { loadSettings } from "./settings.ts";
import { TrayIntegration } from "./tray.ts";

const VERSION = "0.5.1";

const args = parseArgv(process.argv.slice(2));
setLogLevel((argString(args, "log-level") ?? process.env.MRC_LOG_LEVEL ?? "info") as LogLevel);

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

const serverUrl = settings.server;
const token = settings.token;
const name = settings.name;
const tags = settings.tags;

// File logging (so the tray "Open logs" menu has something to open).
const logFile = settings.logFile;
if (logFile) setLogFile(logFile);

if (settings.usingDefaultToken) {
  logger.warn("using the insecure development token; set --token or MRC_TOKEN in production");
}

let connection: AgentConnection | null = null;
let trayWanted = argFlag(args, "tray") || (process.platform === "win32" && !argFlag(args, "no-tray"));
if (argFlag(args, "no-tray")) trayWanted = false;

const CAPS = ["exec", "fs", "info", "ps", "screenshot"];

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
  onAutostart: (enabled) => {
    void settings.setAutostart(enabled).catch((err) => logger.warn(`autostart change failed: ${String(err)}`));
  },
  onExit: () => void shutdown("tray exit"),
});

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
