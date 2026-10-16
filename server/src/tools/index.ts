import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerAgentExec } from "./agent-exec.ts";
import { registerAgentFsDownload } from "./agent-fs-download.ts";
import { registerAgentFsList } from "./agent-fs-list.ts";
import { registerAgentFsRead } from "./agent-fs-read.ts";
import { registerAgentFsUpload } from "./agent-fs-upload.ts";
import { registerAgentFsWrite } from "./agent-fs-write.ts";
import { registerAgentInfo } from "./agent-info.ts";
import { registerAgentPsKill } from "./agent-ps-kill.ts";
import { registerAgentPsList } from "./agent-ps-list.ts";
import { registerAgentScreenshot } from "./agent-screenshot.ts";
import { registerAgentsList } from "./agents-list.ts";

export interface ToolsOptions {
  /** Where agent_screenshot saves pulled images. */
  screenshotDir: string;
  /** Audit trail every tool call is recorded in. */
  audit: AuditLog;
}

/** Register every MCP tool exposed by the server. */
export function registerTools(server: McpServer, hub: Hub, options: ToolsOptions): void {
  const { audit, screenshotDir } = options;
  registerAgentsList(server, hub, audit);
  registerAgentExec(server, hub);
  registerAgentFsList(server, hub);
  registerAgentFsRead(server, hub);
  registerAgentFsWrite(server, hub, audit);
  registerAgentFsUpload(server, hub, audit);
  registerAgentFsDownload(server, hub, audit);
  registerAgentInfo(server, hub);
  registerAgentPsList(server, hub);
  registerAgentPsKill(server, hub, audit);
  registerAgentScreenshot(server, hub, screenshotDir, audit);
}
