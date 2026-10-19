/**
 * Native screen recording of the agent's desktop.
 *
 * ffmpeg encodes MP4/h264 when it is available on the machine; otherwise the
 * frames are kept as JPEGs on the agent and encoded to a Motion-JPEG AVI by
 * our own CUA sidecar once the clip is done (that encoder has no external
 * dependency, which matters for locked-down targets). Either way the call
 * returns right after the capture window; the hub then starts the encoder,
 * polls its `record_status` and pulls the finished file.
 */
import type { CuaParams } from "@mrc/shared";
import type { ShortJobResult } from "./job-result.ts";
import { runCuaCall, type CuaRunnerOptions } from "./cua.ts";

/** Cut capture vs encode above this clip length (long clips finish encoding after capture). */
export const RECORD_SPLIT_MIN_SEC = 15;
/** Poll spacing and cap while waiting for a split encoder (ffmpeg or the AVI writer). */
const POLL_INTERVAL_MS = 1_500;
const POLL_MAX_MS = 300_000;

interface Status {
  ok?: boolean;
  error?: unknown;
  frames?: unknown;
  path?: unknown;
  resolution?: unknown;
  encoder?: unknown;
  codec_hint?: unknown;
  done?: unknown;
}

function run(
  op: Record<string, never> | { tool: string; args: Record<string, string | number | boolean>; timeoutMs?: number },
  opts: CuaRunnerOptions,
): Promise<ShortJobResult> {
  return runCuaCall(op as CuaParams, opts);
}

function asStatus(meta: Record<string, unknown> | undefined): Status {
  return (meta ?? {}) as Status;
}

/**
 * `record`: one blocking call for a bounded clip. Short clips stay one-shot
 * (single round trip, nothing to clean up); long clips start the capture and
 * hand the encoding to ffmpeg in the background, then poll its status so the
 * generator/HTTP stream is never idle long enough to be cut by a proxy.
 */
export async function runRecordCall(
  args: { duration_sec?: number; fps?: number; timeoutMs?: number },
  opts: CuaRunnerOptions = {},
): Promise<ShortJobResult> {
  const duration = args.duration_sec ?? 10;
  const base: Record<string, string | number | boolean> = { confirm: true, duration_sec: duration };
  if (args.fps) base.fps = args.fps;

  if (duration <= RECORD_SPLIT_MIN_SEC) {
    return run({ tool: "record", args: base, ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}) }, opts);
  }

  const started = await run({ tool: "record", args: { ...base, split: true } }, opts);
  const startedMeta = asStatus(started.meta);
  if (startedMeta.ok !== true) {
    return { meta: { ...(started.meta ?? {}), ok: false, error: startedMeta.error ?? "record failed to start" } };
  }
  // No frames were queued (older sidecar): report its error instead of polling.
  if (!startedMeta.frames) {
    return {
      meta: {
        ok: false,
        error: startedMeta.error ?? "record did not start (the agent's engine is too old)",
      },
    };
  }

  const deadline = Date.now() + POLL_MAX_MS;
  let status = startedMeta;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    status = asStatus((await run({ tool: "record_status", args: {} }, opts)).meta);
    if (!status.ok) break;
    if (status.done) break;
  }

  if (!status.ok) {
    return { meta: { ok: false, error: status.error ?? "record failed while encoding", encoder: status.encoder } };
  }
  if (!status.done) return { meta: { ok: false, error: "record encoding did not finish in time" } };
  return { meta: { ok: true, ...status } };
}

/** `record.status`: one poll of the split encoder started by `record`. */
export function runRecordStatusCall(_args: unknown, opts: CuaRunnerOptions = {}): Promise<ShortJobResult> {
  return run({ tool: "record_status", args: {} }, opts);
}
