/**
 * Live MJPEG streaming over the MCP HTTP face.
 *
 *   curl -N -H "Authorization: Bearer ***" \
 *        http://<server>:8788/stream/<agent>                    # screen, 10 fps
 *   curl -N -H "Authorization: Bearer ***" \
 *        "http://<server>:8788/stream/<agent>/camera?fps=15&quality=70&maxWidth=1280"
 *
 * Agents whose build advertises the `stream` capability capture continuously
 * (ffmpeg gdigrab/dshow) and push frames over their WebSocket; the hub
 * re-broadcasts them here as `multipart/x-mixed-replace`, so browsers and any
 * MJPEG-capable player show it live. Older agents fall back to the hub polling
 * `screenshot` at a modest frame rate.
 *
 * Auth accepts the bearer header or `?token=` (convenient from a browser).
 */
import { MAX_STREAM_FRAME_BYTES, type StreamSource } from "@mrc/shared";
import { sameSecret } from "@mrc/shared/secret";
import type { Hub, JobOutcome } from "./hub.ts";
import { HubError } from "./hub-error.ts";
import type { Streams, StreamViewer } from "./streams.ts";

export const STREAM_HTTP_PREFIX = "/stream/";

const DEFAULT_FPS = 10;
const MIN_FPS = 1;
const MAX_FPS = 30;
const DEFAULT_QUALITY = 60;
const DEFAULT_MAX_WIDTH = 1600;
/** How often a keepalive boundary is written when no frame arrived. */
const KEEPALIVE_MS = 2_000;

export interface StreamHttpContext {
  hub: Hub;
  streams: Streams;
  token: string;
}

function authorized(req: Request, url: URL, token: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Bearer ") && sameSecret(header.slice("Bearer ".length), token)) return true;
  const query = url.searchParams.get("token");
  return query !== null && sameSecret(query, token);
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export async function handleStreamRequest(req: Request, ctx: StreamHttpContext): Promise<Response> {
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (!authorized(req, url, ctx.token)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // /stream/<agent>  or  /stream/<agent>/camera  (also /stream/<agent>/screen)
  const rest = url.pathname.slice(STREAM_HTTP_PREFIX.length);
  const parts = rest.split("/").filter(Boolean);
  if (parts.length === 0) return new Response("bad request: missing agent", { status: 400 });
  let agentRef: string;
  let source: StreamSource = "screen";
  try {
    agentRef = decodeURIComponent(parts[0] as string);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (parts[1]) {
    const s = parts[1].toLowerCase();
    if (s === "camera") source = "camera";
    else if (s === "screen") source = "screen";
    else return new Response("bad request: unknown source", { status: 400 });
  }

  const fps = clampInt(url.searchParams.get("fps"), DEFAULT_FPS, MIN_FPS, MAX_FPS);
  const quality = clampInt(url.searchParams.get("quality"), DEFAULT_QUALITY, 1, 100);
  const maxWidth = clampInt(url.searchParams.get("maxWidth"), DEFAULT_MAX_WIDTH, 160, 4096);

  let record;
  try {
    record = ctx.hub.resolve(agentRef);
  } catch (err) {
    if (err instanceof HubError) return new Response(err.message, { status: 404 });
    throw err;
  }
  if (!record.online) {
    return new Response(`agent '${record.name}' is offline`, { status: 503 });
  }
  if (record.paused) {
    return new Response(`agent '${record.name}' is paused locally (disabled from the tray)`, { status: 409 });
  }

  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers: streamHeaders(source) });
  }

  const supportsPush = record.caps.includes("stream");
  if (supportsPush) {
    return pushStream(ctx, record.agentId, record.name, { source, fps, quality, maxWidth });
  }
  // Compatibility with older agent builds: poll `screenshot` from the hub.
  return pollStream(ctx.hub, record.name, { source, fps, quality, maxWidth }, req);
}

function streamHeaders(source: StreamSource): Record<string, string> {
  return {
    "content-type": "multipart/x-mixed-replace; boundary=frame",
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    "x-mrc-stream-source": source,
  };
}

/** Real push mode: the agent captures and the hub only fans frames out. */
function pushStream(
  ctx: StreamHttpContext,
  agentId: string,
  agentName: string,
  settings: { source: StreamSource; fps: number; quality: number; maxWidth: number },
): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  let sentAny = false;
  let lastWrite = Date.now();
  let keepalive: ReturnType<typeof setInterval> | null = null;

  const cleanup = (): void => {
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
    const fn = unsubscribe;
    unsubscribe = null;
    if (fn) {
      try {
        fn();
      } catch {
        // already detached
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (note?: string): void => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          if (note && !sentAny) {
            controller.enqueue(encoder.encode(`--frame\r\nContent-Type: text/plain\r\n\r\n${note}\r\n`));
          }
          controller.close();
        } catch {
          // consumer already gone
        }
      };

      const viewer: StreamViewer = {
        frame(data: Uint8Array, _seq: number): void {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`),
            );
            controller.enqueue(data);
            controller.enqueue(encoder.encode("\r\n"));
            sentAny = true;
            lastWrite = Date.now();
          } catch {
            finish();
          }
        },
        ended(reason: string): void {
          finish(`stream ended: ${reason}`);
        },
      };

      const result = ctx.streams.subscribe({ agentId, agentName }, settings, viewer);
      if (!result.ok) {
        finish(`stream error: ${result.error}`);
        return;
      }
      unsubscribe = result.unsubscribe;

      keepalive = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastWrite < KEEPALIVE_MS) return;
        try {
          controller.enqueue(encoder.encode(`--frame\r\nContent-Type: text/plain\r\n\r\n`));
          lastWrite = Date.now();
        } catch {
          finish();
        }
      }, KEEPALIVE_MS / 2);
    },
    cancel() {
      closed = true;
      cleanup();
    },
  });

  const headers = streamHeaders(settings.source);
  headers["x-mrc-stream"] = "push";
  return new Response(stream, { headers });
}

// ---------------------------------------------------------------------------
// Legacy fallback: no `stream` cap on the agent build; the hub polls
// `screenshot` and relays the images as MJPEG (≈5 fps ceiling).
// ---------------------------------------------------------------------------

interface LegacySettings {
  source: StreamSource;
  fps: number;
  quality: number;
  maxWidth: number;
}

function decodeScreenshot(outcome: JobOutcome): Buffer | null {
  const meta = (outcome.meta ?? {}) as { bytes?: number; sha256?: string };
  if (outcome.truncated) return null;
  if (!meta.bytes || !meta.sha256) return null;
  const bytes = Buffer.from(outcome.stdout ?? "", "base64");
  if (bytes.length !== meta.bytes) return null;
  return bytes;
}

function pollStream(hub: Hub, agentRef: string, settings: LegacySettings, req: Request): Response {
  const fps = Math.min(5, settings.fps);
  const frameIntervalMs = Math.round(1000 / Math.max(1, fps));
  const boundary = "frame";
  const encoder = new TextEncoder();

  const jobType = settings.source === "camera" ? "camera" : "screenshot";
  const jobParams: Record<string, unknown> = { format: "jpeg", quality: settings.quality };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let stopped = false;
      const stop = (): void => {
        stopped = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", stop);

      try {
        while (!stopped) {
          const started = Date.now();
          let bytes: Buffer | null = null;
          try {
            const outcome = await hub.request(
              agentRef,
              jobType as "screenshot",
              jobParams,
              30_000,
              undefined,
              { maxOutputBytes: 8 * 1024 * 1024 },
            );
            if (outcome.ok) bytes = decodeScreenshot(outcome);
          } catch {
            bytes = null;
          }

          if (bytes && bytes.length > 0 && bytes.length <= MAX_STREAM_FRAME_BYTES) {
            controller.enqueue(
              encoder.encode(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`),
            );
            controller.enqueue(new Uint8Array(bytes));
            controller.enqueue(encoder.encode("\r\n"));
          } else {
            controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Type: text/plain\r\n\r\n`));
          }

          const elapsed = Date.now() - started;
          const wait = Math.max(0, frameIntervalMs - elapsed);
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      } catch (err) {
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      } finally {
        req.signal.removeEventListener("abort", stop);
      }
    },
    cancel() {
      // the loop observes the abort signal
    },
  });

  const headers = streamHeaders(settings.source);
  headers["x-mrc-stream"] = "poll";
  return new Response(stream, { headers });
}
