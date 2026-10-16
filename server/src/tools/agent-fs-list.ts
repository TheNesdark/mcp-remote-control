import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Hub } from "../hub.ts";
import { toolError, toolJson } from "./util.ts";

interface ListMeta {
  count?: number;
  truncated?: boolean;
}

export function registerAgentFsList(server: McpServer, hub: Hub): void {
  server.registerTool(
    "agent_fs_list",
    {
      title: "List a directory on a remote agent",
      description:
        "List the contents of a directory on a remote machine (or describe a single file if 'path' points to one). " +
        "Returns entries with name, type (file|dir|symlink|other), size (null for directories) and mtime.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        path: z.string().min(1).describe("Directory (or file) path on the remote machine."),
        limit: z.number().int().positive().max(5_000).optional().describe("Maximum entries to return (default 1000)."),
      },
    },
    async (args) => {
      try {
        const outcome = await hub.request(args.agent, "fs.list", { path: args.path, limit: args.limit ?? 1000 });
        if (!outcome.ok) return toolJson({ ok: false, error: outcome.error ?? "fs.list failed" }, true);
        const payload = JSON.parse(outcome.stdout || "{}") as { path?: string; entries?: unknown[] };
        const meta = (outcome.meta ?? {}) as ListMeta;
        return toolJson({
          path: payload.path ?? args.path,
          count: meta.count ?? payload.entries?.length ?? 0,
          truncated: meta.truncated ?? false,
          entries: payload.entries ?? [],
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
