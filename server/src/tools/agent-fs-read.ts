import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FS_MAX_CHUNK_BYTES } from "@mrc/shared";
import type { Hub } from "../hub.ts";
import { toolError, toolJson } from "./util.ts";

interface ReadMeta {
  bytes?: number;
  eof?: boolean;
  size?: number;
  sha256?: string | null;
}

export function registerAgentFsRead(server: McpServer, hub: Hub): void {
  server.registerTool(
    "agent_fs_read",
    {
      title: "Read a file on a remote agent",
      description:
        "Read up to `maxBytes` from the start of a remote file. Text (`utf8`, default) or `base64` for binaries. " +
        "If the file is bigger, `truncated` is true: use agent_fs_download to fetch the whole file. " +
        "When the whole file fits, the result includes its sha256.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        path: z.string().min(1).describe("File path on the remote machine."),
        encoding: z.enum(["utf8", "base64"]).optional().describe("How to return the content (default utf8)."),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(FS_MAX_CHUNK_BYTES)
          .optional()
          .describe(`Maximum bytes to read (default 65536, max ${FS_MAX_CHUNK_BYTES}).`),
      },
    },
    async (args) => {
      try {
        const encoding = args.encoding ?? "utf8";
        const maxBytes = args.maxBytes ?? 65_536;
        const outcome = await hub.request(args.agent, "fs.read", { path: args.path, offset: 0, length: maxBytes });
        if (!outcome.ok) return toolJson({ ok: false, error: outcome.error ?? "fs.read failed" }, true);

        const meta = (outcome.meta ?? {}) as ReadMeta;
        const bytesRead = meta.bytes ?? 0;
        const eof = meta.eof ?? true;
        const buffer = Buffer.from(outcome.stdout, "base64");

        return toolJson({
          path: args.path,
          encoding,
          size: meta.size ?? null,
          bytesRead,
          eof,
          truncated: !eof,
          sha256: meta.sha256 ?? null,
          content: encoding === "utf8" ? buffer.toString("utf8") : outcome.stdout,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
