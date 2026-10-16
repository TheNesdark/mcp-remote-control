/**
 * Client-side (server host) file transfer loops.
 *
 * Transfers are pull/push loops over single-chunk fs jobs, so every chunk flies
 * through the normal job machinery (timeouts, error reporting) and stays under
 * the websocket frame limit:
 *
 *   download: fs.read(offset)  -> append locally -> ... until eof
 *   upload:   fs.write(chunk)  -> ... then fs.hash to verify integrity
 *
 * Integrity: both directions end with a sha256 comparison and size check.
 */
import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { FS_DEFAULT_CHUNK_BYTES } from "@mrc/shared";
import type { Hub } from "./hub.ts";

/** Guard against runaway transfers. */
export const MAX_TRANSFER_BYTES = 1024 * 1024 * 1024; // 1 GiB

export interface TransferResult {
  path: string;
  bytes: number;
  sha256: string;
}

interface ReadMeta {
  bytes?: number;
  eof?: boolean;
  size?: number;
  sha256?: string | null;
}

export async function downloadFile(
  hub: Hub,
  agent: string,
  remotePath: string,
  localPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<TransferResult> {
  await mkdir(dirname(localPath), { recursive: true });
  const handle = await open(localPath, "w");
  const localHash = createHash("sha256");
  let offset = 0;
  let remoteSha: string | null = null;
  let remoteSize: number | null = null;

  try {
    for (;;) {
      const chunk = await hub.request(
        agent,
        "fs.read",
        { path: remotePath, offset, length: FS_DEFAULT_CHUNK_BYTES },
        opts.timeoutMs,
        { op: "fs.chunk", internal: true },
      );
      if (!chunk.ok) throw new Error(chunk.error ?? "remote read failed");

      const meta = (chunk.meta ?? {}) as ReadMeta;
      const data = Buffer.from(chunk.stdout, "base64");
      if (data.length > 0) {
        await handle.write(data);
        localHash.update(data);
        offset += data.length;
      }
      if (typeof meta.size === "number") remoteSize = meta.size;
      if (meta.sha256) remoteSha = meta.sha256;

      if (remoteSize !== null && remoteSize > MAX_TRANSFER_BYTES) {
        throw new Error(`remote file too large (${remoteSize} bytes, max ${MAX_TRANSFER_BYTES})`);
      }
      if (meta.eof || data.length === 0) break;
    }
  } finally {
    await handle.close();
  }

  const localSha = localHash.digest("hex");
  if (remoteSize !== null && offset !== remoteSize) {
    throw new Error(`size mismatch after download: remote ${remoteSize}, local ${offset}`);
  }
  if (remoteSha && remoteSha !== localSha) {
    throw new Error(`sha256 mismatch after download: remote ${remoteSha}, local ${localSha}`);
  }
  return { path: localPath, bytes: offset, sha256: localSha };
}

export async function uploadFile(
  hub: Hub,
  agent: string,
  localPath: string,
  remotePath: string,
  opts: { timeoutMs?: number; mkdirs?: boolean } = {},
): Promise<TransferResult> {
  const local = Bun.file(localPath);
  if (!(await local.exists())) {
    throw new Error(`local file not found: ${localPath}`);
  }
  const size = local.size;
  if (size > MAX_TRANSFER_BYTES) {
    throw new Error(`local file too large (${size} bytes, max ${MAX_TRANSFER_BYTES})`);
  }

  const localHash = createHash("sha256");
  const mkdirs = opts.mkdirs ?? false;

  if (size === 0) {
    const res = await hub.request(
      agent,
      "fs.write",
      { path: remotePath, data: "", mode: "overwrite", mkdirs },
      opts.timeoutMs,
      { op: "fs.chunk", internal: true },
    );
    if (!res.ok) throw new Error(res.error ?? "remote write failed");
  } else {
    let offset = 0;
    while (offset < size) {
      const end = Math.min(offset + FS_DEFAULT_CHUNK_BYTES, size);
      const bytes = new Uint8Array(await local.slice(offset, end).arrayBuffer());
      localHash.update(bytes);
      const res = await hub.request(
        agent,
        "fs.write",
        {
          path: remotePath,
          data: Buffer.from(bytes).toString("base64"),
          mode: offset === 0 ? "overwrite" : "append",
          mkdirs: offset === 0 ? mkdirs : false,
        },
        opts.timeoutMs,
        { op: "fs.chunk", internal: true },
      );
      if (!res.ok) throw new Error(res.error ?? "remote write failed");
      offset = end;
    }
  }

  const localSha = localHash.digest("hex");
  const remote = await hub.request(agent, "fs.hash", { path: remotePath }, opts.timeoutMs);
  if (!remote.ok) throw new Error(remote.error ?? "remote hash failed");
  const remoteSha = (remote.meta as { sha256?: string } | undefined)?.sha256;
  if (remoteSha !== localSha) {
    throw new Error(`sha256 mismatch after upload: local ${localSha}, remote ${remoteSha ?? "n/a"}`);
  }
  return { path: remotePath, bytes: size, sha256: localSha };
}
