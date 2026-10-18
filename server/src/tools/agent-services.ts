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

// ---------------------------------------------------------------------------
// agent_services -- list Windows services
// ---------------------------------------------------------------------------

export interface ServicesArgs {
  agent: string;
  operation?: "list" | "control";
  filter?: string;
  state?: "running" | "stopped";
  top: number;
  name?: string;
  action?: "start" | "stop" | "restart" | "status";
  force?: boolean;
  waitSeconds?: number;
}

export interface ServiceEntry {
  name: string;
  displayName: string;
  status: string;
  startType: string | null;
}

/** PowerShell that lists services and filters/sorts them locally. */
export function servicesListScript(args: ServicesArgs): string {
  const filter = (args.filter ?? "").toLowerCase();
  return buildPsScript([
    `$__filter = ${psQuote(filter)}`,
    `$__state = ${args.state ? psQuote(args.state) : "$null"}`,
    `$__top = ${args.top}`,
    "$__all = foreach ($__s in (Get-Service -ErrorAction Stop)) {",
    "  $__startType = $null",
    "  try { $__startType = $__s.StartType.ToString() } catch { $__startType = $null }",
    "  [pscustomobject]@{ name = $__s.Name; displayName = \"$($__s.DisplayName)\"; status = $__s.Status.ToString(); startType = $__startType }",
    "}",
    "$__all = @($__all)",
    "$__items = $__all",
    "if ($__filter) { $__items = @($__items | Where-Object { $_.name.ToLower().Contains($__filter) -or $_.displayName.ToLower().Contains($__filter) }) }",
    "if ($__state) { $__items = @($__items | Where-Object { $_.status.ToLower() -eq $__state }) }",
    "$__items = @($__items | Sort-Object name)",
    "$__r = @{ total = $__all.Count; matched = $__items.Count; services = @($__items | Select-Object -First $__top) }",
  ]);
}

export function registerAgentServices(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<ServicesArgs>(server, hub, audit, {
    name: "agent_services",
    title: "List or control Windows services on a remote agent",
    description:
      "Windows service management on a remote machine. operation='list' (default) lists services (name, displayName, " +
      "status, startType) sorted by name, filtered with a case-insensitive substring on the service or display name " +
      "and/or by state. operation='control' starts, stops, restarts or inspects (action='status') one service and " +
      "returns its resulting state; 'name' is passed to Get-Service so wildcards are allowed but must match exactly " +
      "one service, many services need an elevated agent (otherwise 'Access is denied'), force=true also affects " +
      "dependent services, and waitSeconds>0 waits for the state transition before reporting.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      operation: z.enum(["list", "control"]).optional().describe("list = inventory (default); control = change one service."),
      filter: z.string().optional().describe("(list) Case-insensitive substring on the service name or display name."),
      state: z.enum(["running", "stopped"]).optional().describe("(list) Only services in this state."),
      top: z.number().int().positive().max(2_000).optional().describe("(list) Return at most this many services (default 200)."),
      name: z.string().min(1).optional().describe("(control) Windows service name (e.g. 'Spooler'); wildcards must match one."),
      action: z.enum(["start", "stop", "restart", "status"]).optional().describe("(control) What to do with the service."),
      force: z.boolean().optional().describe("(control) Also act on dependent services (default false)."),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(300)
        .optional()
        .describe("(control) Wait up to this long for the service to reach the target state (default 0)."),
    },
    options: {
      op: (args) => (args.operation === "control" ? "agent_service_control" : "agent_services"),
      jobType: "exec",
      validate: (args) =>
        windowsOnly(hub)(args) ??
        (args.operation === "control" && args.name === undefined
          ? "operation 'control': 'name' is required"
          : args.operation === "control" && args.action === undefined
            ? "operation 'control': 'action' is required"
            : null),
      timeoutMs: (args) => Math.max(PS_DEFAULT_TIMEOUT_MS, ((args.waitSeconds ?? 0) + 15) * 1_000),
      buildParams: (args) =>
        args.operation === "control"
          ? psExecParams(
              serviceControlScript({
                agent: args.agent,
                name: args.name!,
                action: args.action!,
                force: args.force ?? false,
                waitSeconds: args.waitSeconds ?? 0,
              }),
            )
          : psExecParams(
              servicesListScript({
                agent: args.agent,
                ...(args.filter !== undefined ? { filter: args.filter } : {}),
                ...(args.state !== undefined ? { state: args.state } : {}),
                top: args.top ?? 200,
              }),
            ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<Record<string, unknown>>(outcome.stdout),
    },
  });
}

// ---------------------------------------------------------------------------
// service control -- start/stop/restart a Windows service (helper used by
// agent_services operation='control')
// ---------------------------------------------------------------------------

export interface ServiceControlArgs {
  agent: string;
  name: string;
  action: "start" | "stop" | "restart" | "status";
  force: boolean;
  waitSeconds: number;
}

/** PowerShell that changes one service and reports its resulting state. */
export function serviceControlScript(args: ServiceControlArgs): string {
  const target =
    args.action === "stop" ? "'Stopped'" : args.action === "start" || args.action === "restart" ? "'Running'" : "$null";
  return buildPsScript([
    `$__name = ${psQuote(args.name)}`,
    `$__action = ${psQuote(args.action)}`,
    `$__force = ${psBool(args.force)}`,
    `$__wait = ${args.waitSeconds}`,
    "switch ($__action) {",
    "  'start' { Start-Service -Name $__name -ErrorAction Stop }",
    "  'stop' { if ($__force) { Stop-Service -Name $__name -Force -ErrorAction Stop } else { Stop-Service -Name $__name -ErrorAction Stop } }",
    "  'restart' { if ($__force) { Restart-Service -Name $__name -Force -ErrorAction Stop } else { Restart-Service -Name $__name -ErrorAction Stop } }",
    "  'status' { }",
    "  default { throw \"unsupported action '$__action'\" }",
    "}",
    "$__svc = @(Get-Service -Name $__name -ErrorAction Stop)",
    'if ($__svc.Count -ne 1) { throw "service name \'$__name\' matched $($__svc.Count) services; be more specific" }',
    "$__svc = $__svc[0]",
    `$__target = ${target}`,
    "if ($__wait -gt 0 -and $__target) {",
    "  try { $__svc.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]$__target, [System.TimeSpan]::FromSeconds($__wait)) } catch { }",
    "}",
    "try { $__svc.Refresh() } catch { }",
    "$__startType = $null",
    "try { $__startType = $__svc.StartType.ToString() } catch { $__startType = $null }",
    "$__r = @{ name = $__svc.Name; displayName = $__svc.DisplayName; status = $__svc.Status.ToString(); startType = $__startType; action = $__action }",
  ]);
}

// ---------------------------------------------------------------------------
// service control -- start/stop/restart a Windows service. Registered as
// agent_services operation='control'.
// ---------------------------------------------------------------------------
