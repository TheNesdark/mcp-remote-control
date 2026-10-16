/**
 * AuditLog: append-only JSONL audit trail of everything the server does.
 *
 * Each line records who (tool call, admin CLI, hub event), which agent, the
 * operation, sanitized parameters, the outcome, duration and transferred
 * bytes when applicable. Rotates at `maxBytes` keeping one `<path>.1`.
 * Writes are synchronous and best-effort: auditing never breaks the caller.
 */
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditActor = "tool" | "admin" | "hub";

export interface AuditEntry {
  ts: string;
  actor: AuditActor;
  op: string;
  agent?: string;
  params?: unknown;
  ok: boolean;
  error?: string;
  durationMs?: number;
  bytes?: number;
}

const SENSITIVE_KEYS = /token|secret|password|authorization/i;

/** Redact secrets and cap the serialized size (transfers carry big blobs). */
export function sanitizeParams(params: unknown, maxChars = 1024): unknown {
  let text: string;
  try {
    text =
      JSON.stringify(params, (key, value: unknown) =>
        SENSITIVE_KEYS.test(key) ? "[redacted]" : value,
      ) ?? "null";
  } catch {
    return "[unserializable params]";
  }
  if (text.length <= maxChars) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return `${text.slice(0, maxChars)}…(truncated)`;
}

export class AuditLog {
  constructor(
    private readonly path: string,
    private readonly maxBytes = 10 * 1024 * 1024,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: Omit<AuditEntry, "ts">): void {
    try {
      this.rotateIfNeeded();
      appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
    } catch {
      // Auditing must never break the caller.
    }
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try {
      if (!existsSync(this.path)) return;
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size <= this.maxBytes) return;
    try {
      unlinkSync(`${this.path}.1`);
    } catch {
      // no previous rotation
    }
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // ignore
    }
  }
}

/** Pick transferred bytes out of a job result meta (fs.write/read, screenshot). */
export function pickResultBytes(meta: Record<string, unknown> | undefined): number | undefined {
  if (!meta) return undefined;
  for (const key of ["bytes", "bytesWritten", "bytesRead"]) {
    const value = meta[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export interface ToolCallAudit {
  op: string;
  agent?: string;
  params?: unknown;
  startedAt: number;
  ok: boolean;
  error?: string;
  bytes?: number;
}

/** One-line audit entry for tool handlers that do their own orchestration. */
export function auditToolCall(audit: AuditLog, call: ToolCallAudit): void {
  const entry: Omit<AuditEntry, "ts"> = {
    actor: "tool",
    op: call.op,
    agent: call.agent,
    params: sanitizeParams(call.params),
    ok: call.ok,
    durationMs: Date.now() - call.startedAt,
  };
  if (call.error) entry.error = call.error;
  if (call.bytes !== undefined) entry.bytes = call.bytes;
  audit.append(entry);
}
