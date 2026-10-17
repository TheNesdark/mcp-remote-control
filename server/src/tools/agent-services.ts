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
  filter?: string;
  state?: "running" | "stopped";
  top: number;
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
    title: "List Windows services on a remote agent",
    description:
      "List Windows services (name, displayName, status, startType) on a remote machine, sorted by name. " +
      "Filter with a case-insensitive substring on the service or display name and/or by state. " +
      "Use agent_service_control to start/stop/restart one of them.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      filter: z.string().optional().describe("Case-insensitive substring on the service name or display name."),
      state: z.enum(["running", "stopped"]).optional().describe("Only services in this state."),
      top: z.number().int().positive().max(2_000).optional().describe("Return at most this many services (default 200)."),
    },
    options: {
      op: "agent_services",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          servicesListScript({
            agent: args.agent,
            ...(args.filter !== undefined ? { filter: args.filter } : {}),
            ...(args.state !== undefined ? { state: args.state } : {}),
            top: args.top ?? 200,
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<{ total: number; matched: number; services: ServiceEntry[] }>(outcome.stdout),
    },
  });
}

// ---------------------------------------------------------------------------
// agent_service_control -- start/stop/restart a Windows service
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

export function registerAgentServiceControl(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<ServiceControlArgs>(server, hub, audit, {
    name: "agent_service_control",
    title: "Start, stop or restart a Windows service",
    description:
      "Start, stop, restart or inspect (action='status') a Windows service on a remote machine and return its resulting state. " +
      "'name' is passed to Get-Service, so wildcards are allowed but the result must match exactly one service. " +
      "Many services need an elevated agent; without it the call fails with 'Access is denied'. " +
      "force=true also affects dependent services (Stop-Service/Restart-Service -Force). " +
      "waitSeconds>0 waits for the state transition before reporting (0 = report immediately).",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      name: z.string().min(1).describe("Windows service name (e.g. 'Spooler'); wildcards are allowed but must match one."),
      action: z.enum(["start", "stop", "restart", "status"]).describe("What to do with the service."),
      force: z.boolean().optional().describe("Also act on dependent services (default false)."),
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(300)
        .optional()
        .describe("Wait up to this long for the service to reach the target state (default 0)."),
    },
    options: {
      op: "agent_service_control",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: (args) => Math.max(PS_DEFAULT_TIMEOUT_MS, ((args.waitSeconds ?? 0) + 15) * 1_000),
      buildParams: (args) =>
        psExecParams(
          serviceControlScript({
            agent: args.agent,
            name: args.name,
            action: args.action,
            force: args.force ?? false,
            waitSeconds: args.waitSeconds ?? 0,
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) =>
        psEnvelopeData<{ name: string; displayName: string; status: string; startType: string | null; action: string }>(
          outcome.stdout,
        ),
    },
  });
}
