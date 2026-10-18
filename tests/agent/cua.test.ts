/**
 * Unit tests for the CUA sidecar runner (agent/src/cua.ts).
 *
 * The real sidecar (mrc-cua.exe) is Windows-only; here a POSIX shell script
 * stands in for it: the runner treats any executable the same way (spawn with
 * `--key value` args, read one JSON object from stdout, map exit codes).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCuaExe, runCuaCall } from "../../agent/src/cua.ts";

let dir: string | null = null;
let counter = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrc-cua-test-"));
  counter = 0;
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

function fakeExe(body: string): string {
  if (!dir) throw new Error("temp dir missing");
  const path = join(dir, `fake-cua-${counter++}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

test("runCuaCall passes sidecar JSON through as meta", async () => {
  const exe = fakeExe(`printf '%s' '{"ok":true,"answer":42,"path":"C:\\\\temp\\\\x.png"}'`);
  const result = await runCuaCall({ tool: "ping", args: {} }, { exe });
  expect(result.meta).toEqual({ ok: true, answer: 42, path: "C:\\temp\\x.png" });
});

test("runCuaCall maps ok:false to a thrown error", async () => {
  const exe = fakeExe(`printf '%s' '{"ok":false,"error":"window not found"}'`);
  expect(runCuaCall({ tool: "click", args: {} }, { exe })).rejects.toThrow("window not found");
});

test("runCuaCall reports nonzero sidecar exits", async () => {
  const exe = fakeExe(`exit 3`);
  expect(runCuaCall({ tool: "list_windows", args: {} }, { exe })).rejects.toThrow("cua sidecar exited 3");
});

test("runCuaCall rejects non-JSON output", async () => {
  const exe = fakeExe(`printf '%s' 'not json'`);
  expect(runCuaCall({ tool: "list_windows", args: {} }, { exe })).rejects.toThrow("cua sidecar output is not JSON");
});

test("runCuaCall rejects silent sidecars", async () => {
  const exe = fakeExe(`exit 0`);
  expect(runCuaCall({ tool: "list_windows", args: {} }, { exe })).rejects.toThrow("cua sidecar produced no output");
});

test("runCuaCall forwards tool and args as --key value pairs", async () => {
  const exe = fakeExe(`printf '{"ok":true,"argv":["%s","%s","%s","%s"]}' "$1" "$2" "$3" "$4"`);
  const result = await runCuaCall(
    { tool: "click", args: { x: 10, window_id: 42, confirm: true } },
    { exe },
  );
  expect(result.meta).toEqual({ ok: true, argv: ["click", "--x", "10", "--window_id"] });
});

test("runCuaCall kills runaway sidecars", async () => {
  const exe = fakeExe(`sleep 30`);
  expect(runCuaCall({ tool: "ping", args: {}, timeoutMs: 120 }, { exe })).rejects.toThrow(/cua sidecar/);
});

test("ensureCuaExe fails with a clear error on POSIX when nothing is found", async () => {
  expect(ensureCuaExe({ exe: "/nonexistent/mrc-cua.exe" })).rejects.toThrow("cua sidecar not found");
});
