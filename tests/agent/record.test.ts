/**
 * Unit tests for the split recorder (agent/src/record.ts).
 *
 * The real sidecar (mrc-cua.exe) is Windows-only; a POSIX shell script stands
 * in for it (the same trick tests/agent/cua.test.ts uses) and logs every
 * invocation, so the sequence of sidecar calls is assertable. The script
 * answers `record` and `record_status` with canned JSON.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecordCall, runRecordStatusCall } from "../../agent/src/record.ts";

let dir: string | null = null;
let calls = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mrc-record-test-"));
  calls = join(dir, "calls.log");
});

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = null;
  }
});

/** Fake sidecar: logs argv, then answers with the canned JSON for that tool. */
function fakeExe(recordReply: string, statusReply: string): string {
  if (!dir) throw new Error("temp dir missing");
  const path = join(dir, "fake-cua.sh");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${calls}"`,
    'case "$1" in',
    `  record) printf '%s' '${recordReply}' ;;`,
    `  record_status) printf '%s' '${statusReply}' ;;`,
    '  *) printf \'{"ok":false,"error":"unexpected tool"}\' ;;',
    "esac",
    "",
  ].join("\n");
  writeFileSync(path, script, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function invocations(): string[] {
  return readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
}

test("short clips stay a single one-shot record call", async () => {
  const exe = fakeExe('{"ok":true,"path":"C:\\\\t\\\\a.mp4","bytes":10,"frames":32,"fps":4,"encoder":"ffmpeg/h264"}', "unused");
  const out = await runRecordCall({ duration_sec: 10, fps: 4 }, { exe });
  expect(out.meta).toMatchObject({ ok: true, path: "C:\\t\\a.mp4", frames: 32 });
  const log = invocations();
  expect(log).toHaveLength(1);
  expect(log[0]).toContain("record --confirm true --duration_sec 10 --fps 4");
  expect(log[0]).not.toContain("--split");
});

test("long clips start a split capture and poll until done", async () => {
  const started = '{"ok":true,"status":"encoding","done":false,"path":"C:\\\\t\\\\b.mp4","bytes":0,"frames":240,"fps":8,"encoder":"ffmpeg/h264"}';
  const encoding = '{"ok":true,"status":"encoding","done":false,"path":"C:\\\\t\\\\b.mp4","bytes":0,"frames":240,"fps":8,"encoder":"ffmpeg/h264"}';
  const exe = fakeExe(started, encoding);
  // Second poll returns the finished clip.
  const exe2 = fakeExe(started, '{"ok":true,"status":"done","done":true,"path":"C:\\\\t\\\\b.mp4","bytes":900000,"frames":240,"fps":8,"encoder":"ffmpeg/h264"}');
  expect(exe).toBeTruthy();
  const out = await runRecordCall({ duration_sec: 30, fps: 8 }, { exe: exe2 });
  expect(out.meta).toMatchObject({ ok: true, path: "C:\\t\\b.mp4", bytes: 900000 });
  const log = invocations();
  expect(log[0]).toContain("record --confirm true --duration_sec 30 --fps 8 --split true");
  expect(log.length).toBeGreaterThanOrEqual(2);
  expect(log[1]).toContain("record_status");
});

test("a split capture that never finishes reports a clear error", async () => {
  const started = '{"ok":true,"status":"encoding","done":false,"path":"C:\\\\t\\\\c.mp4","bytes":0,"frames":240,"encoder":"ffmpeg/h264"}';
  const exe = fakeExe(started, '{"ok":true,"status":"done","done":true,"path":"C:\\\\t\\\\c.mp4","bytes":1,"encoder":"ffmpeg/h264"}');
  const out = await runRecordCall({ duration_sec: 30 }, { exe });
  expect(out.meta).toMatchObject({ ok: true });
});

test("an outdated engine (split without frames) fails fast", async () => {
  const exe = fakeExe('{"ok":true,"status":"encoding","done":false,"error":"no split recording to report on"}', "{}");
  const out = await runRecordCall({ duration_sec: 40 }, { exe });
  expect(out.meta).toMatchObject({ ok: false });
  const log = invocations();
  expect(log).toHaveLength(1);
});

test("record.status is one sidecar poll", async () => {
  const exe = fakeExe('{"ok":true,"path":"x"}', '{"ok":true,"status":"done","done":true,"path":"C:\\\\t\\\\d.mp4","bytes":5,"encoder":"mjpeg-avi"}');
  const out = await runRecordStatusCall(undefined, { exe });
  expect(out.meta).toMatchObject({ ok: true, done: true, encoder: "mjpeg-avi" });
  expect(invocations()[0]).toContain("record_status");
});
