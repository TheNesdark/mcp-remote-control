# Installing the agent on Windows

`rc-agent` is a small tray application that connects **outbound** to the central
server. No inbound ports are opened on the Windows machine; a firewall rule is
not needed for the agent to work.

> **Status**: F3. The `.exe` packaging + one-shot installer (`install.ps1`) land
> in F5. Until then this document describes the manual deployment: run the agent
> from source (`bun run agent`) or from a compiled `rc-agent.exe`
> (`bun build --compile --target=bun-windows-x64`, see `PLAN.md` §2.2).

## Requirements

- Windows 10/11 (x64). PowerShell 5.1 is used by the tray/first-run helpers and
  by `agent_ps_*`/`agent_screenshot`; it ships with Windows.
- Network reachability to the central server (LAN or Tailscale/WireGuard).
- An agent token from the server operator (`MRC_TOKEN` on the server side in
  the current single-token mode; per-agent tokens arrive in F4).

## First run

1. Copy `rc-agent.exe` (or the repo for `bun run agent`) to the machine.
2. Run it. On Windows, if there is no config yet and no `--name/--server/--token`
   flags were given, a **first-run dialog** asks for:
   - **Computer name** — how this machine appears in `agents_list`
     (prefilled with `%COMPUTERNAME%`, pattern `^[A-Za-z0-9._-]{1,32}$`).
   - **Server URL** — e.g. `ws://100.x.y.z:8787` (Tailscale) or `ws://10.0.0.5:8787`.
   - **Agent token**.
3. The name/server/token are stored in
   `%APPDATA%\mcp-remote-control\agent.json`; the token is **encrypted with
   DPAPI** (current Windows user) before it is written.
4. A tray icon appears next to the clock (see below).

CLI flags and environment variables override the config file:
`--server`, `--token`, `--name`, `--tags a,b`, `--id ag_xxx`, `--paused`,
`--log-level debug|info|warn|error`, `--max-jobs N`, `--config <file>`,
`--log-file <file>`, `--tray` / `--no-tray`.

## Tray icon

The tray helper is a PowerShell + WinForms `NotifyIcon` (`agent/tray/tray.ps1`)
that the agent starts and drives over JSON lines on stdin/stdout.

States: green **Connected** · yellow **Paused (disabled locally)** · gray
**Connecting...** · red **Disconnected**. The tooltip shows the state and the
server URL.

Menu:

- `Enable agent` / `Disable agent` — pauses the agent **without disconnecting**:
  the server keeps the agent online but refuses new jobs with
  `agent paused locally`.
- `Reconnect now` — drops the current socket and skips the reconnect backoff.
- `Open logs` — opens `%APPDATA%\mcp-remote-control\logs`.
- `Start with Windows` — writes/deletes the `HKCU\...\CurrentVersion\Run`
  entry pointing at `rc-agent.exe` (only available in the compiled exe).
- `Exit` — stops the agent.

Double-clicking the icon toggles enable/disable. A second tray instance exits
with `already_running` (the agent itself can still run without a tray).

## Deployment options

| Option | Screenshots | Notes |
|---|---|---|
| **User logon (recommended)** — run once + `Start with Windows` | ✅ works | The agent runs in the interactive session, which screenshots require. |
| **Task Scheduler at logon** ("run only when user is logged on") | ✅ works | Same session requirement; useful for central deployment. |
| **Task Scheduler at startup** ("whether logged on or not") | ❌ | Everything except screenshots works; a locked/absent desktop makes `agent_screenshot` fail with `no interactive session`. |
| **Windows service** (session 0) | ❌ | Not supported in v1 (F6 backlog); screenshots are impossible. |

Screenshot failures are explicit: the agent detects session 0 /
`[Environment]::UserInteractive = false` and replies
`no interactive session: screenshot requires a logged-in desktop session`.

## Logs

- File: `%APPDATA%\mcp-remote-control\logs\agent.log` (rotates at 5 MB,
  keeping one `agent.log.1`). Level controlled with `--log-level`.
- The server logs to stderr (`MRC_LOG_LEVEL`); when run under opencode, those
  logs show up in the MCP server output.

## Antivirus / EDR notes

- The agent only makes an **outbound** websocket connection and runs commands /
  file operations requested by the server operator.
- The tray helper is a minimal `NotifyIcon` script (no `-EncodedCommand`, no
  obfuscation). If your EDR distrusts PowerShell, the fallback is a tiny C#
  `tray.exe` compiled with the `csc.exe` that ships with Windows (backlog).
- Unsigned binaries can be blocked: add an exclusion for `rc-agent.exe` or plan
  for code signing (backlog).

## Verifying on a fresh VM (checklist)

1. No config file present → run the exe → dialog asks for name/server/token;
   cancel exits cleanly (`Cancelled`) and Save writes `agent.json`.
2. `agents_list` from opencode shows the machine as **online** (not paused).
3. Tray: icon appears; tooltip `NAME - Connected - ws://...`; menu open/disable
   works; `Disable agent` flips the tooltip to *Paused* and
   `agents_list` shows `paused: true`; `Enable agent` reverses it.
4. `agent_screenshot` returns a correct primary-monitor image; with the agent
   started in session 0 it must fail with the clear `no interactive session`
   error instead.
5. `agent_ps_list` shows processes with user/CPU/memory; `agent_ps_kill`
   terminates a test process (try `notepad.exe`).
6. `Open logs` opens the log folder and `agent.log` has recent entries.
7. `Start with Windows` survives a logoff/logon cycle and `Exit` stops the
   agent (icon disappears immediately).
