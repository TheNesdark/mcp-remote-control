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
// agent_net_ports -- listening sockets and their owning process
// ---------------------------------------------------------------------------

export interface NetPortsArgs {
  agent: string;
  protocol: "tcp" | "udp" | "all";
  state: "listen" | "established" | "all";
  filter?: string;
  top: number;
}

export interface NetConnection {
  protocol: "tcp" | "udp";
  localAddress: string;
  localPort: number;
  remoteAddress: string | null;
  remotePort: number | null;
  state: string;
  pid: number;
  process: string;
}

export interface NetPortsData {
  total: number;
  connections: NetConnection[];
}

/** PowerShell that maps TCP/UDP endpoints to the process that owns them. */
export function netPortsScript(args: NetPortsArgs): string {
  const filter = (args.filter ?? "").toLowerCase();
  return buildPsScript([
    `$__protocol = ${psQuote(args.protocol)}`,
    `$__state = ${psQuote(args.state)}`,
    `$__filter = ${psQuote(filter)}`,
    `$__top = ${args.top}`,
    "$__names = @{}",
    "foreach ($__p in (Get-Process -ErrorAction SilentlyContinue)) { $__names[[int]$__p.Id] = $__p.ProcessName }",
    "$__tcp = @()",
    "if ($__protocol -ne 'udp') { $__tcp = @(Get-NetTCPConnection -ErrorAction Stop) }",
    "$__udp = @()",
    "if ($__protocol -ne 'tcp') { $__udp = @(Get-NetUDPEndpoint -ErrorAction Stop) }",
    "$__tcpItems = foreach ($__c in $__tcp) {",
    "  $__st = $__c.State.ToString()",
    "  $__keep = $true",
    "  if ($__state -eq 'listen' -and $__st -ne 'Listen') { $__keep = $false }",
    "  if ($__state -eq 'established' -and $__st -ne 'Established') { $__keep = $false }",
    "  if ($__keep) {",
    "    $__pid = [int]$__c.OwningProcess",
    "    [pscustomobject]@{ protocol = 'tcp'; localAddress = \"$($__c.LocalAddress)\"; localPort = [int]$__c.LocalPort; remoteAddress = \"$($__c.RemoteAddress)\"; remotePort = [int]$__c.RemotePort; state = $__st; pid = $__pid; process = \"$($__names[$__pid])\" }",
    "  }",
    "}",
    "$__udpItems = foreach ($__e in $__udp) {",
    "  $__pid = [int]$__e.OwningProcess",
    "  [pscustomobject]@{ protocol = 'udp'; localAddress = \"$($__e.LocalAddress)\"; localPort = [int]$__e.LocalPort; remoteAddress = $null; remotePort = $null; state = ''; pid = $__pid; process = \"$($__names[$__pid])\" }",
    "}",
    "$__items = @($__tcpItems) + @($__udpItems)",
    "if ($__filter) { $__items = @($__items | Where-Object { $_.process.ToLower().Contains($__filter) -or $_.localAddress.ToLower().Contains($__filter) -or (\"$($_.localPort)\").Contains($__filter) }) }",
    "$__items = @($__items | Sort-Object localPort)",
    "$__r = @{ total = @($__items).Count; connections = @($__items | Select-Object -First $__top) }",
  ]);
}

export function registerAgentNetPorts(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<NetPortsArgs>(server, hub, audit, {
    name: "agent_net_ports",
    title: "List open ports on a remote agent",
    description:
      "List TCP/UDP endpoints on a remote machine together with the pid and process name that owns each one " +
      "(via Get-NetTCPConnection / Get-NetUDPEndpoint, so it needs Windows 8 / Server 2012 or newer). " +
      "By default only TCP listeners are returned; use state='established' or 'all' to see active connections. " +
      "Filter with a case-insensitive substring on the process name, the local address or the local port. " +
      "Handy to find what is using a port before stopping a service.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      protocol: z.enum(["tcp", "udp", "all"]).optional().describe("Transport to inspect (default tcp)."),
      state: z.enum(["listen", "established", "all"]).optional().describe("TCP state to keep (default listen)."),
      filter: z.string().optional().describe("Case-insensitive substring on process name, local address or local port."),
      top: z.number().int().positive().max(2_000).optional().describe("Return at most this many entries (default 200)."),
    },
    options: {
      op: "agent_net_ports",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          netPortsScript({
            agent: args.agent,
            protocol: args.protocol ?? "tcp",
            state: args.state ?? "listen",
            ...(args.filter !== undefined ? { filter: args.filter } : {}),
            top: args.top ?? 200,
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<NetPortsData>(outcome.stdout),
    },
  });
}

// ---------------------------------------------------------------------------
// agent_net_test -- ping / DNS / TCP reachability from the remote machine
// ---------------------------------------------------------------------------

export interface NetTestArgs {
  agent: string;
  host: string;
  port?: number;
  count: number;
  dns: boolean;
  ping: boolean;
}

export interface NetTestData {
  host: string;
  addresses: string[];
  pings: { address: string; responseTimeMs: number | null; status: string }[];
  tcp?: { port: number; open: boolean };
}

/** PowerShell that resolves, pings and (optionally) opens a TCP connection. */
export function netTestScript(args: NetTestArgs): string {
  return buildPsScript([
    `$__host = ${psQuote(args.host)}`,
    `$__port = ${args.port ?? 0}`,
    `$__count = ${args.count}`,
    `$__dns = ${psBool(args.dns)}`,
    `$__ping = ${psBool(args.ping)}`,
    "$__r = @{ host = $__host }",
    "$__addresses = @()",
    "if ($__dns) {",
    "  try { $__addresses = @(Resolve-DnsName -Name $__host -Type A,AAAA -ErrorAction Stop | ForEach-Object { \"$($_.IPAddress)\" } | Where-Object { $_ }) } catch { $__addresses = @() }",
    "}",
    "$__r.addresses = @($__addresses)",
    "$__pings = @()",
    "if ($__ping) {",
    "  $__pings = @(Test-Connection -ComputerName $__host -Count $__count -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ address = \"$($_.Address)\"; responseTimeMs = $_.ResponseTime; status = \"$($_.StatusCode)\" } })",
    "}",
    "$__r.pings = @($__pings)",
    "if ($__port -gt 0) {",
    "  $__tnc = Test-NetConnection -ComputerName $__host -Port $__port -WarningAction SilentlyContinue -ErrorAction Stop",
    "  $__r.tcp = @{ port = $__port; open = [bool]$__tnc.TcpTestSucceeded }",
    "}",
  ]);
}

export function registerAgentNetTest(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<NetTestArgs>(server, hub, audit, {
    name: "agent_net_test",
    title: "Test connectivity from a remote agent",
    description:
      "Run network diagnostics from the remote machine's point of view, not the server's: resolve the name (DNS), " +
      "ping it and, when 'port' is given, try a TCP connection to it. This is what tells you whether a backup " +
      "target, database or camera is reachable from that specific host. Returns the resolved addresses, the pings " +
      "and (with a port) whether the TCP handshake succeeded.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      host: z.string().min(1).describe("Host name or IP address to test from the remote machine."),
      port: z.number().int().min(1).max(65_535).optional().describe("TCP port to test (e.g. 445, 1433, 80)."),
      count: z.number().int().min(1).max(20).optional().describe("Ping attempts (default 4)."),
      dns: z.boolean().optional().describe("Resolve the name (default true)."),
      ping: z.boolean().optional().describe("Send ICMP pings (default true)."),
    },
    options: {
      op: "agent_net_test",
      jobType: "exec",
      validate: windowsOnly(hub),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        psExecParams(
          netTestScript({
            agent: args.agent,
            host: args.host,
            ...(args.port !== undefined ? { port: args.port } : {}),
            count: args.count ?? 4,
            dns: args.dns ?? true,
            ping: args.ping ?? true,
          }),
        ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome) => psEnvelopeData<NetTestData>(outcome.stdout),
    },
  });
}
