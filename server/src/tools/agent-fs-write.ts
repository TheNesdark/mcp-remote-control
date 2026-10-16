import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { FS_MAX_CHUNK_BYTES } from "@mrc/shared";
import { auditToolCall, type AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { toolError, toolJson } from "./util.ts";

interface WriteMeta {
  bytesWritten?: number;
  sizeAfter?: number;
}

export function registerAgentFsWrite(server: McpServer, hub: Hub, audit: AuditLog): void {
  server.registerTool(
    "agent_fs_write",
    {
      title: "Write a file on a remote agent",
      description:
        `Write (create or overwrite) a remote file with the given content (utf8 or base64). ` +
        `Content is limited to ${FS_MAX_CHUNK_BYTES} bytes; use agent_fs_upload for bigger files. ` +
        `Returns the sha256 of the written bytes and the resulting file size.`,
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        path: z.string().min(1).describe("File path on the remote machine."),
        content: z.string().describe("File content (see `encoding`)."),
        encoding: z.enum(["utf8", "base64"]).optional().describe("How to interpret `content` (default utf8)."),
        mkdirs: z.boolean().optional().describe("Create parent directories if they are missing (default false)."),
      },
    },
    async (args) => {
      const startedAt = Date.now();
      try {
        const encoding = args.encoding ?? "utf8";
        const bytes = encoding === "base64" ? Buffer.from(args.content, "base64") : Buffer.from(args.content, "utf8");
        if (bytes.length > FS_MAX_CHUNK_BYTES) {
          const error = `content too large (${bytes.length} bytes, max ${FS_MAX_CHUNK_BYTES}); use agent_fs_upload instead`;
          auditToolCall(audit, { op: "agent_fs_write", agent: args.agent, params: args, startedAt, ok: false, error });
          return toolJson({ ok: false, error }, true);
        }

        const outcome = await hub.request(
          args.agent,
          "fs.write",
          {
            path: args.path,
            data: bytes.toString("base64"),
            mode: "overwrite",
            mkdirs: args.mkdirs ?? false,
          },
          undefined,
          { op: "agent_fs_write", params: args },
        );
        if (!outcome.ok) return toolJson({ ok: false, error: outcome.error ?? "fs.write failed" }, true);

        const meta = (outcome.meta ?? {}) as WriteMeta;
        return toolJson({
          ok: true,
          path: args.path,
          bytes: meta.bytesWritten ?? bytes.length,
          size: meta.sizeAfter ?? null,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
