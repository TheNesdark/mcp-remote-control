/**
 * Live-stream broker: one capture session per (agent, source), fanned out to
 * the HTTP viewers of /stream/<agent>.
 *
 * The agent owns the capture (ffmpeg gdigrab/dshow, or its GDI fallback) and
 * pushes `stream.frame` messages over its existing WebSocket; this class keeps
 * the session bookkeeping:
 *
 * - First viewer starts the capture (`stream.start` -> agent).
 * - Frames are broadcast to every viewer of that session.
 * - The last viewer leaving schedules `stream.stop` after a short grace
 *   period, so refreshing the page does not restart the capture.
 * - If the agent disconnects (or errors), viewers are dropped and the
 *   session is forgotten; a later viewer starts a fresh one.
 *
 * No frames are stored beyond the last one (replayed to fresh viewers so they
 * do not stare at a blank image until the next frame).
 */
import { randomUUID } from "node:crypto";
import type { ServerMsg, StreamFrameMsg, StreamSource, StreamStateMsg } from "@mrc/shared";
import { logger } from "./log.ts";

export interface StreamViewer {
  /** One JPEG frame for this viewer. */
  frame(data: Uint8Array, seq: number): void;
  /** The session ended; `reason` is for logs and diagnostics. */
  ended(reason: string): void;
}

export interface StreamAgentRef {
  agentId: string;
  agentName: string;
}

export interface StreamSubscribeSettings {
  source: StreamSource;
  fps: number;
  quality: number;
  maxWidth: number;
}

export interface StreamsOptions {
  /** Deliver one protocol message to an agent; false when it is offline. */
  send: (agentId: string, msg: ServerMsg) => boolean;
  /** Grace period before a session with no viewers stops the capture. */
  idleStopMs?: number;
  /** Max viewers per session (fan-out bound). */
  maxViewers?: number;
  /** How long to wait for the first frame before declaring the stream dead. */
  startTimeoutMs?: number;
}

export const DEFAULT_STREAM_IDLE_STOP_MS = 10_000;
export const DEFAULT_STREAM_MAX_VIEWERS = 8;
export const DEFAULT_STREAM_START_TIMEOUT_MS = 15_000;

interface StreamSession {
  streamId: string;
  agentId: string;
  agentName: string;
  settings: StreamSubscribeSettings;
  viewers: Set<StreamViewer>;
  status: "starting" | "live";
  lastFrame: Uint8Array | null;
  frames: number;
  startedAt: number;
  lastFrameAt: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
  startTimer: ReturnType<typeof setTimeout> | null;
}

export type SubscribeResult =
  | { ok: true; streamId: string; unsubscribe(): void }
  | { ok: false; error: string };

export class Streams {
  private readonly byId = new Map<string, StreamSession>();
  private readonly byKey = new Map<string, StreamSession>();
  private readonly opts: Required<StreamsOptions>;

  constructor(opts: StreamsOptions) {
    this.opts = {
      send: opts.send,
      idleStopMs: opts.idleStopMs ?? DEFAULT_STREAM_IDLE_STOP_MS,
      maxViewers: opts.maxViewers ?? DEFAULT_STREAM_MAX_VIEWERS,
      startTimeoutMs: opts.startTimeoutMs ?? DEFAULT_STREAM_START_TIMEOUT_MS,
    };
  }

  /** Attach one viewer, starting the capture when it is the first one. */
  subscribe(agent: StreamAgentRef, settings: StreamSubscribeSettings, viewer: StreamViewer): SubscribeResult {
    const key = `${agent.agentId}|${settings.source}`;
    let session = this.byKey.get(key);
    if (session && session.status === "live" && session.agentName !== agent.agentName) {
      session.agentName = agent.agentName;
    }
    if (!session) {
      const streamId = `st_${randomUUID()}`;
      session = {
        streamId,
        agentId: agent.agentId,
        agentName: agent.agentName,
        settings,
        viewers: new Set(),
        status: "starting",
        lastFrame: null,
        frames: 0,
        startedAt: Date.now(),
        lastFrameAt: 0,
        stopTimer: null,
        startTimer: null,
      };
      const sent = this.opts.send(agent.agentId, {
        type: "stream.start",
        streamId,
        source: settings.source,
        fps: settings.fps,
        quality: settings.quality,
        maxWidth: settings.maxWidth,
      });
      if (!sent) {
        return { ok: false, error: `agent '${agent.agentName}' is offline` };
      }
      this.byId.set(streamId, session);
      this.byKey.set(key, session);
      session.startTimer = setTimeout(() => {
        if (session && session.frames === 0 && this.byKey.get(key) === session) {
          logger.warn("stream never produced a frame", {
            agent: session.agentName,
            streamId: session.streamId,
            source: session.settings.source,
          });
          this.endSession(session, "the agent did not produce any frame (stream unsupported build, capture failure or a locked desktop)");
        }
      }, this.opts.startTimeoutMs);
      logger.info("stream started", {
        agent: session.agentName,
        streamId: session.streamId,
        source: settings.source,
        fps: settings.fps,
        quality: settings.quality,
        maxWidth: settings.maxWidth,
      });
    } else if (session.viewers.size >= this.opts.maxViewers) {
      return { ok: false, error: `too many viewers for this stream (max ${this.opts.maxViewers})` };
    }

    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }
    session.viewers.add(viewer);
    // A viewer joining mid-stream gets the last frame right away.
    if (session.lastFrame) {
      try {
        viewer.frame(session.lastFrame, session.frames);
      } catch {
        // the viewer will be dropped on its own unsubscribe
      }
    }

    let active = true;
    return {
      ok: true,
      streamId: session.streamId,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.removeViewer(session, viewer);
      },
    };
  }

  /** One frame from an agent capture. */
  onFrame(agentId: string, msg: StreamFrameMsg): void {
    const session = this.byId.get(msg.streamId);
    if (!session || session.agentId !== agentId) return;
    let data: Uint8Array;
    try {
      data = new Uint8Array(Buffer.from(msg.data, "base64"));
    } catch {
      return;
    }
    if (data.length === 0) return;
    session.lastFrame = data;
    session.lastFrameAt = Date.now();
    session.frames += 1;
    if (session.status === "starting") {
      session.status = "live";
      if (session.startTimer) {
        clearTimeout(session.startTimer);
        session.startTimer = null;
      }
      logger.info("stream live", {
        agent: session.agentName,
        streamId: session.streamId,
        source: session.settings.source,
      });
    }
    for (const viewer of [...session.viewers]) {
      try {
        viewer.frame(data, msg.seq);
      } catch {
        // a broken viewer is removed by its own unsubscribe
      }
    }
  }

  /** Lifecycle word from the agent (`stream.state`). */
  onState(agentId: string, msg: StreamStateMsg): void {
    const session = this.byId.get(msg.streamId);
    if (!session || session.agentId !== agentId) return;
    if (msg.status === "error") {
      this.endSession(session, msg.error ?? "the agent reported a stream error");
    } else if (msg.status === "stopped") {
      this.endSession(session, "the agent stopped the stream");
    }
  }

  /** Every session of this agent is dead (socket closed / replaced). */
  agentOffline(agentId: string): void {
    for (const session of [...this.byId.values()]) {
      if (session.agentId === agentId) {
        this.endSession(session, "the agent disconnected");
      }
    }
  }

  /** Stop every capture (server shutdown). */
  shutdown(): void {
    for (const session of [...this.byId.values()]) {
      this.opts.send(session.agentId, { type: "stream.stop", streamId: session.streamId });
      this.endSession(session, "the server is shutting down");
    }
  }

  /** Sessions currently brokered (diagnostics). */
  count(): number {
    return this.byId.size;
  }

  private removeViewer(session: StreamSession, viewer: StreamViewer): void {
    if (!session.viewers.delete(viewer)) return;
    if (session.viewers.size > 0) return;
    if (session.stopTimer) clearTimeout(session.stopTimer);
    session.stopTimer = setTimeout(() => {
      if (session.viewers.size === 0 && this.byId.get(session.streamId) === session) {
        this.opts.send(session.agentId, { type: "stream.stop", streamId: session.streamId });
        this.forget(session);
        logger.info("stream stopped (idle)", {
          agent: session.agentName,
          streamId: session.streamId,
          frames: session.frames,
        });
      }
    }, this.opts.idleStopMs);
  }

  private endSession(session: StreamSession, reason: string): void {
    if (this.byId.get(session.streamId) !== session) return;
    this.forget(session);
    for (const viewer of [...session.viewers]) {
      try {
        viewer.ended(reason);
      } catch {
        // nothing left to do for this viewer
      }
    }
    session.viewers.clear();
    logger.info("stream ended", {
      agent: session.agentName,
      streamId: session.streamId,
      frames: session.frames,
      reason,
    });
  }

  private forget(session: StreamSession): void {
    if (session.stopTimer) {
      clearTimeout(session.stopTimer);
      session.stopTimer = null;
    }
    if (session.startTimer) {
      clearTimeout(session.startTimer);
      session.startTimer = null;
    }
    this.byId.delete(session.streamId);
    this.byKey.delete(`${session.agentId}|${session.settings.source}`);
  }
}
