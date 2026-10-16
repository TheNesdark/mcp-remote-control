/**
 * Tiny leveled logger shared by the server and the agent.
 * Writes to stderr (English) so stdout stays clean for stdio protocols.
 * Optionally mirrors to a rotating file (used by the Windows agent so the
 * tray "Open logs" menu has something to open).
 */
import { closeSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_LOG_BYTES = 5 * 1024 * 1024;

let currentLevel: LogLevel = "info";
let sink: { fd: number; path: string; size: number } | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Mirror logs to `path` (append, one rotation at 5 MB keeping `path.1`).
 * Pass null to disable. Failures fall back to stderr-only logging.
 */
export function setLogFile(path: string | null): void {
  if (sink) {
    try {
      closeSync(sink.fd);
    } catch {
      // already closed
    }
    sink = null;
  }
  if (!path) return;
  try {
    const fd = openSync(path, "a");
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    sink = { fd, path, size };
  } catch (err) {
    console.error(`${new Date().toISOString()} ERROR failed to open log file ${path}: ${String(err)}`);
  }
}

/** Current size of the log file sink (tests). */
export function logFileSize(): number | null {
  return sink?.size ?? null;
}

function rotate(): void {
  if (!sink) return;
  const { path } = sink;
  try {
    closeSync(sink.fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(`${path}.1`);
  } catch {
    // no previous rotation
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // ignore
  }
  const fd = openSync(path, "a");
  sink = { fd, path, size: 0 };
}

function writeToSink(line: string): void {
  if (!sink) return;
  try {
    if (sink.size > MAX_LOG_BYTES) rotate();
    const text = `${line}\n`;
    writeSync(sink.fd, text);
    sink.size += Buffer.byteLength(text);
  } catch {
    // Logging must never break the caller.
  }
}

function format(level: LogLevel, msg: string, fields?: Record<string, unknown>): string {
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), msg];
  if (fields && Object.keys(fields).length > 0) parts.push(JSON.stringify(fields));
  return parts.join(" ");
}

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const line = format(level, msg, fields);
  console.error(line);
  writeToSink(line);
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
