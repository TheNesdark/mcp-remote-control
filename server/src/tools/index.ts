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
import { registerAgentRestart } from "./agent-restart.ts";
import { registerAgentScreenshot } from "./agent-screenshot.ts";
import { registerAgentsList } from "./agents-list.ts";

export interface ToolsOptions {
  /** Where agent_screenshot saves pulled images. */
  screenshotDir: string;
  /** Base URL clients use to fetch those images (empty = relative path only). */
  screenshotBaseUrl?: string;
  /** Audit trail every tool call is recorded in. */
  audit: AuditLog;
}

/** Register every MCP tool exposed by the server. */
export function registerTools(server: McpServer, hub: Hub, options: ToolsOptions): void {
  const { audit, screenshotDir, screenshotBaseUrl } = options;
  registerAgentsList(server, hub, audit);
  registerAgentExec(server, hub, audit);
  registerAgentFsList(server, hub, audit);
  registerAgentFsRead(server, hub, audit);
  registerAgentFsWrite(server, hub, audit);
  registerAgentFsUpload(server, hub, audit);
  registerAgentFsDownload(server, hub, audit);
  registerAgentInfo(server, hub, audit);
  registerAgentPsList(server, hub, audit);
  registerAgentPsKill(server, hub, audit);
  registerAgentRestart(server, hub, audit);
  registerAgentScreenshot(server, hub, screenshotDir, audit, screenshotBaseUrl ?? "");
}
