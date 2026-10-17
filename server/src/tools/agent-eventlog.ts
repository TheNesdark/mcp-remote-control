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

/** Get-WinEvent Level numbers (1 = most severe). */
const LEVELS = { critical: 1, error: 2, warning: 3, information: 4, verbose: 5 } as const;
export type EventLevel = keyof typeof LEVELS;
export const EVENT_LOGS = ["System", "Application", "Security"] as const;

export interface EventLogArgs {
  agent: string;
  log: string;
  level?: EventLevel;
  source?: string;
  hours: number;
  max: number;
  messageChars: number;
}

export interface EventLogEntry {
  time: string;
  level: string;
  id: number;
  provider: string;
  message: string;
}

export interface EventLogData {
  log: string;
  count: number;
  /** Set when the query failed without being fatal (e.g. an empty result set). */
  note?: string;
  events: EventLogEntry[];
}

/** PowerShell that reads the newest matching events from one Windows log. */
export function eventLogScript(args: EventLogArgs): string {
  const level = args.level ? LEVELS[args.level] : null;
  return buildPsScript([
    `$__log = ${psQuote(args.log)}`,
    `$__source = ${args.source ? psQuote(args.source) : "$null"}`,
    `$__hours = ${args.hours}`,
    `$__max = ${args.max}`,
    `$__chars = ${args.messageChars}`,
    `$__level = ${level ?? "$null"}`,
    "$__filter = @{ LogName = $__log; StartTime = (Get-Date).AddHours(-1 * $__hours) }",
    "if ($__level) { $__filter.Level = $__level }",
    "if ($__source) { $__filter.ProviderName = $__source }",
    "$__note = $null",
    "$__events = @()",
    "try { $__events = @(Get-WinEvent -FilterHashtable $__filter -MaxEvents $__max -ErrorAction Stop) }",
    "catch {",
    "  $__note = $_.Exception.Message",
    "  if ($_.Exception.GetType().Name -eq 'UnauthorizedAccessException') { throw }",
    "}",
    "$__items = foreach ($__e in $__events) {",
    "  $__msg = ''",
    "  try { $__msg = \"$($__e.Message)\" } catch { $__msg = '' }",
    "  if ($__msg.Length -gt $__chars) { $__msg = $__msg.Substring(0, $__chars) + '...' }",
    "  $__time = ''",
    "  try { $__time = $__e.TimeCreated.ToString('o') } catch { $__time = '' }",
    "  [pscustomobject]@{ time = $__time; level = \"$($__e.LevelDisplayName)\"; id = $__e.Id; provider = \"$($__e.ProviderName)\"; message = $__msg }",
    "}",
    "$__r = @{ log = $__log; count = @($__items).Count; events = @($__items) }",
    "if ($__note) { $__r.note = $__note }",
  ]);
}

export function registerAgentEventLog(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<EventLogArgs>(server, hub, audit, {
    name: "agent_eventlog",
    title: "Read the Windows event log of a remote agent",
    description:
      "Read the newest events from a Windows event log (System, Application or Security) on a remote machine, " +
      "newest first. Filter by severity, provider/source and look-back window. Messages are truncated to " +
      "messageChars. The Security log and some providers need an elevated agent ('Access is denied' otherwise). " +
      "Use this to diagnose crashes, service failures and update problems without RDP.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      log: z.enum(EVENT_LOGS).optional().describe("Event log to read (default System)."),
      level: z.enum(["critical", "error", "warning", "information", "verbose"]).optional().describe("Only events of this severity."),
      source: z.string().optional().describe("Only events from this provider (e.g. 'Service Control Manager')."),
      hours: z.number().int().positive().max(8_760).optional().describe("Look-back window in hours (default 24)."),
      max: z.number().int().positive().max(500).optional().describe("Return at most this many events (default 50)."),
      messageChars: z.number().int().positive().max(4_000).optional().describe("Truncate each message to this many characters (default 600)."),
    },
    options: {
      op: "agent_eventlog",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          eventLogScript({
            agent: args.agent,
            log: args.log ?? "System",
            ...(args.level !== undefined ? { level: args.level } : {}),
            ...(args.source !== undefined ? { source: args.source } : {}),
            hours: args.hours ?? 24,
            max: args.max ?? 50,
            messageChars: args.messageChars ?? 600,
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<EventLogData>(outcome.stdout),
    },
  });
}
