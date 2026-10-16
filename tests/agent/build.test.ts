import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Full cross-compile acceptance: real PE out of `bun build --compile`. */
test(
  "build.ts cross-compiles a valid Windows PE",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "mrc-build-"));
    const out = join(dir, "rc-agent.exe");
    const proc = Bun.spawn({
      cmd: ["bun", "run", join(import.meta.dir, "../../agent/build.ts"), "--out", out],
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
  },
  180_000,
);
