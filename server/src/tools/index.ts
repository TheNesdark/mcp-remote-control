import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerAgentSessions, registerAgentSoftware, registerAgentTime } from "./agent-diagnostics.ts";
import { registerAgentEventLog } from "./agent-eventlog.ts";
import { registerAgentExec } from "./agent-exec.ts";
import { registerAgentExecAsync } from "./agent-exec-async.ts";
import { registerAgentFsCopy, registerAgentFsDelete, registerAgentFsMkdir, registerAgentFsMove, registerAgentFsSearch } from "./agent-fs-manage.ts";
import { registerAgentFsDownload } from "./agent-fs-download.ts";
import { registerAgentFsHash } from "./agent-fs-hash.ts";
import { registerAgentFsList } from "./agent-fs-list.ts";
import { registerAgentFsRead } from "./agent-fs-read.ts";
import { registerAgentFsUpload } from "./agent-fs-upload.ts";
import { registerAgentFsWrite } from "./agent-fs-write.ts";
import { registerAgentInfo } from "./agent-info.ts";
import { registerAgentJobs } from "./agent-jobs.ts";
import { registerAgentMessage } from "./agent-message.ts";
import { registerAgentNetPorts, registerAgentNetTest } from "./agent-net.ts";
import { registerAgentPower } from "./agent-power.ts";
import { registerAgentPsKill } from "./agent-ps-kill.ts";
import { registerAgentPsList } from "./agent-ps-list.ts";
import { registerAgentRestart } from "./agent-restart.ts";
import { registerAgentScreenshot } from "./agent-screenshot.ts";
import { registerAgentServiceControl, registerAgentServices } from "./agent-services.ts";
import { registerAgentsList } from "./agents-list.ts";

export interface ToolsOptions {
  /** Where agent_screenshot saves pulled images. */
  screenshotDir: string;
  /** Newest screenshots to keep on disk (0 = keep everything). */
  screenshotKeep?: number;
  /** Base URL clients use to fetch those images (empty = relative path only). */
  screenshotBaseUrl?: string;
  /** Audit trail every tool call is recorded in. */
  audit: AuditLog;
}

/** Register every MCP tool exposed by the server. */
export function registerTools(server: McpServer, hub: Hub, options: ToolsOptions): void {
  const { audit, screenshotDir, screenshotKeep, screenshotBaseUrl } = options;
  registerAgentsList(server, hub, audit);
  registerAgentExec(server, hub, audit);
  registerAgentExecAsync(server, hub, audit);
  registerAgentJobs(server, hub, audit);
  registerAgentFsList(server, hub, audit);
  registerAgentFsRead(server, hub, audit);
  registerAgentFsWrite(server, hub, audit);
  registerAgentFsUpload(server, hub, audit);
  registerAgentFsDownload(server, hub, audit);
  registerAgentFsHash(server, hub, audit);
  registerAgentFsSearch(server, hub, audit);
  registerAgentFsMkdir(server, hub, audit);
  registerAgentFsMove(server, hub, audit);
  registerAgentFsCopy(server, hub, audit);
  registerAgentFsDelete(server, hub, audit);
  registerAgentInfo(server, hub, audit);
  registerAgentPsList(server, hub, audit);
  registerAgentPsKill(server, hub, audit);
  registerAgentRestart(server, hub, audit);
  registerAgentScreenshot(server, hub, screenshotDir, audit, screenshotBaseUrl ?? "", screenshotKeep ?? 0);
  registerAgentServices(server, hub, audit);
  registerAgentServiceControl(server, hub, audit);
  registerAgentEventLog(server, hub, audit);
  registerAgentNetPorts(server, hub, audit);
  registerAgentNetTest(server, hub, audit);
  registerAgentPower(server, hub, audit);
  registerAgentMessage(server, hub, audit);
  registerAgentSoftware(server, hub, audit);
  registerAgentTime(server, hub, audit);
  registerAgentSessions(server, hub, audit);
}
