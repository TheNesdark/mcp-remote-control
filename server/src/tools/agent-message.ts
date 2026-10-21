import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";
import { windowsOnly } from "./powershell.ts";

const ICON_STYLES = ["info", "warning", "error", "question"] as const;
const BUTTON_SETS = ["ok", "okcancel", "yesno", "yesnocancel"] as const;
export type MessageStyle = (typeof ICON_STYLES)[number];
export type MessageButtons = (typeof BUTTON_SETS)[number];

/** Short: the agent only starts the thread that owns the box and answers. */
const MESSAGE_TIMEOUT_MS = 15_000;

export interface MessageArgs {
  agent: string;
  text: string;
  title: string;
  style: MessageStyle;
  buttons: MessageButtons;
}

/** The `message` job parameters (agent-dotnet Message.cs). */
export function messageParams(args: MessageArgs): { text: string; title: string; style: MessageStyle; buttons: MessageButtons } {
  return { text: args.text, title: args.title, style: args.style, buttons: args.buttons };
}

/**
 * The box is drawn by the agent process, not by a child process: an exec job
 * runs inside a job object with KILL_ON_JOB_CLOSE, so anything the shell starts
 * dies with the job (a PowerShell MessageBox vanished before the user saw it).
 * The agent thread outlives the job, so the answer is immediate and the notice
 * stays until the user closes it.
 */
export function registerAgentMessage(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<MessageArgs>(server, hub, audit, {
    name: "agent_message",
    title: "Show a message box on a remote agent",
    description:
      "Pop a Windows message box on the remote machine's interactive desktop (the logged-on user sees it immediately). " +
      "The box is owned by the agent process, so this returns as soon as it is on screen and never blocks on the user: " +
      "the answer is not reported back. Use it to warn someone before a restart, ask them to close a program or flag a " +
      "problem. Requires a logged-on interactive session (a locked or absent desktop hides the box).",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      text: z.string().min(1).describe("Message body."),
      title: z.string().optional().describe("Window title (default 'Remote control')."),
      style: z.enum(ICON_STYLES).optional().describe("Icon shown in the box (default info)."),
      buttons: z
        .enum(BUTTON_SETS)
        .optional()
        .describe("Buttons shown in the box (default ok); the answer is not returned."),
    },
    options: {
      op: "agent_message",
      jobType: "message",
      validate: windowsOnly(hub),
      timeoutMs: () => MESSAGE_TIMEOUT_MS,
      buildParams: (args) =>
        messageParams({
          agent: args.agent,
          text: args.text,
          title: args.title?.trim() || "Remote control",
          style: args.style ?? "info",
          buttons: args.buttons ?? "ok",
        }),
      // The agent answers with { shown, title, style, buttons } in the meta.
      buildResult: (outcome) => outcome.meta ?? { ok: true },
    },
  });
}
