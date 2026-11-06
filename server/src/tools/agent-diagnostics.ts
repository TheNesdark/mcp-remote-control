/**
 * Fleet diagnostics: installed software, clock/NTP health and interactive
 * sessions. All three are fixed PowerShell probes wrapped in the shared
 * `{ok,data}` envelope (see powershell.ts), so they work on every agent that
 * can run `exec` with shell=powershell and need no agent-side changes.
 */
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

// ---------------------------------------------------------------------------
// agent_software -- installed program inventory (registry uninstall keys)
// ---------------------------------------------------------------------------

export interface SoftwareArgs {
  agent: string;
  filter?: string;
  scope: "machine" | "user" | "all";
  top: number;
}

export interface SoftwareEntry {
  name: string;
  version: string | null;
  publisher: string | null;
  installDate: string | null;
  installLocation: string | null;
  scope: "machine" | "user";
}

export interface SoftwareData {
  total: number;
  scope: string;
  programs: SoftwareEntry[];
}

/** Reads the Add/Remove Programs registry keys (HKLM 64+32 bit, optionally HKCU). */
export function softwareScript(args: SoftwareArgs): string {
  return buildPsScript([
    `$__filter = ${psQuote((args.filter ?? "").toLowerCase())}`,
    `$__scope = ${psQuote(args.scope)}`,
    `$__top = ${args.top}`,
    "$__keys = @()",
    "if ($__scope -ne 'user') {",
    "  $__keys += 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    "  $__keys += 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    "}",
    "if ($__scope -ne 'machine') { $__keys += 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' }",
    "$__items = foreach ($__key in $__keys) {",
    "  Get-ItemProperty -Path $__key -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | ForEach-Object {",
    "    $__isUser = $_.PSPath.ToString().Contains('HKEY_CURRENT_USER')",
    // Plain hashtables and no if-statements inside the literal: Windows 7
    // agents run PowerShell 2.0, where neither [pscustomobject] nor
    // expression-valued ifs inside hash literals exist.
    "    $__dname = \"$($_.DisplayName)\"",
    "    $__dver = $null; if ($_.DisplayVersion) { $__dver = \"$($_.DisplayVersion)\" }",
    "    $__dpub = $null; if ($_.Publisher) { $__dpub = \"$($_.Publisher)\" }",
    "    $__ddate = $null; if ($_.InstallDate) { $__ddate = \"$($_.InstallDate)\" }",
    "    $__dloc = $null; if ($_.InstallLocation) { $__dloc = \"$($_.InstallLocation)\" }",
    "    @{ name = $__dname; version = $__dver; publisher = $__dpub; installDate = $__ddate; installLocation = $__dloc; scope = $(if ($__isUser) { 'user' } else { 'machine' }) }",
    "  }",
    "}",
    // Deduplicate by name+version (32/64-bit entries repeat themselves),
    // without Group-Object over hashtables (unreliable in PowerShell 2.0).
    "$__seen = @{}",
    "$__dedup = @()",
    "foreach ($__it in @($__items)) {",
    "  $__dk = \"$($__it.name)|$($__it.version)\"",
    "  if (-not $__seen.ContainsKey($__dk)) { $__seen[$__dk] = $true; $__dedup += ,$__it }",
    "}",
    "$__items = @($__dedup)",
    "if ($__filter) { $__items = @($__items | Where-Object { $_.name.ToLower().Contains($__filter) }) }",
    "$__items = @($__items | Sort-Object { $_['name'] })",
    "$__r = @{ total = @($__items).Count; scope = $__scope; programs = @($__items | Select-Object -First $__top) }",
  ]);
}

export function registerAgentSoftware(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<SoftwareArgs>(server, hub, audit, {
    name: "agent_software",
    title: "List installed programs on a remote agent",
    description:
      "Inventory of installed programs read from the Add/Remove Programs registry keys (64-bit, 32-bit and " +
      "optionally per-user hives), deduplicated and sorted by name. Filter is a case-insensitive substring on the " +
      "program name ('filter=Office' finds every Office product). Use it for license audits and to check whether a " +
      "specific version is deployed on a machine. Silent installers and portable apps are not listed, same as " +
      "Settings > Apps.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      filter: z.string().optional().describe("Case-insensitive substring on the program name."),
      scope: z.enum(["machine", "user", "all"]).optional().describe("Machine hives, current user's hive, or both (default machine)."),
      top: z.number().int().positive().max(1_000).optional().describe("Return at most this many entries (default 200)."),
    },
    options: {
      op: "agent_software",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          softwareScript({
            agent: args.agent,
            ...(args.filter !== undefined ? { filter: args.filter } : {}),
            scope: args.scope ?? "machine",
            top: args.top ?? 200,
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<SoftwareData>(outcome.stdout),
    },
  });
}

// ---------------------------------------------------------------------------
// agent_time -- clock, timezone and NTP health
// ---------------------------------------------------------------------------

export interface TimeArgs {
  agent: string;
}

export interface TimeData {
  local: string;
  utc: string;
  timezone: string | null;
  /** Agent's UTC clock minus the server's clock, in ms (negative = agent behind). */
  offsetFromServerMs: number;
  ntp: { service: string; source: string | null; lastSync: string | null } | null;
}

export function timeScript(): string {
  return buildPsScript([
    "$__now = Get-Date",
    // Get-TimeZone needs PowerShell 3.0: fall back to tzutil on Windows 7
    // (Win32_TimeZone reports an empty Id on some of those machines).
    "$__tz = $null",
    "if (Get-Command Get-TimeZone -ErrorAction SilentlyContinue) { $__tz = (Get-TimeZone).Id }",
    "if (-not $__tz) { try { $__tz = (tzutil /g) } catch { $__tz = $null } }",
    "$__r = @{",
    "  local = $__now.ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')",
    "  utc = $__now.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
    "  timezone = \"$__tz\"",
    "  ntp = $null",
    "}",
    // NTP health is best-effort: W32Time may be absent and w32tm needs rights.
    "$__svc = Get-Service -Name W32Time -ErrorAction SilentlyContinue",
    "if ($__svc) {",
    "  $__src = $null; $__sync = $null",
    "  try {",
    "    $__w = w32tm /query /status | Out-String",
    "    if ($__w -match 'Source:\\s*(.+)') { $__src = $Matches[1].Trim() }",
    "    if ($__w -match 'Last (?:Sync|sincronizaci[oó]n):\\s*(.+)') { $__sync = $Matches[1].Trim() }",
    "  } catch {}",
    "  $__r.ntp = @{ service = \"$($__svc.Status)\"; source = $__src; lastSync = $__sync }",
    "}",
  ]);
}

export function registerAgentTime(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<TimeArgs>(server, hub, audit, {
    name: "agent_time",
    title: "Check clock and time sync on a remote agent",
    description:
      "Read the remote machine's date, time and timezone and compare its UTC clock against the server's clock " +
      "(offsetFromServerMs; anything beyond a couple of minutes breaks Kerberos, domain logons and scheduled tasks). " +
      "Also reports the W32Time service state and its NTP source when readable. Read this first when a machine has " +
      "authentication or domain-join errors.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
    },
    options: {
      op: "agent_time",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: () => psExecParams(timeScript()),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => {
        const data = psEnvelopeData<Omit<TimeData, "offsetFromServerMs">>(outcome.stdout);
        // The server clock is the reference: measure the agent clock against the
        // moment this result arrived, which is within the job's round trip.
        const agentUtc = Date.parse(data.utc);
        const offset = Number.isFinite(agentUtc) ? agentUtc - Date.now() : null;
        return { ...data, ...(offset !== null ? { offsetFromServerMs: offset } : {}) };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// agent_sessions -- who is logged on interactively
// ---------------------------------------------------------------------------

export interface SessionsArgs {
  agent: string;
  interactiveOnly?: boolean;
}

export interface SessionEntry {
  user: string | null;
  logonId: string;
  logonType: number;
  logonTypeLabel: string;
  /** How many sessions collapse into this row (services spawn many). */
  count: number;
  logonTime: string | null;
  authenticationPackage: string | null;
}

export interface SessionsData {
  total: number;
  sessions: SessionEntry[];
}

export function sessionsScript(args: { interactiveOnly: boolean }): string {
  return buildPsScript([
    `$__interactiveOnly = ${args.interactiveOnly ? "$true" : "$false"}`,
    // Native WMI (Get-WmiObject) instead of CIM: Windows 7 agents run
    // PowerShell 2.0, which has no Get-CimInstance/Get-CimAssociatedInstance.
    // Plain hashtables instead of [pscustomobject], same reason. The account
    // comes from the Win32_LoggedOnUser association (locale-proof, unlike
    // parsing `query user`).
    "if ($__interactiveOnly) {",
    "  $__sessions = @(Get-WmiObject -Class Win32_LogonSession -Filter 'LogonType=2 OR LogonType=10' -ErrorAction Stop)",
    "} else {",
    "  $__sessions = @(Get-WmiObject -Class Win32_LogonSession -ErrorAction Stop)",
    "}",
    "$__items = @(foreach ($__s in $__sessions) {",
    "  $__user = $null",
    "  try {",
    "    $__acct = @(Get-WmiObject -Query (\"ASSOCIATORS OF {Win32_LogonSession.LogonId='\" + $__s.LogonId + \"'} WHERE AssocClass=Win32_LoggedOnUser\")) | Select-Object -First 1",
    "    if ($__acct) { $__user = \"$($__acct.Domain)\\$($__acct.Name)\" }",
    "  } catch {}",
    "  $__lt = $null",
    "  if ($__s.StartTime) { try { $__lt = $__s.ConvertToDateTime($__s.StartTime).ToString('yyyy-MM-ddTHH:mm:sszzz') } catch { $__lt = \"$($__s.StartTime)\" } }",
    "  @{ user = $__user; logonId = \"$($__s.LogonId)\"; logonType = [int]$__s.LogonType; logonTime = $__lt; authenticationPackage = $(if ($__s.AuthenticationPackage) { \"$($__s.AuthenticationPackage)\" } else { $null }) }",
    "})",
    // Collapse repeated identical users (services spawn many sessions).
    "$__acc = @{}",
    "foreach ($__i in $__items) {",
    "  $__k = \"$($__i.user)|$($__i.logonType)\"",
    "  if (-not $__acc.ContainsKey($__k)) { $__acc[$__k] = @{ count = 0; first = $__i; last = $null } }",
    "  $__g = $__acc[$__k]",
    "  $__g.count = $__g.count + 1",
    "  if ($__i.logonTime -and ((-not $__g.last) -or ($__i.logonTime -gt $__g.last))) { $__g.last = $__i.logonTime }",
    "  $__acc[$__k] = $__g",
    "}",
    "$__items = @(foreach ($__k in @($__acc.Keys)) {",
    "  $__c = $__acc[$__k]",
    "  @{ user = $__c.first.user; logonId = $__c.first.logonId; logonType = $__c.first.logonType; count = $__c.count; logonTime = $__c.last; authenticationPackage = $__c.first.authenticationPackage }",
    "})",
    "$__items = @($__items | Sort-Object { $_['user'] })",
    "$__labels = @{ 2='interactive'; 3='network'; 4='batch'; 5='service'; 7='unlock'; 8='network-cleartext'; 9='new-credentials'; 10='remote-interactive'; 11='cached-interactive' }",
    "$__r = @{ total = @($__items).Count; sessions = @($__items | ForEach-Object { @{ user = $_.user; logonId = $_.logonId; logonType = $_.logonType; logonTypeLabel = $(if ($__labels.ContainsKey([int]$_.logonType)) { $__labels[[int]$_.logonType] } else { \"type-$($_.logonType)\" }); logonTime = $_.logonTime; authenticationPackage = $_.authenticationPackage } }) }",
  ]);
}

export function registerAgentSessions(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<SessionsArgs>(server, hub, audit, {
    name: "agent_sessions",
    title: "List logon sessions on a remote agent",
    description:
      "Who is logged on at the machine's console and over RDP, read through CIM (works regardless of the Windows " +
      "display language). By default only interactive and remote-interactive (RDP) logons are returned; set " +
      "interactiveOnly=false to include service/batch/network sessions too (they are collapsed per user and show a " +
      "count). Use it to see whether someone is in front of the PC before rebooting it, or to find leftover RDP " +
      "sessions. When the agent runs without elevated rights it may only see its own sessions.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      interactiveOnly: z.boolean().optional().describe("Only console/RDP logons (default true)."),
    },
    options: {
      op: "agent_sessions",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) => psExecParams(sessionsScript({ interactiveOnly: args.interactiveOnly ?? true })),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<SessionsData>(outcome.stdout),
    },
  });
}
