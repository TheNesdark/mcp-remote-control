/**
 * Filesystem job handlers for the agent (fs.list / fs.read / fs.write / fs.hash).
 *
 * Payloads travel as job.output chunks:
 *   - fs.list  -> utf8 JSON { path, entries }
 *   - fs.read  -> base64 chunk (meta carries bytes/eof/size/sha256)
 *   - fs.write -> no payload (meta carries bytesWritten/sizeAfter)
 *   - fs.hash  -> no payload (meta carries sha256/size)
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { appendFile, lstat, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  FS_MAX_CHUNK_BYTES,
  type FsHashParams,
  type FsListParams,
  type FsReadParams,
  type FsWriteParams,
} from "@mrc/shared";
import type { ShortJobResult } from "./job-result.ts";

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number | null;
  mtimeMs: number;
}

function entryType(st: Stats): FileEntry["type"] {
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "file";
  if (st.isSymbolicLink()) return "symlink";
  return "other";
}

function toEntry(name: string, st: Stats): FileEntry {
  return {
    name,
    type: entryType(st),
    size: st.isFile() ? st.size : null,
    mtimeMs: Math.round(st.mtimeMs),
  };
}

export async function fsList(params: FsListParams): Promise<ShortJobResult> {
  const target = params.path;
  const targetStat = await lstat(target);

  if (!targetStat.isDirectory()) {
    const entries = [toEntry(basename(target), targetStat)];
    return {
      outputs: [{ stream: "stdout", data: JSON.stringify({ path: target, entries }), encoding: "utf8" }],
      meta: { count: entries.length, truncated: false },
    };
  }

  const dirents = await readdir(target, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));

  const truncated = dirents.length > params.limit;
  const selected = dirents.slice(0, params.limit);
  const entries: FileEntry[] = [];
  for (const dirent of selected) {
    const st = await lstat(`${target}/${dirent.name}`);
    entries.push(toEntry(dirent.name, st));
  }

  return {
    outputs: [{ stream: "stdout", data: JSON.stringify({ path: target, entries }), encoding: "utf8" }],
    meta: { count: entries.length, truncated },
  };
}

export async function fsRead(params: FsReadParams): Promise<ShortJobResult> {
  const file = Bun.file(params.path);
  if (!(await file.exists())) {
    throw new Error(`ENOENT: no such file or directory '${params.path}'`);
  }
  const size = file.size;
  const slice = file.slice(params.offset, params.offset + params.length);
  const bytes = new Uint8Array(await slice.arrayBuffer());
  const eof = params.offset + bytes.length >= size;

  let sha256: string | null = null;
  if (eof) sha256 = await sha256File(params.path);

  return {
    outputs: [{ stream: "stdout", data: Buffer.from(bytes).toString("base64"), encoding: "base64" }],
    meta: {
      offset: params.offset,
      bytes: bytes.length,
      eof,
      size,
      sha256,
    },
  };
}

export async function fsWrite(params: FsWriteParams): Promise<ShortJobResult> {
  const data = Buffer.from(params.data, "base64");
  if (data.length > FS_MAX_CHUNK_BYTES) {
    throw new Error(`chunk too large: ${data.length} bytes (max ${FS_MAX_CHUNK_BYTES})`);
  }
  if (params.mkdirs) {
    await mkdir(dirname(params.path), { recursive: true });
  }
  if (params.mode === "overwrite") {
    await writeFile(params.path, data);
  } else {
    await appendFile(params.path, data);
  }
  const sizeAfter = (await stat(params.path)).size;
  return { meta: { bytesWritten: data.length, sizeAfter } };
}

export async function fsHash(params: FsHashParams): Promise<ShortJobResult> {
  const st = await stat(params.path);
  const sha256 = await sha256File(params.path);
  return { meta: { sha256, size: st.size } };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
