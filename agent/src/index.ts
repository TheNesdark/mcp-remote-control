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
import { TrayIntegration } from "./tray.ts";
import { installedDriverVersion, provisionCuaDriver, type CuaAnnouncement } from "./cua.ts";
import type { CuaBridge } from "./cua-job.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { VERSION } from "@mrc/shared/version";

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

const BASE_CAPS = ["exec", "fs", "info", "ps", "screenshot", "restart"];
// Cua Driver: `cua` only when the exe actually runs on this box. Re-probed
// after provisioning; the new set is pushed with a `caps` frame.
let driverVersion: string | null =
  process.platform === "win32" ? installedDriverVersion() : null;
function currentCaps(): string[] {
  return driverVersion ? [...BASE_CAPS, "cua"] : [...BASE_CAPS];
}
let cuaAnnouncement: CuaAnnouncement | null = null;
function hubOrigin(): string {
  // ws(s)://host:port/... -> http(s)://host:port (where /cua/latest.zip is served)
  try {
    const url = new URL(serverUrl);
    const scheme = url.protocol === "wss:" ? "https:" : "http:";
    return `${scheme}//${url.host}`;
  } catch {
    return "";
  }
}
let autoProvisionRunning = false;
async function autoProvisionCua(): Promise<void> {
  if (process.platform !== "win32" || !cuaAnnouncement || autoProvisionRunning) return;
  autoProvisionRunning = true;
  try {
    const result = await provisionCuaDriver(cuaAnnouncement, { hubOrigin: hubOrigin(), token });
    if (driverVersion !== result.version) {
      driverVersion = result.version;
      logger.info("Cua Driver ready", { version: result.version, downloaded: result.downloaded });
      connection?.send({ type: "caps", caps: currentCaps() });
    }
  } catch (err) {
    logger.warn(`Cua Driver provisioning failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    autoProvisionRunning = false;
  }
}

const agentContext = () => ({
  name,
  version: VERSION,
  agentId: connection?.agentId ?? settings.agentId ?? null,
  server: serverUrl,
  caps: currentCaps(),
});

const jobs = new JobManager({
  send: (msg) => connection?.send(msg),
  log: (msg, fields) => logger.debug(msg, fields),
  maxConcurrent: Number(argString(args, "max-jobs") ?? 4),
  context: agentContext,
  ...(process.platform === "win32"
    ? {
        cua: {
          announcement: () => cuaAnnouncement,
          hubOrigin,
          token: () => token,
        } satisfies CuaBridge,
      }
    : {}),
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
    // Apply in the running process: hello carries name/server/token, so a
    // fresh reconnect is enough (a full restart used to leave the old process
    // owning the hub connection, pinning the tray at "connecting").
    logger.info("settings changed; reconnecting with the new values");
    name = newName;
    serverUrl = newServer;
    token = newToken;
    connection?.reconfigure({ name: newName, serverUrl: newServer, token: newToken });
    tray.setLabel(newName);
    tray.setState("connecting", newServer);
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
  caps: currentCaps(),
  onJobRequest: (msg) => jobs.handleRequest(msg),
  onJobCancel: (msg) => jobs.handleCancel(msg),
  onIdAssigned: (id) => {
    void settings.setAgentId(id).catch((err) => logger.debug(`could not persist agent id: ${String(err)}`));
  },
  onWelcome: (msg) => {
    if (msg.cuaDriverVersion && msg.cuaDriverUrl && msg.cuaDriverSha256) {
      cuaAnnouncement = { version: msg.cuaDriverVersion, url: msg.cuaDriverUrl, sha256: msg.cuaDriverSha256 };
      void autoProvisionCua();
    }
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

let shuttingDown = false;
function shutdown(signal: string, exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down", { signal });
  // The tray helper or the websocket must never keep the process alive: the
  // user picked Exit and expects it gone, so force the exit as a backstop.
  const force = setTimeout(() => process.exit(exitCode), 1500);
  force.unref();
  try {
    jobs.cancelAll();
    connection?.stop();
  } catch (err) {
    logger.warn(`shutdown cleanup failed: ${String(err)}`);
  }
  void tray
    .stop()
    .catch((err) => logger.warn(`tray stop failed: ${String(err)}`))
    .finally(() => process.exit(exitCode));
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
