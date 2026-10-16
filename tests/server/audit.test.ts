import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog, sanitizeParams } from "../../server/src/audit.ts";

test("sanitizeParams redacts secrets and truncates big blobs", () => {
  const redacted = sanitizeParams({ command: "echo hi", token: "mrc_secret", nested: { password: "x" } }) as Record<
    string,
    unknown
  >;
  expect(redacted.command).toBe("echo hi");
  expect(redacted.token).toBe("[redacted]");
  expect((redacted.nested as Record<string, unknown>).password).toBe("[redacted]");

  const big = sanitizeParams({ content: "A".repeat(5_000) });
  expect(typeof big).toBe("string");
  expect((big as string).endsWith("…(truncated)")).toBe(true);
  expect((big as string).length).toBeLessThan(1_200);
});

test("audit log appends JSON lines and rotates", () => {
  const dir = mkdtempSync(join(tmpdir(), "mrc-audit-"));
  const path = join(dir, "audit.jsonl");
  const audit = new AuditLog(path, 200);

  audit.append({ actor: "tool", op: "agent_exec", agent: "PC-01", params: { command: "echo hi" }, ok: true, durationMs: 12 });
  audit.append({ actor: "hub", op: "agent:connect", agent: "PC-01", ok: true });
  // Force rotation with a big entry.
  audit.append({ actor: "tool", op: "agent_fs_write", agent: "PC-01", params: { content: "B".repeat(500) }, ok: true, bytes: 500 });

  const rotated = readFileSync(`${path}.1`, "utf8").split("\n").filter(Boolean);
  expect(rotated.length).toBeGreaterThanOrEqual(2);
  const first = JSON.parse(rotated[0]!) as { op: string; ok: boolean; durationMs: number; ts: string };
  expect(first.op).toBe("agent_exec");
  expect(first.ok).toBe(true);
  expect(typeof first.ts).toBe("string");

  const current = readFileSync(path, "utf8").split("\n").filter(Boolean);
  expect(current.length).toBe(1);
  const last = JSON.parse(current[0]!) as { op: string; bytes: number };
  expect(last.op).toBe("agent_fs_write");
  expect(last.bytes).toBe(500);
});
