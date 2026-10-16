/**
 * Tiny leveled logger shared by the server and the agent.
 * Writes to stderr (English) so stdout stays clean for stdio protocols.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[currentLevel]) return;
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), msg];
  if (fields && Object.keys(fields).length > 0) parts.push(JSON.stringify(fields));
  console.error(parts.join(" "));
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => log("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
