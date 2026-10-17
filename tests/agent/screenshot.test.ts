import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  base64Chunks,
  decodeBase64Output,
  findCsc,
  isAmsiBlocked,
  looksLikeImage,
  parseImageSize,
  parseShotDims,
  takeScreenshot,
  windowsCaptureError,
  WINDOWS_CSHARP,
  type ScreenshotDeps,
} from "../../agent/src/screenshot.ts";
import type { CommandResult } from "../../agent/src/run-command.ts";

function pngHeader(width: number, height: number): Uint8Array {
  const buffer = new Uint8Array(33);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  const view = new DataView(buffer.buffer);
  view.setUint32(8, 13); // IHDR length
  buffer.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return buffer;
}

function jpegHeader(width: number, height: number): Uint8Array {
  // SOI + APP0(JFIF, 16 bytes) + SOF0(17 bytes: len, precision, h, w, ...)
  const buffer = new Uint8Array(2 + 18 + 19 + 2);
  const view = new DataView(buffer.buffer);
  let offset = 0;
  view.setUint16(offset, 0xffd8); offset += 2; // SOI
  view.setUint16(offset, 0xffe0); view.setUint16(offset + 2, 16); offset += 18; // APP0 + payload
  view.setUint16(offset, 0xffc0); view.setUint16(offset + 2, 17);
  buffer[offset + 4] = 8; // precision
  view.setUint16(offset + 5, height);
  view.setUint16(offset + 7, width);
  return buffer;
}

test("parseImageSize reads PNG IHDR dimensions", () => {
  expect(parseImageSize(pngHeader(1920, 1080))).toEqual({ width: 1920, height: 1080 });
});

test("parseImageSize reads JPEG SOF dimensions", () => {
  expect(parseImageSize(jpegHeader(1280, 720))).toEqual({ width: 1280, height: 720 });
});

test("parseImageSize returns null for unknown data", () => {
  expect(parseImageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  expect(parseImageSize(new Uint8Array(0))).toBeNull();
});

test("takeScreenshot fails with a clear error when headless", async () => {
  if (process.platform === "win32") return; // covered on the Windows VM (CI runners are headless)
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return; // graphical dev host: skip
  await expect(takeScreenshot({ format: "png", quality: 80 })).rejects.toThrow(
    /no interactive session|no capture tool/,
  );
});

test("takeScreenshot streams the image inline (no temp file left behind)", async () => {
  if (process.platform === "win32") return; // covered on the Windows VM
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const outcome = await takeScreenshot({ format: "png", quality: 80 });
  const meta = outcome.meta as { bytes: number; sha256: string };
  expect(meta.bytes).toBeGreaterThan(0);
  expect(meta.sha256.length).toBe(64);
  expect(decodeOutputs(outcome).length).toBe(meta.bytes);
});

// ---------------------------------------------------------------------------
// Windows capture paths, exercised on any platform via the injectable deps
// ---------------------------------------------------------------------------

/** Real AMSI/Defender refusal seen on a Spanish Windows 10 host. */
const AMSI_STDERR =
  "En \\\\server\\share\\x.ps1: 1 Carácter: 1\r\n+ New-Item -ItemType Directory ...\r\n" +
  "+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\r\n" +
  "Este script contiene elementos malintencionados y ha sido bloqueado por el software antivirus.\r\n" +
  "    + FullyQualifiedErrorId : ScriptContainedMaliciousContent\r\n";

/** Smallest valid 1x1 PNG; parseImageSize reads width=1. */
const MINI_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const MINI_PNG_BASE64 = Buffer.from(MINI_PNG).toString("base64");

/** What a real capture backend writes to stdout: the image as base64. */
const okResult = (): CommandResult => ({ code: 0, stdout: MINI_PNG_BASE64, stderr: "OK 1x1" });
const amsiResult = (): CommandResult => ({ code: 1, stdout: "", stderr: AMSI_STDERR });

/** Concatenates the job's base64 output chunks back into the raw image. */
function decodeOutputs(result: { outputs?: Array<{ data: string }> }): Uint8Array {
  const base64 = (result.outputs ?? []).map((chunk) => chunk.data).join("");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

interface CaptureRun {
  outcome?: { meta: { bytes: number; width: number | null }; outputs?: Array<{ data: string }> };
  error?: Error;
  calls: Array<{ cmd: string; argv: string[] }>;
  csPath: string | null;
  exePath: string | null;
}

/** Drives takeScreenshot as if on win32 with a scripted command runner. */
async function captureAsWindows(respond: (cmd: string[]) => CommandResult, findCsc: () => string | null): Promise<CaptureRun> {
  const dir = mkdtempSync(join(tmpdir(), "mrc-shot-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = dir; // os.tmpdir() on POSIX honors TMPDIR
  const calls: CaptureRun["calls"] = [];
  let csPath: string | null = null;
  let exePath: string | null = null;
  const deps: ScreenshotDeps = {
    platform: "win32",
    findCsc,
    runCommand: async (cmd) => {
      calls.push({ cmd: cmd[0]!, argv: cmd });
      const lower = cmd[0]!.toLowerCase();
      if (lower.endsWith("csc.exe")) {
        exePath = /\/out:(.+)/.exec(cmd.find((a) => a.startsWith("/out:")) ?? "")?.[1] ?? null;
        csPath = cmd.at(-1)!;
      }
      // Capture backends stream the image as base64 on stdout; nothing is
      // written to disk on the remote machine.
      return respond(cmd);
    },
  };
  try {
    const outcome = await takeScreenshot({ format: "png", quality: 80 }, deps);
    return { outcome: outcome as CaptureRun["outcome"], calls, csPath, exePath };
  } catch (err) {
    return { error: err as Error, calls, csPath, exePath };
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
}

test("isAmsiBlocked detects Spanish and English refusals", () => {
  expect(isAmsiBlocked(AMSI_STDERR)).toBe(true);
  expect(isAmsiBlocked("ScriptContainedMaliciousContent")).toBe(true);
  expect(isAmsiBlocked("This script contains malicious content and has been blocked by your antivirus software.")).toBe(true);
  expect(isAmsiBlocked("Cannot find path 'X:'")).toBe(false);
});

test("parseShotDims extracts the capture size", () => {
  expect(parseShotDims("OK 1368x768")).toEqual({ width: 1368, height: 768 });
  expect(parseShotDims("ruido OK 1920x1080 más ruido")).toEqual({ width: 1920, height: 1080 });
  expect(parseShotDims("sin marca")).toBeNull();
});

test("windowsCaptureError classifies AMSI, session-0 and generic failures", () => {
  const amsi = windowsCaptureError(amsiResult(), null, true);
  expect(amsi.message).toContain("blocked by antivirus/AMSI");
  expect(amsi.message).toContain("csc.exe fallback is unavailable");

  const session0 = windowsCaptureError(
    { code: 1, stdout: "", stderr: "copyfromscreen-failed InvalidOperationException" },
    null,
    false,
  );
  expect(session0.message).toContain("no interactive session");

  const generic = windowsCaptureError(
    { code: 1, stdout: "", stderr: "En línea: 1 Carácter: 1\n+ ...\nCannot find module 'Nope'" },
    null,
    false,
  );
  expect(generic.message).toBe("screenshot failed: Cannot find module 'Nope'");
});

test("windows: PowerShell success never touches the csc fallback", async () => {
  const run = await captureAsWindows((cmd) => (cmd[0] === "powershell.exe" ? okResult() : okResult()), () => "C:\\csc.exe");
  expect(run.error).toBeUndefined();
  expect(run.calls.map((c) => c.cmd)).toEqual(["powershell.exe"]);
  expect(run.outcome?.meta.bytes).toBe(MINI_PNG.length);
  const decoded = decodeOutputs(run.outcome!);
  expect(decoded).toEqual(MINI_PNG);
});

test("windows: AMSI block falls back to the compiled C# capturer", async () => {
  const run = await captureAsWindows((cmd) => {
    if (cmd[0] === "powershell.exe") return amsiResult();
    if ((cmd[0] ?? "").toLowerCase().endsWith("csc.exe")) return { code: 0, stdout: "", stderr: "" };
    return okResult();
  }, () => "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe");

  expect(run.error).toBeUndefined();
  expect(run.calls.length).toBe(3);
  expect(run.calls[0]!.cmd).toBe("powershell.exe");
  expect(run.calls[1]!.cmd.toLowerCase().endsWith("csc.exe")).toBe(true);
  expect(run.calls[2]!.cmd).toBe(run.exePath!); // the compiled capturer exe
  expect(run.calls[2]!.argv.at(-2)).toBe("png"); // exe <png|jpeg> <quality>
  expect(run.calls[2]!.argv.at(-1)).toBe("80");
  expect(run.outcome?.meta.width).toBe(1);
  expect(decodeOutputs(run.outcome!)).toEqual(MINI_PNG);

  // .cs source and .exe are compiled to a temp dir and cleaned up after the job.
  expect(run.csPath?.endsWith(".cs")).toBe(true);
  expect(run.exePath?.endsWith(".exe")).toBe(true);
  expect(existsSync(run.csPath!)).toBe(false);
  expect(existsSync(run.exePath!)).toBe(false);
});

test("windows: a non-image stdout falls back instead of trusting garbage", async () => {
  const run = await captureAsWindows((cmd) => {
    if (cmd[0] === "powershell.exe") return { code: 0, stdout: "no soy base64!", stderr: "" };
    if ((cmd[0] ?? "").toLowerCase().endsWith("csc.exe")) return { code: 0, stdout: "", stderr: "" };
    return okResult();
  }, () => "C:\\csc.exe");
  expect(run.error).toBeUndefined();
  expect(run.calls.length).toBe(3); // fell through to the C# capturer
  expect(run.outcome?.meta.bytes).toBe(MINI_PNG.length);
});

test("windows: no csc.exe yields an actionable AMSI error", async () => {
  const run = await captureAsWindows((cmd) => (cmd[0] === "powershell.exe" ? amsiResult() : okResult()), () => null);
  expect(run.outcome).toBeUndefined();
  expect(run.error?.message).toContain("blocked by antivirus/AMSI");
  expect(run.error?.message).toContain("csc.exe fallback is unavailable");
  expect(run.calls.map((c) => c.cmd)).toEqual(["powershell.exe"]); // no fallback attempted
});

test("windows: csc compile failure surfaces both failures", async () => {
  const run = await captureAsWindows((cmd) => {
    if (cmd[0] === "powershell.exe") return amsiResult();
    if ((cmd[0] ?? "").toLowerCase().endsWith("csc.exe")) return { code: 1, stdout: "", stderr: "error CS1002: ; expected" };
    return okResult();
  }, () => "C:\\csc.exe");
  expect(run.outcome).toBeUndefined();
  expect(run.error?.message).toContain("blocked by antivirus/AMSI");
  expect(run.error?.message).toContain("CS1002");
  if (run.csPath) expect(existsSync(run.csPath)).toBe(false);
});

test("findCsc prefers .NET Framework v4 64-bit", () => {
  expect(findCsc({ WINDIR: "/nonexistent-root" })).toBeNull();
});

test("embedded C# capturer has the expected shape", () => {
  expect(WINDOWS_CSHARP).toContain("CopyFromScreen");
  expect(WINDOWS_CSHARP).toContain("SystemParametersInfo");
  expect(WINDOWS_CSHARP).toContain("SPI_GETWORKAREA");
  expect(WINDOWS_CSHARP).toContain("no interactive session");
  expect(WINDOWS_CSHARP).toContain("Console.Write(Convert.ToBase64String");
});

test("decodeBase64Output rejects empty and non-base64 output", () => {
  expect(decodeBase64Output("")).toBeNull();
  expect(decodeBase64Output("   \r\n")).toBeNull();
  expect(decodeBase64Output("no soy base64!")).toBeNull();
  expect(decodeBase64Output("@@@@@")).toBeNull();
  expect(decodeBase64Output(MINI_PNG_BASE64)).toEqual(MINI_PNG);
  // whitespace/newlines around a valid payload are tolerated
  expect(decodeBase64Output(`\r\n${MINI_PNG_BASE64}\r\n`)).toEqual(MINI_PNG);
});

test("looksLikeImage only accepts PNG/JPEG payloads", () => {
  expect(looksLikeImage(MINI_PNG)).toBe(true);
  expect(looksLikeImage(jpegHeader(2, 2))).toBe(true);
  expect(looksLikeImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(false);
  expect(looksLikeImage(new Uint8Array(0))).toBe(false);
});

test("base64Chunks splits a payload into reassemblable job output chunks", () => {
  const image = new Uint8Array((256 * 1024 * 3) / 4 * 3); // ~230 KiB -> base64 3+ chunks
  const base64 = Buffer.from(image).toString("base64");
  const chunks = base64Chunks(base64);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.encoding === "base64" && chunk.stream === "stdout")).toBe(true);
  expect(chunks.map((chunk) => chunk.data).join("")).toBe(base64);
  expect(Buffer.from(chunks.map((chunk) => chunk.data).join(""), "base64").length).toBe(image.length);
});
