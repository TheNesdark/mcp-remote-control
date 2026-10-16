import { expect, test } from "bun:test";
import { parseImageSize, takeScreenshot } from "./screenshot.ts";

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
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return; // graphical dev host: skip
  await expect(takeScreenshot({ format: "png", quality: 80 })).rejects.toThrow(
    /no interactive session|no capture tool/,
  );
});

test("takeScreenshot writes a temp file when a backend is available", async () => {
  if (process.platform === "win32") return; // covered on the Windows VM
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const outcome = await takeScreenshot({ format: "png", quality: 80 });
  const meta = outcome.meta as { path: string; bytes: number; sha256: string };
  expect(meta.bytes).toBeGreaterThan(0);
  expect(meta.sha256.length).toBe(64);
  expect(await Bun.file(meta.path).exists()).toBe(true);
  expect((await Bun.file(meta.path).arrayBuffer()).byteLength).toBe(meta.bytes);
});
