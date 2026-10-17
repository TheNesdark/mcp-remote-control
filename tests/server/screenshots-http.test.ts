import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, screenshotBaseUrl } from "../../server/src/config.ts";
import { handleScreenshotRequest, SCREENSHOT_HTTP_PREFIX } from "../../server/src/screenshots-http.ts";

const TOKEN = "test-token-123";
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function setup(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mrc-shots-"));
  await Bun.write(join(dir, "agent-PC.png"), IMAGE);
  return dir;
}

const url = (path: string) => `http://192.168.1.192:8788${path}`;

test("serves a stored screenshot with the bearer token", async () => {
  const dir = await setup();
  const res = await handleScreenshotRequest(new Request(url(`${SCREENSHOT_HTTP_PREFIX}agent-PC.png`), {
    headers: { authorization: `Bearer ${TOKEN}` },
  }), dir, TOKEN);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("content-disposition")).toContain("agent-PC.png");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(IMAGE);
});

test("serves with ?token= as an alternative to the header", async () => {
  const dir = await setup();
  const res = await handleScreenshotRequest(new Request(url(`${SCREENSHOT_HTTP_PREFIX}agent-PC.png?token=${TOKEN}`)), dir, TOKEN);
  expect(res.status).toBe(200);
});

test("answer HEAD without a body but with content-length", async () => {
  const dir = await setup();
  const res = await handleScreenshotRequest(new Request(url(`${SCREENSHOT_HTTP_PREFIX}agent-PC.png`), {
    method: "HEAD",
    headers: { authorization: `Bearer ${TOKEN}` },
  }), dir, TOKEN);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-length")).toBe(String(IMAGE.length));
  expect((await res.arrayBuffer()).byteLength).toBe(0);
});

test("rejects a missing or wrong token", async () => {
  const dir = await setup();
  const anon = await handleScreenshotRequest(new Request(url(`${SCREENSHOT_HTTP_PREFIX}agent-PC.png`)), dir, TOKEN);
  expect(anon.status).toBe(401);
  const wrong = await handleScreenshotRequest(new Request(url(`${SCREENSHOT_HTTP_PREFIX}agent-PC.png?token=nope`)), dir, TOKEN);
  expect(wrong.status).toBe(401);
});

test("rejects path traversal and encoded separators", async () => {
  const dir = await setup();
  for (const name of ["%2e%2e%2fsecret.png", "sub%2fshot.png", "..%5Csecret.png"]) {
    const res = await handleScreenshotRequest(new Request(url(`${SCREENSHOT_HTTP_PREFIX}${name}`), {
      headers: { authorization: `Bearer ${TOKEN}` },
    }), dir, TOKEN);
    expect(res.status).toBe(400);
  }
});

test("returns 404 for an unknown file and 405 for other methods", async () => {
  const dir = await setup();
  const missing = await handleScreenshotRequest(new Request(url(`${SCREENSHOT_HTTP_PREFIX}nope.png`), {
    headers: { authorization: `Bearer ${TOKEN}` },
  }), dir, TOKEN);
  expect(missing.status).toBe(404);

  const post = await handleScreenshotRequest(new Request(url(`${SCREENSHOT_HTTP_PREFIX}agent-PC.png`), {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
  }), dir, TOKEN);
  expect(post.status).toBe(405);
});

test("screenshotBaseUrl prefers MRC_PUBLIC_URL and drops the trailing slash", () => {
  const config = loadConfig({ MRC_PUBLIC_URL: "http://192.168.1.192:8788/", MRC_HOST: "0.0.0.0" } as NodeJS.ProcessEnv);
  expect(config.publicUrl).toBe("http://192.168.1.192:8788");
  expect(screenshotBaseUrl(config)).toBe("http://192.168.1.192:8788");
});

test("screenshotBaseUrl derives from a concrete bind host + MCP port", () => {
  const config = loadConfig({ MRC_HOST: "192.168.1.192", MRC_MCP_HTTP_PORT: "8788" } as NodeJS.ProcessEnv);
  expect(screenshotBaseUrl(config)).toBe("http://192.168.1.192:8788");
});

test("screenshotBaseUrl is empty when the bind address is a wildcard", () => {
  const config = loadConfig({ MRC_HOST: "0.0.0.0", MRC_MCP_HTTP_PORT: "8788" } as NodeJS.ProcessEnv);
  expect(screenshotBaseUrl(config)).toBe("");
});
