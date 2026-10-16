/**
 * Screenshot of the primary monitor (`screenshot` job).
 *
 * - Windows: PowerShell + System.Windows.Forms/System.Drawing (CopyFromScreen).
 *   Requires an interactive desktop session: in session 0 (a Windows service)
 *   CopyFromScreen fails and we surface a clear "no interactive session" error.
 * - POSIX (development only): tries grim (Wayland), scrot or ImageMagick
 *   `import` (X11) and fails with a clear message when there is no graphical
 *   session or no backend installed.
 *
 * The image is written to a temp file on the agent host; the job meta carries
 * its path so the server can pull it down with the chunked fs.read loop.
 */
import os from "node:os";
import { join } from "node:path";
import type { ScreenshotParams } from "@mrc/shared";
import { sha256File } from "./fs.ts";
import type { ShortJobResult } from "./job-result.ts";
import { runCommand } from "./run-command.ts";

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

export async function takeScreenshot(params: ScreenshotParams): Promise<ShortJobResult> {
  const extension = params.format === "jpeg" ? "jpg" : "png";
  const path = join(os.tmpdir(), `mrc-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`);

  if (process.platform === "win32") {
    await captureWindows(path, params);
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

async function captureWindows(path: string, params: ScreenshotParams): Promise<void> {
  const res = await runCommand(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT],
    {
      timeoutMs: 30_000,
      env: {
        MRC_SHOT_PATH: path,
        MRC_SHOT_FORMAT: params.format,
        MRC_SHOT_QUALITY: String(params.quality),
      },
    },
  );
  if (res.code === 0 && res.stdout.includes("OK")) return;

  const message = `${res.stderr}\n${res.stdout}`;
  if (/no interactive session/i.test(message)) {
    throw new Error(
      "no interactive session: screenshot requires a logged-in desktop session; " +
        "in session 0 (running as a Windows service) screenshots are not possible",
    );
  }
  if (/handle is invalid|generic error occurred in GDI/i.test(message)) {
    throw new Error(
      "no interactive session: the desktop is locked or the agent runs without a visible session",
    );
  }
  const firstLine = message.split("\n").map((line) => line.trim()).filter(Boolean)[0];
  throw new Error(`screenshot failed: ${firstLine ?? `powershell exit ${res.code}`}`);
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
