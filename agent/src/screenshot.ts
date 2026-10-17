/**
 * Screenshot of the primary monitor (`screenshot` job).
 *
 * Windows, in order:
 * 1. PowerShell + System.Windows.Forms/System.Drawing (CopyFromScreen).
 *    Some antivirus/AMSI builds flag that script ("ScriptContainedMaliciousContent")
 *    and refuse to parse it.
 * 2. Fallback: compile a tiny C# capturer with csc.exe (ships with .NET
 *    Framework on every Windows 10/11) and run it. No PowerShell involved.
 * Requires an interactive desktop session: in session 0 or a locked screen
 * CopyFromScreen fails and we surface a clear "no interactive session" error.
 * - POSIX (development only): tries grim (Wayland), scrot or ImageMagick
 *   `import` (X11) and fails with a clear message when there is no graphical
 *   session or no backend installed.
 *
 * The image is written to a temp file on the agent host; the job meta carries
 * its path so the server can pull it down with the chunked fs.read loop.
 */
import os from "node:os";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ScreenshotParams } from "@mrc/shared";
import { sha256File } from "./fs.ts";
import type { ShortJobResult } from "./job-result.ts";
import { runCommand, type CommandResult } from "./run-command.ts";

export const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

export interface ScreenshotMeta {
  path: string;
  format: ScreenshotParams["format"];
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not [Environment]::UserInteractive) {
  throw "no interactive session: screenshot requires a logged-in desktop session (session 0 is not supported)"
}
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
try {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  } finally { $graphics.Dispose() }
  if ($env:MRC_SHOT_FORMAT -eq "jpeg") {
    $encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long][int]$env:MRC_SHOT_QUALITY)
    $bitmap.Save($env:MRC_SHOT_PATH, $encoder, $params)
  } else {
    $bitmap.Save($env:MRC_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png)
  }
} finally { $bitmap.Dispose() }
Write-Output ("OK {0}x{1}" -f $bounds.Width, $bounds.Height)
`;

/**
 * Native C# capturer for the PowerShell fallback (the plan's "Plan B").
 * Compiled with the csc.exe that ships with .NET Framework; args:
 *   mrc-shot.exe <outPath> <png|jpeg> <quality 1-100>
 * Captures the primary monitor work area; prints "OK <w>x<h>" on success.
 */
export const WINDOWS_CSHARP = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

class MrcShot
{
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    static extern bool SystemParametersInfo(int action, int param, ref Rect rect, int flags);

    const int SPI_GETWORKAREA = 0x0030;

    static int Main(string[] argv)
    {
        if (argv.Length < 1) { Console.Error.WriteLine("usage: mrc-shot.exe <out> [png|jpeg] [quality]"); return 2; }
        string outPath = argv[0];
        string format = argv.Length > 1 ? argv[1] : "png";
        long quality = 80;
        if (argv.Length > 2) long.TryParse(argv[2], out quality);

        Rect area = new Rect();
        if (!SystemParametersInfo(SPI_GETWORKAREA, 0, ref area, 0) || area.Right <= area.Left || area.Bottom <= area.Top)
        {
            Console.Error.WriteLine("no interactive session: work area unavailable (no desktop or session 0)");
            return 3;
        }
        int width = area.Right - area.Left;
        int height = area.Bottom - area.Top;

        using (Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb))
        using (Graphics g = Graphics.FromImage(bmp))
        {
            try
            {
                g.CopyFromScreen(area.Left, area.Top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("copyfromscreen-failed " + e.GetType().Name + ": " + e.Message);
                return 4;
            }
            if (format == "jpeg")
            {
                ImageCodecInfo codec = null;
                foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
                    if (c.MimeType == "image/jpeg") { codec = c; break; }
                if (codec == null) { Console.Error.WriteLine("no jpeg encoder"); return 5; }
                using (EncoderParameters ep = new EncoderParameters(1))
                {
                    ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                    bmp.Save(outPath, codec, ep);
                }
            }
            else
            {
                bmp.Save(outPath, ImageFormat.Png);
            }
        }
        Console.WriteLine("OK " + width + "x" + height);
        return 0;
    }
}
`.trimStart();

/** Injectable seams so the Windows flow can be unit-tested on Linux. */
export interface ScreenshotDeps {
  runCommand?: (cmd: string[], opts?: { timeoutMs?: number; env?: Record<string, string | undefined> }) => Promise<CommandResult>;
  platform?: NodeJS.Platform;
  /** Resolves the .NET Framework compiler, or null when it is unavailable. */
  findCsc?: () => string | null;
}

export async function takeScreenshot(params: ScreenshotParams, deps: ScreenshotDeps = {}): Promise<ShortJobResult> {
  const platform = deps.platform ?? process.platform;
  const run = deps.runCommand ?? runCommand;
  const resolveCsc = deps.findCsc ?? (() => findCsc());
  const extension = params.format === "jpeg" ? "jpg" : "png";
  const path = join(os.tmpdir(), `mrc-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`);

  if (platform === "win32") {
    await captureWindows(path, params, run, resolveCsc);
  } else {
    await capturePosix(path);
  }

  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error("screenshot failed: the capture command did not produce a file");
  }
  const bytes = file.size;
  if (bytes === 0) throw new Error("screenshot failed: the captured file is empty");
  if (bytes > MAX_SCREENSHOT_BYTES) {
    throw new Error(`screenshot too large (${bytes} bytes, max ${MAX_SCREENSHOT_BYTES})`);
  }

  const sha256 = await sha256File(path);
  const dimensions = parseImageSize(new Uint8Array(await file.arrayBuffer()));

  const meta: ScreenshotMeta = {
    path,
    format: params.format,
    bytes,
    sha256,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
  };
  return { meta: meta as unknown as Record<string, unknown> };
}

/** Well-known .NET Framework compilers, newest first. */
export function findCsc(env: Record<string, string | undefined> = process.env): string | null {
  const windir = env.WINDIR ?? "C:\\Windows";
  const candidates = [
    "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
    "Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
    "Microsoft.NET\\Framework64\\v3.5\\csc.exe",
    "Microsoft.NET\\Framework\\v3.5\\csc.exe",
    "Microsoft.NET\\Framework64\\v2.0.50727\\csc.exe",
    "Microsoft.NET\\Framework\\v2.0.50727\\csc.exe",
  ].map((rel) => join(windir, rel));
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** PowerShell/AMSI refusal signatures (Spanish and English Windows). */
export function isAmsiBlocked(output: string): boolean {
  return /ScriptContainedMaliciousContent|malintencionad|software antivirus|antivirus software|AMSI/i.test(output);
}

/** "OK 1368x768" -> { width, height }; null when absent. */
export function parseShotDims(stdout: string): { width: number; height: number } | null {
  const match = /OK (\d+)x(\d+)/.exec(stdout);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

/** First informative line of a localized PowerShell output (skips position/caret lines). */
function informativeLine(result: CommandResult): string | null {
  const positionMarker = /^(en|at)\s+.*(carácter|caracter|character)\s*:?\s*\d*/i;
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^[\s+~.]+$/.test(line) &&
        !line.startsWith("+") &&
        !positionMarker.test(line),
    );
  return lines[0] ?? null;
}

/**
 * Build the final error after every Windows attempt failed, classifying the
 * common causes. Reads the *last* informative line of localized PowerShell
 * output instead of the first (which is usually just a position marker).
 */
export function windowsCaptureError(ps: CommandResult, fallback: CommandResult | null, cscMissing: boolean): Error {
  const all = [ps, fallback].flatMap((r) => (r ? [`${r.stderr}\n${r.stdout}`] : [])).join("\n");
  if (/no interactive session|copyfromscreen-failed|handle is invalid|generic error occurred in GDI/i.test(all)) {
    return new Error(
      "no interactive session: screenshot requires a logged-in, unlocked desktop session; " +
        "in session 0 (running as a Windows service) screenshots are not possible",
    );
  }
  if (isAmsiBlocked(all)) {
    const detail = cscMissing
      ? "; the csc.exe fallback is unavailable on this machine"
      : fallback
        ? `; the csc.exe fallback also failed: ${informativeLine(fallback) ?? `exit ${fallback.code}`}`
        : "";
    return new Error(
      `screenshot blocked by antivirus/AMSI (PowerShell script refused)${detail}; ` +
        "add an exclusion for the agent or make sure .NET Framework csc.exe is installed",
    );
  }
  return new Error(`screenshot failed: ${informativeLine(ps) ?? `powershell exit ${ps.code}`}`);
}

type Runner = NonNullable<ScreenshotDeps["runCommand"]>;

async function captureWindows(path: string, params: ScreenshotParams, run: Runner, findCscFn: () => string | null): Promise<void> {
  const ps = await run(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT],
    {
      timeoutMs: 30_000,
      env: {
        MRC_SHOT_PATH: path,
        MRC_SHOT_FORMAT: params.format,
        MRC_SHOT_QUALITY: String(params.quality),
      },
    },
  );
  if (ps.code === 0 && parseShotDims(ps.stdout)) return;

  // PowerShell refused (typically AMSI/antivirus): try the native C# capturer.
  const csc = findCscFn();
  if (!csc) {
    if (isAmsiBlocked(`${ps.stderr}\n${ps.stdout}`)) {
      throw windowsCaptureError(ps, null, true);
    }
    throw windowsCaptureError(ps, null, false);
  }

  const base = join(dirname(path), `mrc-shot-${Date.now()}`);
  const csPath = `${base}.cs`;
  const exePath = `${base}.exe`;
  try {
    await Bun.write(csPath, WINDOWS_CSHARP);
    const compiled = await run(
      [csc, "/nologo", "/target:exe", "/optimize+", `/out:${exePath}`, "/reference:System.Drawing.dll", csPath],
      { timeoutMs: 60_000 },
    );
    if (compiled.code !== 0) throw windowsCaptureError(ps, compiled, false);

    const shot = await run([exePath, path, params.format, String(params.quality)], { timeoutMs: 30_000 });
    if (shot.code === 0 && parseShotDims(shot.stdout)) return;
    throw windowsCaptureError(ps, shot, false);
  } finally {
    await unlink(csPath).catch(() => {});
    await unlink(exePath).catch(() => {});
  }
}

async function capturePosix(path: string): Promise<void> {
  const wayland = Boolean(process.env.WAYLAND_DISPLAY);
  const x11 = Boolean(process.env.DISPLAY);
  if (!wayland && !x11) {
    throw new Error("no interactive session: no graphical display detected on this host");
  }

  const attempts: Array<{ cmd: string; args: string[] }> = [];
  if (wayland) attempts.push({ cmd: "grim", args: [path] });
  if (x11) {
    attempts.push({ cmd: "scrot", args: ["-o", path] });
    attempts.push({ cmd: "import", args: ["-window", "root", path] });
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    if (!Bun.which(attempt.cmd)) continue;
    const res = await runCommand([attempt.cmd, ...attempt.args], { timeoutMs: 20_000 });
    if (res.code === 0) return;
    errors.push(`${attempt.cmd}: ${res.stderr.trim() || `exit ${res.code}`}`);
  }

  if (errors.length > 0) throw new Error(`screenshot failed: ${errors.join("; ")}`);
  throw new Error("screenshot failed: no capture tool found (install grim, scrot or ImageMagick)");
}

/** PNG IHDR or JPEG SOF dimensions; null when the format is not recognized. */
export function parseImageSize(bytes: Uint8Array): { width: number; height: number } | null {
  // PNG: 8-byte signature, then IHDR chunk with width/height as big-endian u32.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: scan segments until a SOFn marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      if (marker === 0xda) break; // start of scan: no more headers
      const segmentLength = view.getUint16(offset + 2);
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 9 <= bytes.length) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + segmentLength;
    }
  }
  return null;
}
