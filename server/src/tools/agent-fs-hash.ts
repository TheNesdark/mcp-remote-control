import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

interface FsHashArgs {
  agent: string;
  path: string;
}

interface FsHashMeta {
  sha256?: string;
  size?: number;
}

export function registerAgentFsHash(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<FsHashArgs>(server, hub, audit, {
    name: "agent_fs_hash",
    title: "Hash a file on a remote agent",
    description:
      "Compute the SHA-256 of a remote file (and its size) without transferring it. " +
      "Use it to check whether an installer, log or backup copy matches the expected build, " +
      "or to compare the same file across machines. Fails when the path is missing or is a directory.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      path: z.string().min(1).describe("File path on the remote machine."),
    },
    options: {
      op: "agent_fs_hash",
      jobType: "fs.hash",
      buildParams: (args) => ({ path: args.path }),
      buildResult: (outcome, args) => {
        const meta = (outcome.meta ?? {}) as FsHashMeta;
        return { ok: true, path: args.path, sha256: meta.sha256 ?? null, size: meta.size ?? null };
      },
    },
  });
}
