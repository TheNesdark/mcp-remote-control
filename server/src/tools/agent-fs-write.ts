import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { FS_MAX_CHUNK_BYTES } from "@mrc/shared";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

interface WriteMeta {
  bytesWritten?: number;
  sizeAfter?: number;
}

interface FsWriteArgs {
  agent: string;
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  mkdirs?: boolean;
}

export function registerAgentFsWrite(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<FsWriteArgs>(server, hub, audit, {
    name: "agent_fs_write",
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
    options: {
      op: "agent_fs_write",
      jobType: "fs.write",
      validate: (args) => {
        const encoding = args.encoding ?? "utf8";
        const length = encoding === "base64" ? Buffer.from(args.content, "base64").length : Buffer.byteLength(args.content, "utf8");
        return length > FS_MAX_CHUNK_BYTES
          ? `content too large (${length} bytes, max ${FS_MAX_CHUNK_BYTES}); use agent_fs_upload instead`
          : null;
      },
      buildParams: (args) => {
        const encoding = args.encoding ?? "utf8";
        const bytes = encoding === "base64" ? Buffer.from(args.content, "base64") : Buffer.from(args.content, "utf8");
        return {
          path: args.path,
          data: bytes.toString("base64"),
          mode: "overwrite",
          mkdirs: args.mkdirs ?? false,
        };
      },
      buildResult: (outcome, args) => {
        const encoding = args.encoding ?? "utf8";
        const bytes = encoding === "base64" ? Buffer.from(args.content, "base64") : Buffer.from(args.content, "utf8");
        const meta = (outcome.meta ?? {}) as WriteMeta;
        return {
          ok: true,
          path: args.path,
          bytes: meta.bytesWritten ?? bytes.length,
          size: meta.sizeAfter ?? null,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
    },
  });
}
