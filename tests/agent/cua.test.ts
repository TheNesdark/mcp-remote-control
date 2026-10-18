import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDriverVersion, provisionCuaDriver } from "../../agent/src/cua.ts";

const ZIP = Buffer.from("PK fake zip bytes");
const SHA = createHash("sha256").update(ZIP).digest("hex");

function tempDir(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "mrc-cua-prov-"));
  return { dir: join(base, "cua"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function announce(overrides: Record<string, unknown> = {}) {
  return { version: "0.36.0", sha256: SHA, url: "/cua/latest.zip", ...overrides };
}

test("parseDriverVersion reads the CLI version line", () => {
  expect(parseDriverVersion("cua-driver 0.36.0")).toBe("0.36.0");
  expect(parseDriverVersion("cua-driver 0.9.1-beta.2")).toBe("0.9.1-beta.2");
  expect(parseDriverVersion("no version here")).toBeNull();
});

test("provisionCuaDriver downloads, verifies and unpacks the announcement", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const calls: string[] = [];
    const result = await provisionCuaDriver(
      announce(),
      { hubOrigin: "http://10.0.0.5:8787", token: "tok" },
      {
        driverDir: dir,
        fetchFn: (async (url: URL | string | Request, init?: unknown) => {
          calls.push(String(url));
          const auth = (init as { headers?: Record<string, string> } | undefined)?.headers?.authorization;
          if (auth !== "Bearer tok") throw new Error("token header missing");
          return new Response(ZIP);
        }) as unknown as typeof fetch,
        unpack: (zipPath, target) => {
          calls.push(`unpack:${zipPath.endsWith(".zip") ? "zip" : "not-zip"}->${target === dir ? "dir" : "other"}`);
        },
        enableAutostart: () => void calls.push("autostart"),
      },
    );
    expect(result).toEqual({ downloaded: true, version: "0.36.0" });
    expect(calls[0]).toBe("http://10.0.0.5:8787/cua/latest.zip");
    expect(calls[1]).toBe("unpack:zip->dir");
    expect(calls[2]).toBe("autostart");
  } finally {
    cleanup();
  }
});

test("a sha256 mismatch never touches the disk", async () => {
  const { dir, cleanup } = tempDir();
  try {
    let unpacked = false;
    await expect(
      provisionCuaDriver(
        announce({ sha256: "0".repeat(64) }),
        { hubOrigin: "http://h:1", token: "" },
        {
          driverDir: dir,
          fetchFn: (async () => new Response(ZIP)) as unknown as typeof fetch,
          unpack: () => {
            unpacked = true;
          },
          enableAutostart: () => {},
        },
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(unpacked).toBe(false);
  } finally {
    cleanup();
  }
});

test("a fresh box (no local exe) always downloads", async () => {
  const { dir, cleanup } = tempDir();
  try {
    let fetched = false;
    const result = await provisionCuaDriver(
      announce({ version: "0.36.0" }),
      { hubOrigin: "http://h:1", token: "" },
      {
        driverDir: dir,
        fetchFn: (async () => {
          fetched = true;
          return new Response(ZIP);
        }) as unknown as typeof fetch,
        unpack: () => {},
        enableAutostart: () => {},
      },
    );
    // fresh box: downloads (null < 0.36.0)
    expect(result.downloaded).toBe(true);
    expect(fetched).toBe(true);
  } finally {
    cleanup();
  }
});

test("an http error surfaces as a provisioning failure", async () => {
  const { dir, cleanup } = tempDir();
  try {
    await expect(
      provisionCuaDriver(announce(), { hubOrigin: "http://h:1", token: "" }, {
        driverDir: dir,
        fetchFn: (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch,
        unpack: () => {},
        enableAutostart: () => {},
      }),
    ).rejects.toThrow(/HTTP 404/);
  } finally {
    cleanup();
  }
});
