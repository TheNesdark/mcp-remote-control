#!/usr/bin/env bun
/**
 * Build-time helper: download the pinned Cua Driver release zip (trycua/cua,
 * MIT) and verify its sha256 against shared/cua-version.ts. The hub then
 * serves it at /cua/latest.zip and agents auto-provision it.
 *
 * Usage: bun run scripts/fetch-cua-driver.ts <output-dir>
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CUA_DRIVER_SHA256, CUA_DRIVER_VERSION } from "@mrc/shared/cua-version";

const outDir = process.argv[2] ?? "/app/agent";
const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/cua-driver-rs-${CUA_DRIVER_VERSION}-windows-x86_64-binary.zip`;

console.log(`fetching Cua Driver ${CUA_DRIVER_VERSION} from ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Cua Driver download failed: HTTP ${res.status} ${url}`);
const bytes = new Uint8Array(await res.arrayBuffer());
const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
if (hash !== CUA_DRIVER_SHA256) {
  throw new Error(`Cua Driver sha256 mismatch: got ${hash}, pinned ${CUA_DRIVER_SHA256}`);
}
await mkdir(outDir, { recursive: true });
await Bun.write(join(outDir, "cua-driver.zip"), bytes);
console.log(`cua-driver ${CUA_DRIVER_VERSION} ok (${bytes.length} bytes, sha256 ${hash})`);
