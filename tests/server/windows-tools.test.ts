import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JobRequestMsg } from "@mrc/shared";
import { FakeAgent, type FakeResponse } from "../../scripts/fake-agent.ts";
import { testServerConfig } from "../../scripts/test-utils.ts";
import { createMcpHttpHandler } from "../../server/src/mcp-http.ts";
import { createService, type Service } from "../../server/src/service.ts";

const TOKEN = "test-token";
const WINDOWS_OS = "Windows_NT 10.0.19045";
const POSIX_OS = "Linux 6.1.0";

interface Harness {
  service: Service;
  agent: FakeAgent;
  client: Client;
  /** Every PowerShell script the helpers sent, in order. */
  commands: string[];
}

interface ToolCall {
  isError: boolean;
  data: any;
  text: string;
}

const SERVICE = { name: "Spooler", displayName: "Print Spooler", status: "Running", startType: "Automatic" };
const EVENT = { time: "2026-10-17T18:00:00.0000000Z", level: "Error", id: 7000, provider: "Service Control Manager", message: "boom" };
const CONNECTION = { protocol: "tcp", localAddress: "0.0.0.0", localPort: 3389, remoteAddress: "0.0.0.0", remotePort: 0, state: "Listen", pid: 1234, process: "svchost" };
const FILE_ENTRY = { fullName: "C:\\Logs\\old.log", name: "old.log", size: 2048, mtime: "2026-10-01T10:00:00.0000000Z" };

let harness: Harness | null = null;
let httpServer: Bun.Server<unknown> | null = null;

afterEach(async () => {
  if (harness) {
    try {
      await harness.client.close();
    } catch {
      // already closed
    }
    harness.agent.stop();
    harness.service.close();
    harness = null;
  }
  if (httpServer) {
    await httpServer.stop(true);
    httpServer = null;
  }
});

/** What a Windows agent would print: one JSON envelope, keyed by the script's marker. */
function defaultResponse(msg: JobRequestMsg, command: string): FakeResponse {
  if (msg.jobType === "fs.hash") return { meta: { sha256: "a".repeat(64), size: 4096 } };
  if (command.includes("Get-WinEvent")) return { stdout: json({ log: "System", count: 1, events: [EVENT] }) };
  if (command.includes("Get-NetTCPConnection")) return { stdout: json({ total: 1, connections: [CONNECTION] }) };
  if (command.includes("Win32_LogonSession")) {
    return {
      stdout: json({
        total: 1,
        sessions: [
          {
            user: "CONTOSO\\paciente",
            logonId: "123456",
            logonType: 2,
            logonTypeLabel: "interactive",
            count: 1,
            logonTime: "2026-10-17T08:30:00+02:00",
            authenticationPackage: "Kerberos",
          },
        ],
      }),
    };
  }
  if (command.includes("Get-TimeZone")) {
    return {
      stdout: json({
        local: "2026-10-17T12:00:01.000+02:00",
        utc: new Date(Date.now() + 1_500).toISOString(),
        timezone: "Romance Standard Time",
        ntp: { service: "Running", source: "time.contoso.local", lastSync: "2026/10/17 10:59:58" },
      }),
    };
  }
  if (command.includes("CurrentVersion\\Uninstall")) {
    return {
      stdout: json({
        total: 1,
        scope: "machine",
        programs: [
          {
            name: "Office 16",
            version: "16.0.14332",
            publisher: "Microsoft Corporation",
            installDate: "20260101",
            installLocation: "C:\\Program Files\\Microsoft Office",
            scope: "machine",
          },
        ],
      }),
    };
  }
  if (command.includes("Test-NetConnection")) {
    return {
      stdout: json({
        host: "srv-01",
        addresses: ["10.0.0.5"],
        pings: [{ address: "10.0.0.5", responseTimeMs: 3, status: "Success" }],
        tcp: { port: 445, open: true },
      }),
    };
  }
  if (command.includes("WaitForStatus")) {
    return { stdout: json({ ...SERVICE, action: "restart" }) };
  }
  if (command.includes("$__all = foreach")) return { stdout: json({ total: 3, matched: 1, services: [SERVICE] }) };
  if (command.includes("shutdown.exe")) return { stdout: json({ action: "restart", delaySeconds: 5, scheduled: true }) };
  if (command.includes("shown = $true")) {
    return { stdout: json({ shown: true, title: "Remote control", style: "warning", buttons: "ok" }) };
  }
  // Most specific marker first: the delete/search scripts also run Get-ChildItem.
  if (command.includes("Remove-Item")) return { stdout: json({ path: "C:\\tmp\\a.txt", type: "file", deleted: true }) };
  if (command.includes("Move-Item")) {
    return { stdout: json({ source: "C:\\a.txt", destination: "C:\\b.txt", type: "file", overwritten: false }) };
  }
  if (command.includes("Copy-Item")) {
    return { stdout: json({ source: "C:\\a.txt", destination: "C:\\b.txt", type: "file", overwritten: true }) };
  }
  if (command.includes("New-Item -ItemType Directory")) return { stdout: json({ path: "C:\\Logs", created: true }) };
  if (command.includes("Get-ChildItem")) {
    return { stdout: json({ path: "C:\\Logs", pattern: "*.log", matched: 2, returned: 1, truncated: true, entries: [FILE_ENTRY] }) };
  }
  return { stdout: json({}) };
}

function json(data: unknown): string {
  return `${JSON.stringify({ ok: true, data })}\n`;
}

async function startWindows(
  options: { os?: string; respond?: (msg: JobRequestMsg, command: string) => FakeResponse | undefined } = {},
): Promise<Harness> {
  const service = createService(testServerConfig(TOKEN));
  const commands: string[] = [];
  const agent = new FakeAgent({
    url: `ws://127.0.0.1:${service.port}`,
    token: TOKEN,
    name: "W-01",
    os: options.os ?? WINDOWS_OS,
    onLog: () => {},
    respond: (msg) => {
      const command = String((msg.params as { command?: string }).command ?? "");
      commands.push(command);
      return options.respond?.(msg, command) ?? defaultResponse(msg, command);
    },
  });
  await agent.start();

  const handler = createMcpHttpHandler(service.hub, {
    version: "test",
    screenshotDir: "/tmp/mrc-test-screenshots",
    audit: service.audit,
    bearerToken: TOKEN,
  });
  httpServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const client = new Client({ name: "windows-tools-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpServer.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  harness = { service, agent, client, commands };
  return harness;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolCall> {
  if (!harness) throw new Error("harness not started");
  const result = await harness.client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // plain-text transport error (HubError): keep `text` only
  }
  return { isError: result.isError === true, data, text };
}

test("the Windows helpers and job-history tools are registered", async () => {
  const started = await startWindows();
  const tools = (await started.client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "agent_services",
    "agent_eventlog",
    "agent_net",
    "agent_fs",
    "agent_fs_transfer",
    "agent_ps",
    "agent_power",
    "agent_message",
    "agent_exec",
    "agent_jobs",
    "agent_software",
    "agent_time",
    "agent_sessions",
  ]) {
    expect(tools).toContain(name);
  }
  // Consolidated tools replaced their one-shot predecessors.
  for (const gone of [
    "agent_exec_async",
    "agent_ps_list",
    "agent_ps_kill",
    "agent_net_ports",
    "agent_net_test",
    "agent_service_control",
    "agent_job_status",
    "agent_job_list",
    "agent_job_cancel",
    "agent_fs_read",
    "agent_fs_write",
    "agent_fs_list",
    "agent_fs_hash",
    "agent_fs_upload",
    "agent_fs_download",
    "agent_fs_search",
    "agent_fs_mkdir",
    "agent_fs_move",
    "agent_fs_copy",
    "agent_fs_delete",
  ]) {
    expect(tools).not.toContain(gone);
  }
});

test("agent_services returns the parsed service list", async () => {
  const started = await startWindows();
  const result = await call("agent_services", { agent: "W-01", filter: "spool", state: "running" });
  expect(result.isError).toBe(false);
  expect(result.data).toMatchObject({ total: 3, matched: 1 });
  expect(result.data.services[0]).toMatchObject({ name: "Spooler", startType: "Automatic" });

  const script = started.commands[0]!;
  expect(script).toContain("Get-Service");
  expect(script).toContain("System.Text.UTF8Encoding");
  expect(script).toContain("$__state = 'running'");
  expect(script).toContain("$__filter = 'spool'");
});

test("agent_services control reports the resulting state", async () => {
  const started = await startWindows();
  const result = await call("agent_services", { agent: "W-01", operation: "control", name: "Spooler", action: "restart", waitSeconds: 20 });
  expect(result.isError).toBe(false);
  expect(result.data).toMatchObject({ name: "Spooler", status: "Running", action: "restart" });
  expect(started.commands[0]).toContain("Restart-Service -Name $__name");
  expect(started.commands[0]).toContain("$__wait = 20");
});

test("agent_eventlog, agent_net ports and test reach the right cmdlets", async () => {
  const started = await startWindows();

  const events = await call("agent_eventlog", { agent: "W-01", level: "error", max: 5, hours: 48 });
  expect(events.data.events[0]).toMatchObject({ id: 7000, provider: "Service Control Manager" });
  expect(started.commands[0]).toContain("$__level = 2");
  expect(started.commands[0]).toContain("$__hours = 48");

  const ports = await call("agent_net", { agent: "W-01", operation: "ports", state: "established" });
  expect(ports.data.connections[0]).toMatchObject({ localPort: 3389, process: "svchost" });

  const net = await call("agent_net", { agent: "W-01", operation: "test", host: "srv-01", port: 445, count: 2 });
  expect(net.data).toMatchObject({ host: "srv-01", tcp: { port: 445, open: true } });
  expect(net.data.pings[0].responseTimeMs).toBe(3);
  expect(started.commands[2]).toContain("$__port = 445");
});

test("agent_power needs confirm=true and schedules the action", async () => {
  const started = await startWindows();

  const refused = await call("agent_power", { agent: "W-01", action: "restart" });
  expect(refused.isError).toBe(true);
  expect(refused.data.error).toContain("confirm=true");
  expect(started.commands.length).toBe(0); // never reached the agent

  const scheduled = await call("agent_power", { agent: "W-01", action: "restart", delaySeconds: 30, confirm: true, message: "maintenance" });
  expect(scheduled.isError).toBe(false);
  expect(scheduled.data).toMatchObject({ action: "restart", scheduled: true });
  const script = started.commands[0]!;
  expect(script).toContain("$__delay = 30");
  expect(script).toContain("'/r'");
  expect(script).toContain("'/t', \"$__delay\"");
  expect(script).toContain("$__msg = 'maintenance'");

  const locked = await call("agent_power", { agent: "W-01", action: "lock" });
  expect(locked.isError).toBe(false);
});

test("agent_message reports that the box was shown", async () => {
  const started = await startWindows();
  const result = await call("agent_message", { agent: "W-01", text: "Reboot in 5 minutes", title: "Ops", style: "warning" });
  expect(result.isError).toBe(false);
  expect(result.data).toMatchObject({ shown: true, style: "warning" });
  expect(started.commands[0]).toContain("-EncodedCommand");
});

test("the filesystem helpers map onto the right cmdlets", async () => {
  const started = await startWindows();

  const search = await call("agent_fs", { agent: "W-01", operation: "search", path: "C:\\Logs", pattern: "*.log", recursive: true, maxDepth: 2, olderThanDays: 7 });
  expect(search.data).toMatchObject({ matched: 2, returned: 1, truncated: true });
  expect(started.commands[0]).toContain("-Filter $__pattern -File -Force -Recurse -Depth $__depth");

  const mkdir = await call("agent_fs", { agent: "W-01", operation: "mkdir", path: "C:\\Logs\\2026" });
  expect(mkdir.data).toMatchObject({ created: true });

  const move = await call("agent_fs", { agent: "W-01", operation: "move", source: "C:\\a.txt", destination: "C:\\b.txt" });
  expect(move.data).toMatchObject({ destination: "C:\\b.txt", type: "file" });
  expect(started.commands[2]).toContain("Move-Item -LiteralPath $__source");

  const copy = await call("agent_fs", { agent: "W-01", operation: "copy", source: "C:\\a.txt", destination: "C:\\b.txt", overwrite: true });
  expect(copy.data).toMatchObject({ overwritten: true });
  expect(started.commands[3]).toContain("Copy-Item -LiteralPath $__source -Destination $__destination -Recurse -Force");

  const removed = await call("agent_fs", { agent: "W-01", operation: "delete", path: "C:\\tmp\\a.txt", confirm: true });
  expect(removed.data).toMatchObject({ deleted: true, type: "file" });
});

test("agent_fs delete requires confirm and never targets a drive root", async () => {
  const started = await startWindows();

  const noConfirm = await call("agent_fs", { agent: "W-01", operation: "delete", path: "C:\\tmp\\a.txt" });
  expect(noConfirm.isError).toBe(true);
  expect(noConfirm.data.error).toContain("confirm=true");

  const driveRoot = await call("agent_fs", { agent: "W-01", operation: "delete", path: "C:\\", confirm: true });
  expect(driveRoot.isError).toBe(true);
  expect(driveRoot.data.error).toContain("drive root");
  expect(started.commands.length).toBe(0);
});

test("agent_fs hash reads the hash out of the job metadata", async () => {
  await startWindows();
  const result = await call("agent_fs", { agent: "W-01", operation: "hash", path: "C:\\temp\\rc-agent.exe" });
  expect(result.isError).toBe(false);
  expect(result.data).toEqual({ ok: true, path: "C:\\temp\\rc-agent.exe", sha256: "a".repeat(64), size: 4096 });
});

test("a script failure comes back as an error with the PowerShell message", async () => {
  await startWindows({
    respond: () => ({
      stdout: '{"ok":false,"error":"Cannot find any service with service name \'nope\'."}\n',
      exitCode: 1,
    }),
  });
  const result = await call("agent_services", { agent: "W-01", operation: "control", name: "nope", action: "start" });
  expect(result.isError).toBe(true);
  expect(result.data).toEqual({ ok: false, error: "Cannot find any service with service name 'nope'." });
});

test("Windows-only tools refuse a POSIX agent", async () => {
  const started = await startWindows({ os: POSIX_OS });
  const result = await call("agent_services", { agent: "W-01" });
  expect(result.isError).toBe(true);
  expect(result.data.error).toContain("needs Windows");
  expect(started.commands.length).toBe(0);
});

test("agent_exec async, agent_jobs status/list/cancel work over MCP", async () => {
  const started = await startWindows({
    respond: (msg) => {
      if (msg.jobType !== "exec") return undefined;
      return { stdout: "working...\n", sleepMs: 250 };
    },
  });

  const started_ = await call("agent_exec", { agent: "W-01", command: "backup.cmd", async: true });
  expect(started_.isError).toBe(false);
  const jobId = started_.data.jobId as string;
  expect(started_.data.state).toBe("running");
  expect(jobId.length).toBeGreaterThan(0);

  const running = await call("agent_jobs", { operation: "status", jobId });
  expect(["running", "ok"]).toContain(running.data.state);

  const listed = await call("agent_jobs", { operation: "list", agent: "W-01" });
  expect(listed.data.jobs.some((job: { jobId: string }) => job.jobId === jobId)).toBe(true);

  const cancelled = await call("agent_jobs", { operation: "cancel", jobId });
  expect(cancelled.isError).toBe(false);
  expect(cancelled.data.cancelRequested === true || cancelled.data.status.state === "ok").toBe(true);

  const unknown = await call("agent_jobs", { operation: "status", jobId: "does-not-exist" });
  expect(unknown.isError).toBe(true);
  expect(unknown.data.error).toContain("unknown_job");

  expect(started.commands[0]).toBe("backup.cmd");
});

test("agent_software returns the parsed inventory", async () => {
  const started = await startWindows();
  const result = await call("agent_software", { agent: "W-01", filter: "office", scope: "all" });
  expect(result.isError).toBe(false);
  expect(result.data).toMatchObject({ total: 1 });
  expect(result.data.programs[0]).toMatchObject({ name: "Office 16", version: "16.0.14332" });

  const script = started.commands[0]!;
  expect(script).toContain("CurrentVersion\\Uninstall");
  expect(script).toContain("$__scope = 'all'");
  expect(script).toContain("$__filter = 'office'");
});

test("agent_time reports the clock and the measured offset against the server", async () => {
  const started = await startWindows();
  const before = Date.now();
  const result = await call("agent_time", { agent: "W-01" });
  expect(result.isError).toBe(false);
  expect(result.data.timezone).toBe("Romance Standard Time");
  expect(result.data.ntp).toMatchObject({ service: "Running", source: "time.contoso.local" });
  // The fake agent's clock is 1.5 s ahead: the offset must come out close to it.
  expect(result.data.offsetFromServerMs).toBeGreaterThan(500);
  expect(result.data.offsetFromServerMs).toBeLessThan(Date.now() - before + 5_000);
  expect(started.commands[0]).toContain("Get-TimeZone");
});

test("agent_sessions lists interactive logons and honours interactiveOnly", async () => {
  const started = await startWindows();
  const result = await call("agent_sessions", { agent: "W-01" });
  expect(result.isError).toBe(false);
  expect(result.data.total).toBe(1);
  expect(result.data.sessions[0]).toMatchObject({ user: "CONTOSO\\paciente", logonTypeLabel: "interactive" });
  expect(started.commands[0]).toContain("LogonType=2 OR LogonType=10");

  const all = await call("agent_sessions", { agent: "W-01", interactiveOnly: false });
  expect(all.isError).toBe(false);
  expect(started.commands[1]).toContain("$__interactiveOnly = $false");
});

test("consolidated tools validate their operation arguments", async () => {
  const started = await startWindows();

  const svc = await call("agent_services", { agent: "W-01", operation: "control" });
  expect(svc.isError).toBe(true);
  expect(svc.data.error).toContain("'name' is required");

  const net = await call("agent_net", { agent: "W-01", operation: "test" });
  expect(net.isError).toBe(true);
  expect(net.data.error).toContain("'host' is required");

  const ps = await call("agent_ps", { agent: "W-01", operation: "kill" });
  expect(ps.isError).toBe(true);
  expect(ps.data.error).toContain("exactly one of 'pid' or 'name'");

  const fs = await call("agent_fs", { agent: "W-01", operation: "list" });
  expect(fs.isError).toBe(true);
  expect(fs.data.error).toContain("'path' is required");

  const transfer = await call("agent_fs_transfer", { agent: "W-01", operation: "download", localPath: "C:\\x" });
  expect(transfer.isError).toBe(true);
  expect(transfer.text || JSON.stringify(transfer.data)).toContain("remotePath");

  const slowTimeout = await call("agent_exec", { agent: "W-01", command: "x", timeoutMs: 12 * 3_600_000 });
  expect(slowTimeout.isError).toBe(true);
  expect(slowTimeout.data.error).toContain("sync");

  expect(started.commands.length).toBe(0);
});

test("the diagnostics tools refuse a POSIX agent", async () => {
  const started = await startWindows({ os: POSIX_OS });
  for (const name of ["agent_software", "agent_time", "agent_sessions"]) {
    const result = await call(name, { agent: "W-01" });
    expect(result.isError).toBe(true);
    expect(started.commands.length).toBe(0);
  }
});
