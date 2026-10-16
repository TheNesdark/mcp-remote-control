import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SCREENSHOT_FORMATS } from "@mrc/shared";
import { z } from "zod";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { downloadFile } from "../transfers.ts";
import { toolError } from "./util.ts";

/** Above this size the image is not embedded in the tool result (path only). */
export const SCREENSHOT_EMBED_MAX_BYTES = 8 * 1024 * 1024;

interface ScreenshotMeta {
  path?: string;
  format?: string;
  bytes?: number;
  sha256?: string;
  width?: number | null;
  height?: number | null;
}

export function registerAgentScreenshot(server: McpServer, hub: Hub, screenshotDir: string, audit: AuditLog): void {
  server.registerTool(
    "agent_screenshot",
    {
      title: "Screenshot of a remote agent's primary monitor",
      description:
        "Capture the primary monitor of a remote machine and save it under the server's screenshot directory. " +
        "Returns the local path plus size/dimensions, and by default embeds the image so it can be inspected visually. " +
        "Only the primary monitor is captured. On Windows the agent must run in an interactive desktop session " +
        "(it fails with a clear error when running as a service/session 0 or when the desktop is locked).",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        format: z.enum(SCREENSHOT_FORMATS).optional().describe("png (lossless, default) or jpeg (smaller)."),
        quality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100 (default 80; ignored for png)."),
        embed: z.boolean().optional().describe("Include the image in the tool result (default true)."),
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
        const embed = args.embed ?? true;

        const outcome = await hub.request(args.agent, "screenshot", { format, quality }, args.timeoutMs);
        if (!outcome.ok) return fail(outcome.error ?? "screenshot failed");
        const meta = (outcome.meta ?? {}) as ScreenshotMeta;
        if (!meta.path) return fail("screenshot failed: agent did not report an image path");

        await mkdir(screenshotDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        const extension = format === "jpeg" ? "jpg" : "png";
        const localPath = join(screenshotDir, `agent-${sanitize(args.agent)}-${stamp}.${extension}`);

        const transfer = await downloadFile(hub, args.agent, meta.path, localPath, { timeoutMs: args.timeoutMs });

        const payload = {
          ok: true,
          agent: args.agent,
          format,
          localPath,
          bytes: transfer.bytes,
          sha256: transfer.sha256,
          width: meta.width ?? null,
          height: meta.height ?? null,
          embedded: false,
          remoteTempPath: meta.path,
        };

        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
        if (embed && transfer.bytes <= SCREENSHOT_EMBED_MAX_BYTES) {
          const bytes = await Bun.file(localPath).arrayBuffer();
          content.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
          });
          payload.embedded = true;
        } else if (embed) {
          payload.embedded = false;
          (payload as Record<string, unknown>).embedSkipped = `image too large to embed (${transfer.bytes} bytes)`;
        }

        content.push({ type: "text", text: JSON.stringify(payload, null, 2) });
        auditToolCall(audit, {
          op: "agent_screenshot",
          agent: args.agent,
          params: args,
          startedAt,
          ok: true,
          bytes: transfer.bytes,
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
