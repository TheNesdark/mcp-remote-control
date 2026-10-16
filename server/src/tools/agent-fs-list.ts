import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";

interface ListMeta {
  count?: number;
  truncated?: boolean;
}

interface FsListArgs {
  agent: string;
  path: string;
  limit?: number;
}

export function registerAgentFsList(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<FsListArgs>(server, hub, audit, {
    name: "agent_fs_list",
    title: "List a directory on a remote agent",
    description:
      "List the contents of a directory on a remote machine (or describe a single file if 'path' points to one). " +
      "Returns entries with name, type (file|dir|symlink|other), size (null for directories) and mtime.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      path: z.string().min(1).describe("Directory (or file) path on the remote machine."),
      limit: z.number().int().positive().max(5_000).optional().describe("Maximum entries to return (default 1000)."),
    },
    options: {
      op: "agent_fs_list",
      jobType: "fs.list",
      buildParams: (args) => ({ path: args.path, limit: args.limit ?? 1000 }),
      buildResult: (outcome, args) => {
        const payload = JSON.parse(outcome.stdout || "{}") as { path?: string; entries?: unknown[] };
        const meta = (outcome.meta ?? {}) as ListMeta;
        return {
          path: payload.path ?? args.path,
          count: meta.count ?? payload.entries?.length ?? 0,
          truncated: meta.truncated ?? false,
          entries: payload.entries ?? [],
        };
      },
    },
  });
}
