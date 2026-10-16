#!/usr/bin/env bun
/**
 * Generates agent/assets/icon.ico: multi-size 32bpp BMP-based ICO with the
 * "connected green dot on a dark rounded square" motif (same as the tray icon).
 *
 * No image dependencies: pixels are drawn in code. Run:
 *   bun run agent/assets/make-icon.ts [--out agent/assets/icon.ico]
 */
import { dirname } from "node:path";

const SIZES = [16, 32, 48, 256];

const BG = { r: 0x1f, g: 0x29, b: 0x37, a: 0xff }; // slate-800
const DOT = { r: 0x22, g: 0xb1, b: 0x4c, a: 0xff }; // tray green

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

function roundedSquare(size: number): Pixel[] {
  const pixels: Pixel[] = new Array(size * size);
  const radius = size * 0.22;
  const dotR = size * 0.26;
  const center = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded-square mask for the background.
      const cx = Math.min(Math.max(x, radius), size - 1 - radius);
      const cy = Math.min(Math.max(y, radius), size - 1 - radius);
      const inSquare = (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
      const inDot = (x - center) ** 2 + (y - center) ** 2 <= dotR ** 2;
      // 1px antialiased edge on the dot.
      const edge = (x - center) ** 2 + (y - center) ** 2 <= (dotR + 1) ** 2;
      let pixel: Pixel;
      if (inDot) {
        pixel = { ...DOT };
      } else if (edge && inSquare) {
        pixel = {
          r: Math.round((DOT.r + BG.r) / 2),
          g: Math.round((DOT.g + BG.g) / 2),
          b: Math.round((DOT.b + BG.b) / 2),
          a: 0xff,
        };
      } else if (inSquare) {
        pixel = { ...BG };
      } else {
        pixel = { r: 0, g: 0, b: 0, a: 0 };
      }
      pixels[y * size + x] = pixel!;
    }
  }
  return pixels;
}

/** One 32bpp BMP entry (BITMAPINFOHEADER + bottom-up BGRA + empty AND mask). */
function bmpEntry(size: number): Uint8Array {
  const pixels = roundedSquare(size);
  const rowBytes = size * 4;
  const andRowBytes = Math.ceil(size / 32) * 4;
  const buf = new Uint8Array(40 + rowBytes * size + andRowBytes * size);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 40, true); // header size
  view.setInt32(4, size, true); // width
  view.setInt32(8, size * 2, true); // height (XOR + AND)
  view.setUint16(12, 1, true); // planes
  view.setUint16(14, 32, true); // bit count
  view.setUint32(16, 0, true); // BI_RGB
  // Pixels bottom-up, BGRA.
  let offset = 40;
  for (let y = size - 1; y >= 0; y--) {
    for (let x = 0; x < size; x++) {
      const p = pixels[y * size + x]!;
      buf[offset++] = p.b;
      buf[offset++] = p.g;
      buf[offset++] = p.r;
      buf[offset++] = p.a;
    }
  }
  // AND mask stays zeroed (opaque where alpha says so on Vista+).
  return buf;
}

export function buildIco(): Uint8Array {
  const entries = SIZES.map(bmpEntry);
  const headerSize = 6 + 16 * entries.length;
  let total = headerSize;
  for (const entry of entries) total += entry.length;
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, entries.length, true);
  let offset = headerSize;
  entries.forEach((entry, i) => {
    const size = SIZES[i]!;
    const at = 6 + 16 * i;
    buf[at] = size === 256 ? 0 : size;
    buf[at + 1] = size === 256 ? 0 : size;
    buf[at + 2] = 0; // colors
    buf[at + 3] = 0; // reserved
    view.setUint16(at + 4, 1, true); // planes
    view.setUint16(at + 6, 32, true); // bpp
    view.setUint32(at + 8, entry.length, true);
    view.setUint32(at + 12, offset, true);
    buf.set(entry, offset);
    offset += entry.length;
  });
  return buf;
}

if (import.meta.main) {
  const outFlag = process.argv.indexOf("--out");
  const out = outFlag >= 0 ? process.argv[outFlag + 1]! : Bun.fileURLToPath(new URL("./icon.ico", import.meta.url));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirname(out), { recursive: true });
  await Bun.write(out, buildIco());
  const file = Bun.file(out);
  console.log(`wrote ${out} (${file.size} bytes, sizes ${SIZES.join("/")})`);
}
