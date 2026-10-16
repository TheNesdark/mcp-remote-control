import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FS_MAX_CHUNK_BYTES } from "@mrc/shared";
import { fsHash, fsList, fsRead, fsWrite } from "./fs.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mrc-fs-"));
}

function b64(data: string | Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

test("fs.write + fs.read round trip text", async () => {
  const path = join(tmpDir(), "hello.txt");
  const write = await fsWrite({ path, data: b64("hello world"), mode: "overwrite", mkdirs: false });
  expect(write.meta.bytesWritten).toBe(11);

  const read = await fsRead({ path, offset: 0, length: 1024 });
  expect(Buffer.from(read.outputs![0]!.data, "base64").toString()).toBe("hello world");
  expect(read.outputs![0]!.encoding).toBe("base64");
  expect(read.meta.eof).toBe(true);
  expect(read.meta.size).toBe(11);
  expect(read.meta.sha256).toBe(createHash("sha256").update("hello world").digest("hex"));
});

test("fs.write mkdirs creates parent directories", async () => {
  const path = join(tmpDir(), "deep", "nested", "file.txt");
  const write = await fsWrite({ path, data: b64("deep"), mode: "overwrite", mkdirs: true });
  expect(write.meta.bytesWritten).toBe(4);
  const read = await fsRead({ path, offset: 0, length: 16 });
  expect(Buffer.from(read.outputs![0]!.data, "base64").toString()).toBe("deep");
});

test("fs.read supports offsets and reports eof", async () => {
  const path = join(tmpDir(), "data.txt");
  await fsWrite({ path, data: b64("0123456789"), mode: "overwrite", mkdirs: false });

  const first = await fsRead({ path, offset: 0, length: 4 });
  expect(Buffer.from(first.outputs![0]!.data, "base64").toString()).toBe("0123");
  expect(first.meta.eof).toBe(false);
  expect(first.meta.sha256).toBeNull();

  const last = await fsRead({ path, offset: 8, length: 4 });
  expect(Buffer.from(last.outputs![0]!.data, "base64").toString()).toBe("89");
  expect(last.meta.eof).toBe(true);
  expect(last.meta.bytes).toBe(2);
});

test("fs.read rejects missing files", async () => {
  await expect(fsRead({ path: join(tmpDir(), "nope.txt"), offset: 0, length: 16 })).rejects.toThrow(/ENOENT/);
});

test("fs.list lists directories and describes single files", async () => {
  const dir = tmpDir();
  await fsWrite({ path: join(dir, "b.txt"), data: b64("b"), mode: "overwrite", mkdirs: false });
  await fsWrite({ path: join(dir, "a.txt"), data: b64("aa"), mode: "overwrite", mkdirs: false });

  const listing = await fsList({ path: dir, limit: 100 });
  const payload = JSON.parse(listing.outputs![0]!.data) as { entries: Array<{ name: string; type: string; size: number }> };
  const names = payload.entries.map((entry) => entry.name);
  expect(names).toContain("a.txt");
  expect(names).toContain("b.txt");
  expect(names).toEqual([...names].sort()); // sorted
  const a = payload.entries.find((entry) => entry.name === "a.txt")!;
  expect(a.type).toBe("file");
  expect(a.size).toBe(2);
  expect(listing.meta.count).toBe(2);

  const single = await fsList({ path: join(dir, "a.txt"), limit: 100 });
  const singlePayload = JSON.parse(single.outputs![0]!.data) as { entries: Array<{ name: string; type: string }> };
  expect(singlePayload.entries.length).toBe(1);
  expect(singlePayload.entries[0]!.type).toBe("file");
});

test("fs.hash matches node crypto for a multi-chunk file", async () => {
  const path = join(tmpDir(), "big.bin");
  const chunk = Buffer.alloc(FS_MAX_CHUNK_BYTES);
  for (let i = 0; i < chunk.length; i++) chunk[i] = i % 251;
  await fsWrite({ path, data: b64(chunk), mode: "overwrite", mkdirs: false });
  await fsWrite({ path, data: b64(chunk), mode: "append", mkdirs: false });

  const expected = createHash("sha256").update(chunk).update(chunk).digest("hex");
  const hash = await fsHash({ path });
  expect(hash.meta.sha256).toBe(expected);
  expect(hash.meta.size).toBe(chunk.length * 2);
});

test("fs.write rejects oversized chunks", async () => {
  const path = join(tmpDir(), "too-big.bin");
  const oversized = Buffer.alloc(FS_MAX_CHUNK_BYTES + 1);
  await expect(fsWrite({ path, data: b64(oversized), mode: "overwrite", mkdirs: false })).rejects.toThrow(/chunk too large/);
});
