import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";
import {
  buildPsScript,
  PS_DEFAULT_TIMEOUT_MS,
  psEnvelopeData,
  psExecParams,
  psFailure,
  psQuote,
  windowsOnly,
} from "./powershell.ts";

const ICONS = { info: 64, warning: 48, error: 16, question: 32 } as const;
const BUTTONS = { ok: 0, okcancel: 1, yesno: 4, yesnocancel: 3 } as const;
export type MessageStyle = keyof typeof ICONS;
export type MessageButtons = keyof typeof BUTTONS;

export interface MessageArgs {
  agent: string;
  text: string;
  title: string;
  style: MessageStyle;
  buttons: MessageButtons;
}

/**
 * The box must outlive the job (the user closes it whenever), so it is shown by
 * a detached hidden PowerShell. The script is base64-encoded UTF-16 (`-EncodedCommand`),
 * which sidesteps every quoting rule for arbitrary user text.
 */
export function messageScript(args: MessageArgs): string {
  const inner = [
    "Add-Type -AssemblyName System.Windows.Forms",
    `[void][System.Windows.Forms.MessageBox]::Show(${psQuote(args.text)}, ${psQuote(args.title)}, ${BUTTONS[args.buttons]}, ${ICONS[args.style]})`,
  ].join("\n");
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  return buildPsScript([
    `$__enc = ${psQuote(encoded)}`,
    "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand',$__enc) -WindowStyle Hidden | Out-Null",
    `$__r = @{ shown = $true; title = ${psQuote(args.title)}; style = ${psQuote(args.style)}; buttons = ${psQuote(args.buttons)} }`,
  ]);
}

export function registerAgentMessage(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<MessageArgs>(server, hub, audit, {
    name: "agent_message",
    title: "Show a message box on a remote agent",
    description:
      "Pop a Windows message box on the remote machine's interactive desktop (the logged-on user sees it immediately). " +
      "The box is shown by a detached process, so this returns as soon as it is on screen and never blocks on the user: " +
      "the answer is not reported back. Use it to warn someone before a restart, ask them to close a program or flag a " +
      "problem. Requires an interactive session (a locked or absent desktop hides the box in session 0).",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      text: z.string().min(1).describe("Message body."),
      title: z.string().optional().describe("Window title (default 'Remote control')."),
      style: z.enum(["info", "warning", "error", "question"]).optional().describe("Icon shown in the box (default info)."),
      buttons: z
        .enum(["ok", "okcancel", "yesno", "yesnocancel"])
        .optional()
        .describe("Buttons shown in the box (default ok); the answer is not returned."),
    },
    options: {
      op: "agent_message",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          messageScript({
            agent: args.agent,
            text: args.text,
            title: args.title ?? "Remote control",
            style: args.style ?? "info",
            buttons: args.buttons ?? "ok",
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<{ shown: boolean; title: string; style: string; buttons: string }>(outcome.stdout),
    },
  });
}
