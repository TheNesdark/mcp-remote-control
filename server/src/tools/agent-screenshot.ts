import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { MAX_SCREENSHOT_BASE64_BYTES, SCREENSHOT_FORMATS } from "@mrc/shared";
import { z } from "zod";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub, JobOutcome } from "../hub.ts";
import { scheduleScreenshotPrune } from "../screenshots-retention.ts";
import { SCREENSHOT_HTTP_PREFIX } from "../screenshots-http.ts";
import { downloadFile } from "../transfers.ts";
import { toolError } from "./util.ts";

/** Above this size the image is not embedded in the tool result (path only). */
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
  screenshotDir: string,
  audit: AuditLog,
  screenshotBaseUrl = "",
  screenshotKeep = 0,
): void {
  // Remote clients (MRC_PUBLIC_URL set) fetch the image via downloadUrl instead
  // of receiving it inline: embedding a multi-MB base64 blob in the MCP
  // HTTP/SSE response is slow and frequently times out on the client side.
  const remoteMode = screenshotBaseUrl.length > 0;

  server.registerTool(
    "agent_screenshot",
    {
      title: "Screenshot of a remote agent's primary monitor",
      description:
        "Capture the primary monitor of a remote machine and save it under the server's screenshot directory. " +
        "The agent streams the image straight from the capture (nothing is stored on the remote disk). " +
        "Returns the local path plus size/dimensions. Over stdio (local server) the image is embedded by default so it " +
        "can be inspected visually; over the HTTP face (MRC_PUBLIC_URL set) embedding defaults to false because a " +
        "multi-MB base64 blob in the SSE response is slow and times out on clients - fetch it via downloadUrl instead. " +
        "Only the primary monitor is captured. On Windows the agent must run in an interactive desktop session " +
        "(it fails with a clear error when running as a service/session 0 or when the desktop is locked). " +
        "The result carries a downloadPath (and downloadUrl when MRC_PUBLIC_URL is set) so a client on another " +
        "machine can fetch the PNG with the shared token.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        format: z.enum(SCREENSHOT_FORMATS).optional().describe("png (lossless, default) or jpeg (smaller)."),
        quality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100 (default 80; ignored for png)."),
        embed: z.boolean().optional().describe("Include the image in the tool result (default true over stdio, false over the HTTP face)."),
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
        const embed = args.embed ?? !remoteMode;

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

        await mkdir(screenshotDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const extension = format === "jpeg" ? "jpg" : "png";
        const localPath = join(screenshotDir, `agent-${sanitize(args.agent)}-${stamp}.${extension}`);

        // Current agents stream the image inside the job; older ones left it on
        // the remote disk and reported a path we have to pull (compatibility).
        let bytes: Buffer;
        if (outcome.stdout.length > 0) {
          const decoded = decodeScreenshotOutcome(outcome);
          if ("error" in decoded) return fail(decoded.error);
          bytes = decoded.bytes;
          await Bun.write(localPath, bytes);
        } else if (meta.path) {
          const transfer = await downloadFile(hub, args.agent, meta.path, localPath, { timeoutMs: args.timeoutMs });
          bytes = Buffer.from(await Bun.file(localPath).arrayBuffer());
          if (bytes.length !== transfer.bytes) return fail("screenshot failed: size mismatch after transfer");
        } else {
          return fail("screenshot failed: agent returned no image data");
        }

        const sha256 = createHash("sha256").update(bytes).digest("hex");
        // Keep the directory bounded: drop everything older than the newest N.
        scheduleScreenshotPrune(screenshotDir, screenshotKeep);
        const downloadPath = `${SCREENSHOT_HTTP_PREFIX}${basename(localPath)}`;
        const payload = {
          ok: true,
          agent: args.agent,
          format,
          localPath,
          bytes: bytes.length,
          sha256,
          width: meta.width ?? null,
          height: meta.height ?? null,
          embedded: false,
          downloadPath,
          ...(screenshotBaseUrl ? { downloadUrl: `${screenshotBaseUrl}${downloadPath}` } : {}),
        };

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        if (embed && bytes.length <= SCREENSHOT_EMBED_MAX_BYTES) {
          content.push({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
          });
          payload.embedded = true;
        } else if (embed) {
          payload.embedded = false;
          (payload as Record<string, unknown>).embedSkipped = `image too large to embed (${bytes.length} bytes)`;
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

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "agent";
}
