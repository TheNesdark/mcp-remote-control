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
    "$__udp = @()",
    "$__hasCmdlets = [bool](Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)",
    "if ($__hasCmdlets) {",
    "  if ($__protocol -ne 'udp') { $__tcp = @(Get-NetTCPConnection -ErrorAction Stop) }",
    "  if ($__protocol -ne 'tcp') { $__udp = @(Get-NetUDPEndpoint -ErrorAction Stop) }",
    "}",
    "$__tcpItems = foreach ($__c in $__tcp) {",
    "  $__st = $__c.State.ToString()",
    "  $__keep = $true",
    "  if ($__state -eq 'listen' -and $__st -ne 'Listen') { $__keep = $false }",
    "  if ($__state -eq 'established' -and $__st -ne 'Established') { $__keep = $false }",
    "  if ($__keep) {",
    "    $__pid = [int]$__c.OwningProcess",
    "    @{ protocol = 'tcp'; localAddress = \"$($__c.LocalAddress)\"; localPort = [int]$__c.LocalPort; remoteAddress = \"$($__c.RemoteAddress)\"; remotePort = [int]$__c.RemotePort; state = $__st; pid = $__pid; process = \"$($__names[$__pid])\" }",
    "  }",
    "}",
    "$__udpItems = foreach ($__e in $__udp) {",
    "  $__pid = [int]$__e.OwningProcess",
    "  @{ protocol = 'udp'; localAddress = \"$($__e.LocalAddress)\"; localPort = [int]$__e.LocalPort; remoteAddress = $null; remotePort = $null; state = ''; pid = $__pid; process = \"$($__names[$__pid])\" }",
    "}",
    "if (-not $__hasCmdlets) {",
    // Windows 7 / PowerShell 2.0: no Get-NetTCPConnection; parse netstat -ano.
    "  $__tcpItems = @()",
    "  $__udpItems = @()",
    "  foreach ($__line in @(netstat -ano | Select-String -Pattern '^\\s+(TCP|UDP)\\s')) {",
    "    $__cols = @($__line.ToString().Trim() -split '\\s+')",
    "    $__proto = $__cols[0].ToLower()",
    "    $__lp = $__cols[1]",
    "    $__ix = $__lp.LastIndexOf(':')",
    "    if ($__ix -lt 1) { continue }",
    "    $__laddr = $__lp.Substring(0, $__ix)",
    "    if ($__laddr.StartsWith('[') -and $__laddr.EndsWith(']')) { $__laddr = $__laddr.Substring(1, $__laddr.Length - 2) }",
    "    $__lport = 0",
    "    try { $__lport = [int]$__lp.Substring($__ix + 1) } catch { continue }",
    "    if ($__proto -eq 'tcp' -and $__cols.Count -ge 5) {",
    "      if ($__protocol -eq 'udp') { continue }",
    "      $__raw = $__cols[3].ToUpper()",
    "      $__st8 = $__cols[3]",
    "      if ($__raw.Contains('LISTEN') -or $__raw.StartsWith('ESCUCH')) { $__st8 = 'Listen' }",
    "      elseif ($__raw.Contains('ESTABL')) { $__st8 = 'Established' }",
    "      $__keep = $true",
    "      if ($__state -eq 'listen' -and $__st8 -ne 'Listen') { $__keep = $false }",
    "      if ($__state -eq 'established' -and $__st8 -ne 'Established') { $__keep = $false }",
    "      if ($__keep) {",
    "        $__pid = 0; try { $__pid = [int]$__cols[4] } catch {}",
    "        $__tcpItems += ,@{ protocol = 'tcp'; localAddress = \"$__laddr\"; localPort = $__lport; remoteAddress = \"$($__cols[2])\"; remotePort = $null; state = $__st8; pid = $__pid; process = \"$($__names[$__pid])\" }",
    "      }",
    "    }",
    "    if ($__proto -eq 'udp') {",
    "      if ($__protocol -eq 'tcp') { continue }",
    "      $__pid = 0; try { $__pid = [int]$__cols[3] } catch {}",
    "      $__udpItems += ,@{ protocol = 'udp'; localAddress = \"$__laddr\"; localPort = $__lport; remoteAddress = $null; remotePort = $null; state = ''; pid = $__pid; process = \"$($__names[$__pid])\" }",
    "    }",
    "  }",
    "}",
    "$__items = @($__tcpItems) + @($__udpItems)",
    "if ($__filter) { $__items = @($__items | Where-Object { $_.process.ToLower().Contains($__filter) -or $_.localAddress.ToLower().Contains($__filter) -or (\"$($_.localPort)\").Contains($__filter) }) }",
    "$__items = @($__items | Sort-Object { $_['localPort'] })",
    "$__r = @{ total = @($__items).Count; connections = @($__items | Select-Object -First $__top) }",
  ]);
}

export function registerAgentNet(server: McpServer, hub: Hub, audit: AuditLog | null = null): void {
  registerJobTool<NetArgs>(server, hub, audit, {
    name: "agent_net",
    title: "Inspect ports or test connectivity from a remote agent",
    description:
      "Network diagnostics on a remote machine (Windows). operation='ports' lists TCP/UDP endpoints together with " +
      "the pid and process name that owns each one (via Get-NetTCPConnection / Get-NetUDPEndpoint, so it needs " +
      "Windows 8 / Server 2012 or newer); by default only TCP listeners — use state='established' or 'all' for " +
      "active connections, and 'filter' (case-insensitive) on process name, local address or local port. Handy to " +
      "find what is using a port. operation='test' runs reachability checks from the remote machine's point of " +
      "view, not the server's: resolve the name (DNS), ping it and, when 'port' is given, try a TCP connection — " +
      "this tells you whether a backup target, database or camera is reachable from that specific host.",
    inputSchema: {
      agent: z.string().min(1).describe("Agent id or unique name from agents_list."),
      operation: z.enum(["ports", "test"]).describe("ports = socket inventory; test = DNS/ping/TCP reachability."),
      protocol: z.enum(["tcp", "udp", "all"]).optional().describe("(ports) Transport to inspect (default tcp)."),
      state: z.enum(["listen", "established", "all"]).optional().describe("(ports) TCP state to keep (default listen)."),
      filter: z
        .string()
        .optional()
        .describe("(ports) Case-insensitive substring on process name, local address or local port."),
      top: z.number().int().positive().max(2_000).optional().describe("(ports) Return at most this many entries (default 200)."),
      host: z.string().min(1).optional().describe("(test) Host name or IP address to test from the remote machine."),
      port: z.number().int().min(1).max(65_535).optional().describe("(test) TCP port to test (e.g. 445, 1433, 80)."),
      count: z.number().int().min(1).max(20).optional().describe("(test) Ping attempts (default 4)."),
      dns: z.boolean().optional().describe("(test) Resolve the name (default true)."),
      ping: z.boolean().optional().describe("(test) Send ICMP pings (default true)."),
    },
    options: {
      op: (args) => (args.operation === "test" ? "agent_net_test" : "agent_net_ports"),
      jobType: "exec",
      validate: (args) =>
        windowsOnly(hub)(args) ?? (args.operation === "test" && args.host === undefined ? "operation 'test': 'host' is required" : null),
      timeoutMs: () => PS_DEFAULT_TIMEOUT_MS,
      buildParams: (args) =>
        args.operation === "test"
          ? psExecParams(
              netTestScript({
                agent: args.agent,
                host: args.host!,
                ...(args.port !== undefined ? { port: args.port } : {}),
                count: args.count ?? 4,
                dns: args.dns ?? true,
                ping: args.ping ?? true,
              }),
            )
          : psExecParams(
              netPortsScript({
                agent: args.agent,
                protocol: args.protocol ?? "tcp",
                state: args.state ?? "listen",
                ...(args.filter !== undefined ? { filter: args.filter } : {}),
                top: args.top ?? 200,
              }),
            ),
      buildFailure: (outcome) => psFailure(outcome),
      buildResult: (outcome, args) =>
        args.operation === "test"
          ? psEnvelopeData<NetTestData>(outcome.stdout)
          : psEnvelopeData<NetPortsData>(outcome.stdout),
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
    "  try { $__addresses = @([System.Net.Dns]::GetHostAddresses($__host) | ForEach-Object { $_.IPAddressToString }) } catch { $__addresses = @() }",
    "}",
    "$__r.addresses = @($__addresses)",
    "$__pings = @()",
    "if ($__ping) {",
    "  $__pings = @(Test-Connection -ComputerName $__host -Count $__count -ErrorAction SilentlyContinue | ForEach-Object { @{ address = \"$($_.Address)\"; responseTimeMs = $_.ResponseTime; status = \"$($_.StatusCode)\" } })",
    "}",
    "$__r.pings = @($__pings)",
    "if ($__port -gt 0) {",
    // Test-NetConnection needs PowerShell 3+: raw TcpClient instead (PS 2.0).
    "  $__open = $false",
    "  try {",
    "    $__client = New-Object System.Net.Sockets.TcpClient",
    "    $__iar = $__client.BeginConnect($__host, $__port, $null, $null)",
    "    if ($__iar.AsyncWaitHandle.WaitOne(5000, $false)) { $__client.EndConnect($__iar); $__open = $true }",
    "    $__client.Close()",
    "  } catch { $__open = $false }",
    "  $__r.tcp = @{ port = $__port; open = $__open }",
    "}",
  ]);
}

type NetArgs = { agent: string; operation: "ports" | "test" } & Partial<Omit<NetPortsArgs, "agent">> & Partial<
    Omit<NetTestArgs, "agent">
  >;
