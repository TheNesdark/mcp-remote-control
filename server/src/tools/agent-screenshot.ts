import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { MAX_SCREENSHOT_BASE64_BYTES, SCREENSHOT_FORMATS } from "@mrc/shared";
import { z } from "zod";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub, JobOutcome } from "../hub.ts";
import { downloadFile } from "../transfers.ts";
import { toolError } from "./util.ts";

/** Above this size the image is not embedded in the tool result (metadata only). */
export const SCREENSHOT_EMBED_MAX_BYTES = 8 * 1024 * 1024;

interface ScreenshotMeta {
  /** Legacy agents write the image to a temp file and report its path. */
  path?: string;
  format?: string;
  bytes?: number;
  sha256?: string;
  width?: number | null;
  height?: number | null;
}

/**
 * Decodes the base64 image the agent streamed inside the job and checks it
 * against the reported size/checksum. Returns a Buffer or an error string.
 */
export function decodeScreenshotOutcome(outcome: JobOutcome): { bytes: Buffer } | { error: string } {
  const meta = (outcome.meta ?? {}) as ScreenshotMeta;
  if (outcome.truncated) return { error: "screenshot failed: the image did not fit in the job output buffer" };
  if (!meta.bytes || !meta.sha256) return { error: "screenshot failed: agent did not report image metadata" };
  const bytes = Buffer.from(outcome.stdout, "base64");
  if (bytes.length !== meta.bytes) {
    return { error: `screenshot failed: size mismatch (got ${bytes.length} bytes, expected ${meta.bytes})` };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== meta.sha256) return { error: "screenshot failed: checksum mismatch" };
  return { bytes };
}

export function registerAgentScreenshot(
  server: McpServer,
  hub: Hub,
  _screenshotDir: string,
  audit: AuditLog,
  _screenshotBaseUrl = "",
  _screenshotKeep = 0,
): void {
  server.registerTool(
    "agent_screenshot",
    {
      title: "Screenshot of a remote agent's primary monitor",
      description:
        "Capture the primary monitor of a remote machine and return the image " +
        "directly as base64 in the tool result (nothing is stored on the server " +
        "disk). The agent streams the image straight from the capture. Only the " +
        "primary monitor is captured. On Windows the agent must run in an " +
        "interactive desktop session (it fails with a clear error when running " +
        "as a service/session 0 or when the desktop is locked).",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        format: z.enum(SCREENSHOT_FORMATS).optional().describe("png (lossless, default) or jpeg (smaller)."),
        quality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100 (default 80; ignored for png)."),
        timeoutMs: z.number().int().positive().optional().describe("Job timeout in milliseconds."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      const fail = (error: string) => {
        auditToolCall(audit, { op: "agent_screenshot", agent: args.agent, params: args, startedAt, ok: false, error });
        return toolError(new Error(error));
      };
      try {
        const format = args.format ?? "png";
        const quality = args.quality ?? 80;

        const outcome = await hub.request(
          args.agent,
          "screenshot",
          { format, quality },
          args.timeoutMs ?? 60_000,
          undefined,
          { maxOutputBytes: MAX_SCREENSHOT_BASE64_BYTES },
        );
        if (!outcome.ok) return fail(outcome.error ?? "screenshot failed");
        const meta = (outcome.meta ?? {}) as ScreenshotMeta;

        let bytes: Buffer;
        if (outcome.stdout.length > 0) {
          const decoded = decodeScreenshotOutcome(outcome);
          if ("error" in decoded) return fail(decoded.error);
          bytes = decoded.bytes;
        } else if (meta.path) {
          // Compatibility with older agents that left the image on the remote
          // disk: pull it into memory through a temp file (nothing is kept on
          // the hub disk).
          const { tmpdir } = await import("node:os");
          const { join: pjoin } = await import("node:path");
          const { unlink } = await import("node:fs/promises");
          const tmpPath = pjoin(tmpdir(), `mrc-shot-${Date.now()}.bin`);
          const transfer = await downloadFile(hub, args.agent, meta.path, tmpPath, { timeoutMs: args.timeoutMs });
          try {
            bytes = Buffer.from(await Bun.file(tmpPath).arrayBuffer());
          } finally {
            await unlink(tmpPath).catch(() => {});
          }
          if (bytes.length !== transfer.bytes) return fail("screenshot failed: size mismatch after transfer");
        } else {
          return fail("screenshot failed: agent returned no image data");
        }

        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
        const base64 = bytes.toString("base64");

        const payload = {
          ok: true,
          agent: args.agent,
          format,
          bytes: bytes.length,
          sha256,
          width: meta.width ?? null,
          height: meta.height ?? null,
          embedded: bytes.length <= SCREENSHOT_EMBED_MAX_BYTES,
        };

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        if (bytes.length <= SCREENSHOT_EMBED_MAX_BYTES) {
          content.push({ type: "image", data: base64, mimeType });
        } else {
          (payload as Record<string, unknown>).embedSkipped =
            `image too large to embed (${bytes.length} bytes); reduce format/quality`;
        }
        content.push({ type: "text", text: JSON.stringify(payload, null, 2) });

        auditToolCall(audit, {
          op: "agent_screenshot",
          agent: args.agent,
          params: args,
          startedAt,
          ok: true,
          bytes: bytes.length,
        });
        return { content };
      } catch (err) {
        auditToolCall(audit, {
          op: "agent_screenshot",
          agent: args.agent,
          params: args,
          startedAt,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return toolError(err);
      }
    },
  );
}

