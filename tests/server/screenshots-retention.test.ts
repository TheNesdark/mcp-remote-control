import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneScreenshots } from "../../server/src/screenshots-retention.ts";
import { testServerConfig } from "../../scripts/test-utils.ts";
import { createService, type Service } from "../../server/src/service.ts";

let dir = "";
let service: Service | null = null;

afterEach(async () => {
  service?.close();
  service = null;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function seed(names: string[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "mrc-shot-retention-"));
  const base = Date.UTC(2026, 9, 17, 12, 0, 0);
  for (const [index, name] of names.entries()) {
    const path = join(dir, name);
    await Bun.write(path, `image-${index}`);
    // Deterministic mtimes: each file one hour older than the previous one.
    const when = new Date(base - index * 3_600_000);
    await utimes(path, when, when);
  }
  return dir;
}

test("pruneScreenshots keeps the newest files and deletes the rest", async () => {
  const shots = await seed(["agent-new.png", "agent-mid.png", "agent-old.jpg", "notes.txt", "keep/me.png"]);
  const result = await pruneScreenshots(shots, 2);
  expect(result).toEqual({ deleted: 1, kept: 2 });
  const left = (await readdir(shots)).sort();
  // Only the two newest images survive; non-images and subdirectories are untouched.
  expect(left).toEqual(["agent-mid.png", "agent-new.png", "keep", "notes.txt"]);
});

test("pruneScreenshots is a no-op when keep is 0 or the directory is missing", async () => {
  const shots = await seed(["a.png", "b.png"]);
  expect(await pruneScreenshots(shots, 0)).toEqual({ deleted: 0, kept: 0 });
  expect(await pruneScreenshots(join(shots, "does-not-exist"), 10)).toEqual({ deleted: 0, kept: 0 });
  expect((await readdir(shots)).length).toBe(2);
});

test("GET /health reports uptime, fleet counters and job counters", async () => {
  service = createService(testServerConfig("health-token", { screenshotKeep: 5 }));
  const res = await fetch(`http://127.0.0.1:${service.port}/health`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, any>;
  expect(body.ok).toBe(true);
  expect(typeof body.uptimeSec).toBe("number");
  expect(body.agents).toEqual({ total: 0, online: 0, paused: 0 });
  expect(body.jobs).toEqual({ running: 0, retained: 0 });
  expect(body.lastAgentSeenAt).toBeNull();

  // the classic liveness endpoint keeps working unchanged
  const root = (await (await fetch(`http://127.0.0.1:${service.port}/`)).json()) as Record<string, unknown>;
  expect(root).toMatchObject({ ok: true, agents: 0 });
});
