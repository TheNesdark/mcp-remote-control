import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Full cross-compile acceptance: real PE out of `bun build --compile`, and the
 * values passed with --server/--name/--token are actually baked into the binary
 * (they must reach `bun build --define`, not just be validated).
 */
test(
  "build.ts cross-compiles a valid Windows PE with baked defaults",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "mrc-build-"));
    const out = join(dir, "rc-agent.exe");
    const proc = Bun.spawn({
      cmd: [
        "bun",
        "run",
        join(import.meta.dir, "../../agent/build.ts"),
        "--out",
        out,
        "--server",
        "ws://bake.test:8787",
        "--name",
        "BAKE-01",
        "--token",
        "bake-token-xyz",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    expect(`${stdout}\n${stderr}`).toContain("ok:");
    expect(code).toBe(0);

    const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
    expect(bytes[0]).toBe(0x4d);
    expect(bytes[1]).toBe(0x5a);
    const peOffset = new DataView(bytes.buffer).getUint32(0x3c, true);
    expect(String.fromCharCode(bytes[peOffset]!, bytes[peOffset + 1]!, bytes[peOffset + 2]!, bytes[peOffset + 3]!)).toBe(
      "PE\0\0",
    );
    expect(bytes.length).toBeGreaterThan(50 * 1024 * 1024);

    // The baked defaults must be embedded (regression: build.ts computed the
    // --define list but never passed it to `bun build`).
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(buf.indexOf("ws://bake.test:8787")).toBeGreaterThanOrEqual(0);
    expect(buf.indexOf("BAKE-01")).toBeGreaterThanOrEqual(0);
    expect(buf.indexOf("bake-token-xyz")).toBeGreaterThanOrEqual(0);
  },
  180_000,
);
