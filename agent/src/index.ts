#!/usr/bin/env bun
/**
 * mcp-remote-control agent (rc-agent) -- Linux/dev build.
 *
 * Connects outbound to the central server and serves jobs (exec for now).
 * The Windows tray app lands in F3; this entry is cross-platform so the whole
 * pipeline can be developed and tested without Windows.
 *
 * Usage:
 *   bun run agent -- --server ws://127.0.0.1:8787 --token dev-token --name PC-01 [--tags a,b]
 *                   [--paused] [--id ag_xxx] [--log-level debug] [--max-jobs 4]
 *   stdin commands: pause | resume | quit
 */
import os from "node:os";
import { argFlag, argString, parseArgv } from "@mrc/shared/args";
import { logger, setLogLevel, type LogLevel } from "@mrc/shared/log";
import { AgentConnection } from "./connection.ts";
import { JobManager } from "./jobs.ts";

const VERSION = "0.2.0";

const args = parseArgv(process.argv.slice(2));
setLogLevel((argString(args, "log-level") ?? process.env.MRC_LOG_LEVEL ?? "info") as LogLevel);

const serverUrl = argString(args, "server") ?? process.env.MRC_SERVER ?? "ws://127.0.0.1:8787";
const token = argString(args, "token") ?? process.env.MRC_TOKEN ?? "dev-token";
const name = argString(args, "name") ?? process.env.MRC_NAME ?? os.hostname();
const tags = (argString(args, "tags") ?? "")
  .split(",")
  .map((tag) => tag.trim())
  .filter(Boolean);

let connection: AgentConnection | null = null;

const jobs = new JobManager({
  send: (msg) => connection?.send(msg),
  log: (msg, fields) => logger.debug(msg, fields),
  maxConcurrent: Number(argString(args, "max-jobs") ?? 4),
});

connection = new AgentConnection({
  serverUrl,
  token,
  name,
  agentId: argString(args, "id"),
  paused: argFlag(args, "paused"),
  host: os.hostname(),
  os: `${os.type()} ${os.release()}`,
  version: VERSION,
  tags,
  caps: ["exec"],
  onJobRequest: (msg) => jobs.handleRequest(msg),
  onJobCancel: (msg) => jobs.handleCancel(msg),
  onStateChange: (state) => {
    logger.info(`state: ${state}`);
    if (state === "disconnected") jobs.cancelAll();
  },
  onFatal: (reason) => {
    logger.error(`fatal: ${reason}`);
    process.exit(1);
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
  paused: argFlag(args, "paused"),
});
connection.start();

function shutdown(signal: string): void {
  logger.info("shutting down", { signal });
  jobs.cancelAll();
  connection?.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Dev convenience: pause/resume/quit on stdin (ignored when there is no stdin).
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
