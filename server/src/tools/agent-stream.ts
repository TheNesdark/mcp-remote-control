import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { toolError } from "./util.ts";

/**
 * Returns a live MJPEG stream URL for an agent's screen (or camera). The URL
 * is served by the MCP HTTP face; open it in a browser or point a video
 * player at it. No frames are stored on the server.
 */
export function registerAgentStream(
  server: McpServer,
  _hub: Hub,
  audit: AuditLog,
  baseUrl = "",
): void {
  server.registerTool(
    "agent_stream",
    {
      title: "Live MJPEG stream of a remote agent's screen or camera",
      description:
        "Return a URL that streams a remote machine's primary monitor (or " +
        "camera, where the agent build supports it) live as MJPEG over the " +
        "MCP HTTP face. Open the URL in a browser or any MJPEG-capable player. " +
        "The agent captures continuously (ffmpeg gdigrab/dshow) and pushes " +
        "frames; older agent builds fall back to the hub polling screenshot " +
        "(≈5 fps). No frames are stored on the server. Requires the MCP HTTP " +
        "face (MRC_MCP_HTTP_PORT) to be enabled.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        source: z.enum(["screen", "camera"]).optional().describe("screen (default) or camera."),
        fps: z.number().int().min(1).max(30).optional().describe("Frames per second (default 10, max 30)."),
        quality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100 (default 60)."),
        maxWidth: z
          .number()
          .int()
          .min(160)
          .max(4096)
          .optional()
          .describe("Scale frames to this width at most (default 1600; aspect kept, never upscaled)."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      const fail = (error: string) => {
        auditToolCall(audit, { op: "agent_stream", agent: args.agent, params: args, startedAt, ok: false, error });
        return toolError(new Error(error));
      };
      try {
        const source = args.source ?? "screen";
        const fps = args.fps ?? 10;
        const quality = args.quality ?? 60;
        const maxWidth = args.maxWidth ?? 1600;
        const path = `/stream/${encodeURIComponent(args.agent)}${source === "screen" ? "" : "/" + source}`;
        const query = new URLSearchParams();
        if (args.fps !== undefined) query.set("fps", String(fps));
        if (args.quality !== undefined) query.set("quality", String(quality));
        if (args.maxWidth !== undefined) query.set("maxWidth", String(maxWidth));
        const qs = query.toString();
        const url = baseUrl ? `${baseUrl}${path}${qs ? "?" + qs : ""}` : `${path}${qs ? "?" + qs : ""}`;

        auditToolCall(audit, { op: "agent_stream", agent: args.agent, params: args, startedAt, ok: true });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: true,
                  agent: args.agent,
                  source,
                  fps,
                  quality,
                  maxWidth,
                  url,
                  hint:
                    "Open the url in a browser, or curl -N with Authorization: Bearer <token>. " +
                    "Camera requires an agent build that supports the 'camera' source. " +
                    "The capture stops by itself a few seconds after the last viewer disconnects.",
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
