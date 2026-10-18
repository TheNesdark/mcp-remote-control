import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerAgentSessions, registerAgentSoftware, registerAgentTime } from "./agent-diagnostics.ts";
import { registerAgentEventLog } from "./agent-eventlog.ts";
import { registerAgentExec } from "./agent-exec.ts";
import { registerAgentFs } from "./agent-fs.ts";
import { registerAgentInfo } from "./agent-info.ts";
import { registerAgentJobs } from "./agent-jobs.ts";
import { registerAgentMessage } from "./agent-message.ts";
import { registerAgentNet } from "./agent-net.ts";
import { registerAgentPower } from "./agent-power.ts";
import { registerAgentPs } from "./agent-ps.ts";
import { registerAgentRestart } from "./agent-restart.ts";
import { registerAgentScreenshot } from "./agent-screenshot.ts";
import { registerAgentCuaTools } from "./agent-cua.ts";
import { registerAgentServices } from "./agent-services.ts";
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

/**
 * Register every MCP tool exposed by the server.
 *
 * Several former one-shot tools were consolidated behind an `operation`
 * selector (agent_fs[_transfer], agent_ps, agent_net, agent_services,
 * agent_jobs, and agent_exec's async flag); the audit trail keeps recording
 * the original per-operation names.
 */
export function registerTools(server: McpServer, hub: Hub, options: ToolsOptions): void {
  const { audit, screenshotDir, screenshotKeep, screenshotBaseUrl } = options;
  registerAgentsList(server, hub, audit);
  registerAgentExec(server, hub, audit);
  registerAgentJobs(server, hub, audit);
  registerAgentFs(server, hub, audit);
  registerAgentInfo(server, hub, audit);
  registerAgentPs(server, hub, audit);
  registerAgentRestart(server, hub, audit);
  registerAgentScreenshot(server, hub, screenshotDir, audit, screenshotBaseUrl ?? "", screenshotKeep ?? 0);
  registerAgentCuaTools(server, hub, audit, { screenshotDir, screenshotBaseUrl: screenshotBaseUrl ?? "" });
  registerAgentServices(server, hub, audit);
  registerAgentEventLog(server, hub, audit);
  registerAgentNet(server, hub, audit);
  registerAgentPower(server, hub, audit);
  registerAgentMessage(server, hub, audit);
  registerAgentSoftware(server, hub, audit);
  registerAgentTime(server, hub, audit);
  registerAgentSessions(server, hub, audit);
}
