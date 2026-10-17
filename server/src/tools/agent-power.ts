import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuditLog } from "../audit.ts";
import type { Hub } from "../hub.ts";
import { registerJobTool } from "./job-tool.ts";
import {
  buildPsScript,
  PS_DEFAULT_TIMEOUT_MS,
  psBool,
  psEnvelopeData,
  psExecParams,
  psFailure,
  psQuote,
  windowsOnly,
} from "./powershell.ts";

export const POWER_ACTIONS = ["shutdown", "restart", "logoff", "lock", "sleep", "hibernate", "abort"] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

/** Actions that interrupt whoever is using the machine and therefore need confirm=true. */
const NEEDS_CONFIRM: readonly PowerAction[] = ["shutdown", "restart", "logoff", "sleep", "hibernate"];

/** `shutdown.exe /c` refuses comments longer than 512 characters. */
const MAX_MESSAGE_CHARS = 512;

export interface PowerArgs {
  agent: string;
  action: PowerAction;
  delaySeconds: number;
  message?: string;
  force: boolean;
  /** Tool-level guard: never reaches the script (see registerAgentPower.validate). */
  confirm?: boolean;
}

/** Launch a script in a detached hidden PowerShell, optionally after a delay. */
function detached(inner: string, delaySeconds: number): string[] {
  const full = delaySeconds > 0 ? `Start-Sleep -Seconds ${delaySeconds}\n${inner}` : inner;
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  return [
    `$__enc = ${psQuote(encoded)}`,
    "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-EncodedCommand',$__enc) -WindowStyle Hidden | Out-Null",
  ];
}

/** PowerShell implementing every power action. */
export function powerScript(args: PowerArgs): string {
  const delay = args.delaySeconds;
  const lines: string[] = [
    `$__action = ${psQuote(args.action)}`,
    `$__delay = ${delay}`,
    `$__msg = ${args.message ? psQuote(args.message) : "$null"}`,
    `$__force = ${psBool(args.force)}`,
    "$__r = @{ action = $__action; delaySeconds = $__delay; scheduled = $true }",
    "switch ($__action) {",
    "  'shutdown' {",
    "    $__a = @('/s', '/t', \"$__delay\")",
    "    if ($__force) { $__a += '/f' }",
    "    if ($__msg -and $__delay -gt 0) { $__a += @('/c', $__msg) }",
    "    & shutdown.exe @__a | Out-Null",
    "    if ($LASTEXITCODE -ne 0) { throw \"shutdown.exe /s failed with exit code $LASTEXITCODE\" }",
    "  }",
    "  'restart' {",
    "    $__a = @('/r', '/t', \"$__delay\")",
    "    if ($__force) { $__a += '/f' }",
    "    if ($__msg -and $__delay -gt 0) { $__a += @('/c', $__msg) }",
    "    & shutdown.exe @__a | Out-Null",
    "    if ($LASTEXITCODE -ne 0) { throw \"shutdown.exe /r failed with exit code $LASTEXITCODE\" }",
    "  }",
    "  'abort' {",
    "    $__r.scheduled = $false",
    "    & shutdown.exe /a | Out-Null",
    "    if ($LASTEXITCODE -ne 0) { throw \"shutdown.exe /a failed with exit code $LASTEXITCODE (no shutdown pending?)\" }",
    "  }",
    ...logoffLines(delay),
    "  'lock' {",
    "    $__r.scheduled = $false",
    "    & rundll32.exe user32.dll,LockWorkStation | Out-Null",
    "  }",
    ...suspendLines("sleep", delay),
    ...suspendLines("hibernate", delay),
    "  default { throw \"unsupported action $__action\" }",
    "}",
  ];
  return buildPsScript(lines);
}

function logoffLines(delay: number): string[] {
  const direct = ["    & shutdown.exe /l | Out-Null", "    if ($LASTEXITCODE -ne 0) { throw \"shutdown.exe /l failed with exit code $LASTEXITCODE\" }"];
  if (delay <= 0) return ["  'logoff' {", ...direct, "  }"];
  return ["  'logoff' {", ...detached("& shutdown.exe /l", delay), "  }"];
}

function suspendLines(action: "sleep" | "hibernate", delay: number): string[] {
  const inner =
    action === "hibernate"
      ? "& shutdown.exe /h"
      : "Add-Type -AssemblyName System.Windows.Forms\n" +
        "if (-not [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $true, $false)) { throw 'the system refused to suspend' }";
  const direct = action === "hibernate"
    ? ["    & shutdown.exe /h | Out-Null", "    if ($LASTEXITCODE -ne 0) { throw \"shutdown.exe /h failed with exit code $LASTEXITCODE (is hibernation enabled?)\" }"]
    : [
        "    Add-Type -AssemblyName System.Windows.Forms",
        "    if (-not [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $true, $false)) { throw 'the system refused to suspend' }",
      ];
  return [`  '${action}' {`, ...(delay > 0 ? detached(inner, delay) : direct), "  }"];
}

export function registerAgentPower(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<PowerArgs>(server, hub, audit, {
    name: "agent_power",
    title: "Shut down, restart, lock or suspend a remote agent",
    description:
      "Power actions on a remote Windows machine: shutdown, restart, logoff, lock, sleep, hibernate and abort " +
      "(cancels a pending shutdown/restart). Everything except lock and abort needs confirm=true. " +
      "delaySeconds defaults to 5 so this call returns before the machine goes down: on shutdown/restart it is the " +
      "native shutdown.exe countdown (cancel it with action='abort'), elsewhere a detached process waits that long. " +
      "'message' (max 512 chars) is shown by Windows only when delaySeconds > 0. " +
      "Expect the agent connection to drop after shutdown/restart/logoff: that is the action succeeding, not a failure.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      action: z.enum(POWER_ACTIONS).describe("What to do with the machine."),
      delaySeconds: z.number().int().min(0).max(600).optional().describe("Wait this long before acting (default 5)."),
      message: z.string().max(MAX_MESSAGE_CHARS).optional().describe("Message shown to the logged-on user (Windows shutdown/restart only)."),
      force: z.boolean().optional().describe("Force applications to close (default true for shutdown/restart)."),
      confirm: z.boolean().optional().describe("Must be true for shutdown, restart, logoff, sleep and hibernate."),
    },
    options: {
      op: "agent_power",
      jobType: "exec",
      validate: (args) => {
        if (NEEDS_CONFIRM.includes(args.action) && args.confirm !== true) {
          return `refusing to ${args.action} '${args.agent}' without confirm=true`;
        }
        return windowsOnly(hub)(args);
      },
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          powerScript({
            agent: args.agent,
            action: args.action,
            delaySeconds: args.delaySeconds ?? 5,
            ...(args.message !== undefined ? { message: args.message } : {}),
            force: args.force ?? (args.action === "shutdown" || args.action === "restart"),
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<{ action: string; delaySeconds: number; scheduled: boolean }>(outcome.stdout),
    },
  });
}
