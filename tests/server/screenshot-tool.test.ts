import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decodeScreenshotOutcome } from "../../server/src/tools/agent-screenshot.ts";
import type { JobOutcome } from "../../server/src/hub.ts";

const IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function outcome(overrides: Partial<JobOutcome> = {}): JobOutcome {
  return {
    jobId: "job-1",
    ok: true,
    durationMs: 5,
    stdout: IMAGE.toString("base64"),
    stderr: "",
    truncated: false,
    meta: { bytes: IMAGE.length, sha256: createHash("sha256").update(IMAGE).digest("hex") },
    ...overrides,
  };
}

test("decodeScreenshotOutcome accepts a matching base64 payload", () => {
  const result = decodeScreenshotOutcome(outcome());
  expect("bytes" in result).toBe(true);
  if ("bytes" in result) expect(result.bytes.equals(IMAGE)).toBe(true);
});

test("decodeScreenshotOutcome rejects a size mismatch", () => {
  const result = decodeScreenshotOutcome(outcome({ meta: { bytes: IMAGE.length + 1, sha256: "x" } }));
  expect("error" in result && result.error).toContain("size mismatch");
});

test("decodeScreenshotOutcome rejects a checksum mismatch", () => {
  const result = decodeScreenshotOutcome(outcome({ meta: { bytes: IMAGE.length, sha256: "0".repeat(64) } }));
  expect("error" in result && result.error).toContain("checksum mismatch");
});

test("decodeScreenshotOutcome rejects missing metadata", () => {
  const result = decodeScreenshotOutcome(outcome({ meta: {} }));
  expect("error" in result && result.error).toContain("did not report image metadata");
});

test("decodeScreenshotOutcome rejects truncated output", () => {
  const result = decodeScreenshotOutcome(outcome({ truncated: true }));
  expect("error" in result && result.error).toContain("job output buffer");
});
