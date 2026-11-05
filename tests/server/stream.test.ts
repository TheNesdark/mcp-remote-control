/**
 * Live-stream tests: the Streams broker (unit) and the /stream/<agent> HTTP
 * face end to end against a fake agent (push mode) and an old-style agent
 * without the `stream` capability (hub-side polling fallback).
 */
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FakeAgent, TINY_JPEG_BASE64 } from "../../scripts/fake-agent.ts";
import { testServerConfig, waitFor } from "../../scripts/test-utils.ts";
import { createService, type Service } from "../../server/src/service.ts";
import { handleStreamRequest } from "../../server/src/stream-http.ts";
import { Streams } from "../../server/src/streams.ts";

const TOKEN = "stream-token";
const JPEG = Buffer.from(TINY_JPEG_BASE64, "base64");
const JPEG_SHA = createHash("sha256").update(JPEG).digest("hex");

let service: Service | null = null;
const agents: FakeAgent[] = [];

afterEach(() => {
  for (const agent of agents) agent.stop();
  agents.length = 0;
  service?.close();
  service = null;
});

function runService(): Service {
  service = createService(testServerConfig(TOKEN, { logLevel: "error" }));
  return service;
}

async function attachAgent(opts: Partial<ConstructorParameters<typeof FakeAgent>[0]> = {}): Promise<FakeAgent> {
  const svc = service ?? runService();
  const agent = new FakeAgent({ url: `ws://127.0.0.1:${svc.port}`, token: TOKEN, name: "STREAM-01", onLog: () => {}, ...opts });
  agents.push(agent);
  await agent.start();
  return agent;
}

const streamReq = (path: string, token: string | null = TOKEN): Request =>
  new Request(`http://127.0.0.1:8788${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

/** Read from the response body until `predicate` holds (or the deadline passes). */
async function readUntil(res: Response, predicate: (buf: Buffer) => boolean, timeoutMs = 4_000): Promise<Buffer> {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null),
      ]);
      if (!next) break;
      if (next.done) break;
      chunks.push(next.value);
      const buf = Buffer.concat(chunks);
      if (predicate(buf)) return buf;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/** The first JPEG payload of a multipart stream, once one arrived. */
function firstJpeg(buf: Buffer): Buffer | null {
  const marker = Buffer.from("Content-Type: image/jpeg\r\nContent-Length: ");
  const at = buf.indexOf(marker);
  if (at < 0) return null;
  const lenEnd = buf.indexOf("\r\n\r\n", at);
  if (lenEnd < 0) return null;
  const length = Number(buf.subarray(at + marker.length, lenEnd).toString("ascii"));
  if (!Number.isFinite(length)) return null;
  const start = lenEnd + 4;
  if (buf.length < start + length) return null;
  return buf.subarray(start, start + length);
}

// ---------------------------------------------------------------------------
// Streams broker (unit)
// ---------------------------------------------------------------------------

test("Streams starts a capture, replays the last frame to newcomers and stops when idle", async () => {
  const sent: Array<{ type: string; [k: string]: unknown }> = [];
  const streams = new Streams({
    send: (_agentId, msg) => {
      sent.push(msg as never);
      return true;
    },
    idleStopMs: 40,
    startTimeoutMs: 5_000,
  });

  const frames: number[] = [];
  let ended: string | null = null;
  const sub = streams.subscribe(
    { agentId: "ag_1", agentName: "PC-1" },
    { source: "screen", fps: 10, quality: 60, maxWidth: 1600 },
    { frame: (data) => frames.push(data.length), ended: (reason) => (ended = reason) },
  );
  expect(sub.ok).toBe(true);
  if (!sub.ok) return;
  const start = sent.find((m) => m.type === "stream.start");
  expect(start).toBeTruthy();
  expect(start!.streamId).toBe(sub.streamId);
  expect(start!.fps).toBe(10);

  streams.onFrame("ag_1", { type: "stream.frame", streamId: sub.streamId, seq: 0, data: TINY_JPEG_BASE64, bytes: JPEG.length });
  expect(frames).toEqual([JPEG.length]);
  expect(ended).toBeNull();

  // A second viewer joins mid-stream: it gets the last frame immediately and
  // shares the same session.
  const late: number[] = [];
  const sub2 = streams.subscribe(
    { agentId: "ag_1", agentName: "PC-1" },
    { source: "screen", fps: 10, quality: 60, maxWidth: 1600 },
    { frame: (data) => late.push(data.length), ended: () => {} },
  );
  expect(sub2.ok).toBe(true);
  if (!sub2.ok) return;
  expect(sub2.streamId).toBe(sub.streamId);
  expect(late).toEqual([JPEG.length]);

  sub.unsubscribe();
  await Bun.sleep(20);
  expect(sent.some((m) => m.type === "stream.stop")).toBe(false); // grace period running
  sub2.unsubscribe();
  await waitFor(() => (sent.some((m) => m.type === "stream.stop") ? true : undefined), { label: "idle stop" });
  expect(streams.count()).toBe(0);
});

test("Streams ends the viewers when the agent disconnects or errors", async () => {
  const sent: Array<{ type: string }> = [];
  const streams = new Streams({ send: () => (sent.push({ type: "x" }), true), idleStopMs: 5_000 });

  const state: { ended: string | null } = { ended: null };
  const sub = streams.subscribe(
    { agentId: "ag_2", agentName: "PC-2" },
    { source: "camera", fps: 5, quality: 50, maxWidth: 640 },
    { frame: () => {}, ended: (reason) => (state.ended = reason) },
  );
  expect(sub.ok).toBe(true);
  streams.agentOffline("ag_2");
  expect(state.ended).toContain("disconnected");
  expect(streams.count()).toBe(0);
});

test("Streams reports an agent that never produces a frame", async () => {
  const sent: Array<{ type: string }> = [];
  const streams = new Streams({
    send: () => (sent.push({ type: "x" }), true),
    startTimeoutMs: 30,
  });
  const state: { ended: string | null } = { ended: null };
  const sub = streams.subscribe(
    { agentId: "ag_3", agentName: "PC-3" },
    { source: "screen", fps: 10, quality: 60, maxWidth: 1600 },
    { frame: () => {}, ended: (reason) => (state.ended = reason) },
  );
  expect(sub.ok).toBe(true);
  await waitFor(() => (state.ended ? true : undefined), { label: "start timeout" });
  expect(state.ended).toContain("did not produce");
  expect(streams.count()).toBe(0);
});

test("Streams refuses to start when the agent is offline", () => {
  const streams = new Streams({ send: () => false });
  const sub = streams.subscribe(
    { agentId: "ag_4", agentName: "PC-4" },
    { source: "screen", fps: 10, quality: 60, maxWidth: 1600 },
    { frame: () => {}, ended: () => {} },
  );
  expect(sub.ok).toBe(false);
});

test("Streams ignores frames addressed to another agent or stream", () => {
  const sent: Array<{ type: string }> = [];
  const streams = new Streams({ send: () => (sent.push({ type: "x" }), true) });
  const frames: number[] = [];
  const sub = streams.subscribe(
    { agentId: "ag_5", agentName: "PC-5" },
    { source: "screen", fps: 10, quality: 60, maxWidth: 1600 },
    { frame: (d) => frames.push(d.length), ended: () => {} },
  );
  expect(sub.ok).toBe(true);
  if (!sub.ok) return;
  streams.onFrame("ag_OTHER", { type: "stream.frame", streamId: sub.streamId, seq: 0, data: TINY_JPEG_BASE64, bytes: JPEG.length });
  streams.onFrame("ag_5", { type: "stream.frame", streamId: "st_other", seq: 0, data: TINY_JPEG_BASE64, bytes: JPEG.length });
  expect(frames.length).toBe(0);
});

// ---------------------------------------------------------------------------
// HTTP face
// ---------------------------------------------------------------------------

test("/stream requires the token", async () => {
  runService();
  const res = await handleStreamRequest(streamReq("/stream/STREAM-01", null), {
    hub: service!.hub,
    streams: service!.streams,
    token: TOKEN,
  });
  expect(res.status).toBe(401);
});

test("/stream 404s an unknown agent and 503s an offline one", async () => {
  runService();
  const unknown = await handleStreamRequest(streamReq("/stream/NOPE"), {
    hub: service!.hub,
    streams: service!.streams,
    token: TOKEN,
  });
  expect(unknown.status).toBe(404);

  const agent = await attachAgent();
  agent.stop();
  await waitFor(() => (service!.hub.resolve("STREAM-01").online === false ? true : undefined), { label: "offline" });
  const offline = await handleStreamRequest(streamReq("/stream/STREAM-01"), {
    hub: service!.hub,
    streams: service!.streams,
    token: TOKEN,
  });
  expect(offline.status).toBe(503);
});

test("/stream 409s an agent paused from the tray", async () => {
  runService();
  await attachAgent({ paused: true });
  const res = await handleStreamRequest(streamReq("/stream/STREAM-01"), {
    hub: service!.hub,
    streams: service!.streams,
    token: TOKEN,
  });
  expect(res.status).toBe(409);
});

test("push mode streams real frames from a modern agent", async () => {
  runService();
  const agent = await attachAgent();
  const res = await handleStreamRequest(streamReq("/stream/STREAM-01?fps=30"), {
    hub: service!.hub,
    streams: service!.streams,
    token: TOKEN,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("multipart/x-mixed-replace");
  expect(res.headers.get("x-mrc-stream")).toBe("push");

  const buf = await readUntil(res, (b) => firstJpeg(b) !== null);
  const jpeg = firstJpeg(buf);
  expect(jpeg).not.toBeNull();
  expect(jpeg!.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(jpeg!.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  expect(agent.streamsStarted.length).toBe(1);
});

test("old agents fall back to the hub polling screenshots", async () => {
  runService();
  await attachAgent({
    caps: ["screenshot", "info"],
    respond: (msg) => {
      if (msg.jobType !== "screenshot") return undefined;
      return {
        stdout: TINY_JPEG_BASE64,
        meta: { format: "jpeg", bytes: JPEG.length, sha256: JPEG_SHA, width: 1, height: 1 },
      };
    },
  });
  const res = await handleStreamRequest(streamReq("/stream/STREAM-01"), {
    hub: service!.hub,
    streams: service!.streams,
    token: TOKEN,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("x-mrc-stream")).toBe("poll");
  const buf = await readUntil(res, (b) => firstJpeg(b) !== null);
  const jpeg = firstJpeg(buf);
  expect(jpeg).not.toBeNull();
  expect(jpeg!.length).toBe(JPEG.length);
});

test("a camera stream.url arrives with the right source suffix", async () => {
  runService();
  const agent = await attachAgent();
  const res = await handleStreamRequest(streamReq("/stream/STREAM-01/camera?fps=8&quality=55&maxWidth=900"), {
    hub: service!.hub,
    streams: service!.streams,
    token: TOKEN,
  });
  expect(res.status).toBe(200);
  await waitFor(() => (agent.streamsStarted.length === 1 ? true : undefined), { label: "stream.start sent" });
});
