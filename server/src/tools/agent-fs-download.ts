import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Hub } from "../hub.ts";
import { downloadFile } from "../transfers.ts";
import { toolError, toolJson } from "./util.ts";

export function registerAgentFsDownload(server: McpServer, hub: Hub): void {
  server.registerTool(
    "agent_fs_download",
    {
      title: "Download a file from a remote agent",
      description:
        "Copy a file from a remote machine to this (central server) machine in chunks, verifying sha256 and size end to end. " +
        "Big files can take a while; the transfer is capped at 1 GiB.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        remotePath: z.string().min(1).describe("Source path on the remote machine."),
        localPath: z.string().min(1).describe("Destination path on the central server machine."),
        timeoutMs: z.number().int().positive().optional().describe("Per-chunk timeout in milliseconds."),
      },
    },
    async (args) => {
      try {
        const result = await downloadFile(hub, args.agent, args.remotePath, args.localPath, {
          timeoutMs: args.timeoutMs,
        });
        return toolJson({ ok: true, localPath: result.path, bytes: result.bytes, sha256: result.sha256 });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
