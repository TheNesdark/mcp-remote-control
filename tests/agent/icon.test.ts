import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildIco } from "../../agent/assets/make-icon.ts";

function parseEntries(ico: Uint8Array): Array<{ width: number; height: number; bpp: number; bytes: number; offset: number }> {
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  expect(view.getUint16(0, true)).toBe(0);
  expect(view.getUint16(2, true)).toBe(1);
  const count = view.getUint16(4, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    entries.push({
      width: ico[at] === 0 ? 256 : ico[at]!,
      height: ico[at + 1] === 0 ? 256 : ico[at + 1]!,
      bpp: view.getUint16(at + 6, true),
      bytes: view.getUint32(at + 8, true),
      offset: view.getUint32(at + 12, true),
    });
  }
  return entries;
}

test("generated icon has 16/32/48/256 32bpp entries covering the file", () => {
  const ico = buildIco();
  const entries = parseEntries(ico);
  expect(entries.map((entry) => entry.width)).toEqual([16, 32, 48, 256]);
  expect(entries.every((entry) => entry.height === entry.width && entry.bpp === 32)).toBe(true);
  let end = 0;
  for (const entry of entries) end = Math.max(end, entry.offset + entry.bytes);
  expect(end).toBe(ico.length);
});

test("committed icon.ico matches the generator output", async () => {
  const path = join(import.meta.dir, "../../agent/assets/icon.ico");
  const committed = new Uint8Array(await Bun.file(path).arrayBuffer());
  expect(committed.length).toBeGreaterThan(0);
  expect(Buffer.from(committed).equals(Buffer.from(buildIco()))).toBe(true);
});
