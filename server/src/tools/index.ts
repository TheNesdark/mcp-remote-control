import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Hub } from "../hub.ts";
import { registerAgentExec } from "./agent-exec.ts";
import { registerAgentFsDownload } from "./agent-fs-download.ts";
import { registerAgentFsList } from "./agent-fs-list.ts";
import { registerAgentFsRead } from "./agent-fs-read.ts";
import { registerAgentFsUpload } from "./agent-fs-upload.ts";
import { registerAgentFsWrite } from "./agent-fs-write.ts";
import { registerAgentsList } from "./agents-list.ts";

/** Register every MCP tool exposed by the server. */
export function registerTools(server: McpServer, hub: Hub): void {
  registerAgentsList(server, hub);
  registerAgentExec(server, hub);
  registerAgentFsList(server, hub);
  registerAgentFsRead(server, hub);
  registerAgentFsWrite(server, hub);
  registerAgentFsUpload(server, hub);
  registerAgentFsDownload(server, hub);
}
