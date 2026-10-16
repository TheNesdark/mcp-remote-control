import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Hub } from "../hub.ts";
import { uploadFile } from "../transfers.ts";
import { toolError, toolJson } from "./util.ts";

export function registerAgentFsUpload(server: McpServer, hub: Hub): void {
  server.registerTool(
    "agent_fs_upload",
    {
      title: "Upload a file to a remote agent",
      description:
        "Copy a file from this (central server) machine to a remote machine in chunks, then verify the sha256 remotely. " +
        "Big files can take a while; the transfer is capped at 1 GiB.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
        localPath: z.string().min(1).describe("Source path on the central server machine."),
        remotePath: z.string().min(1).describe("Destination path on the remote machine."),
        mkdirs: z.boolean().optional().describe("Create parent directories on the remote side (default false)."),
        timeoutMs: z.number().int().positive().optional().describe("Per-chunk timeout in milliseconds."),
      },
    },
    async (args) => {
      try {
        const result = await uploadFile(hub, args.agent, args.localPath, args.remotePath, {
          mkdirs: args.mkdirs ?? false,
          timeoutMs: args.timeoutMs,
        });
        return toolJson({ ok: true, remotePath: result.path, bytes: result.bytes, sha256: result.sha256 });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
