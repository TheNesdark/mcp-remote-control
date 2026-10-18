# Installing the agent on Windows

`rc-agent` is a small tray application that connects **outbound** to the central
server. No inbound ports are opened on the Windows machine; a firewall rule is
not needed for the agent to work.

> **Status**: F5. One-shot installer (`agent/install.ps1`) + cross-compiled
> `rc-agent.exe` (`bun run build:exe`). LAN-only deployment: no Tailscale/VPN,
> plain `ws://` + `http://` on the trusted local network.

## Requirements

- Windows 10/11 (x64). PowerShell 5.1 is used by the tray/first-run helpers and
  by `agent_ps`/`agent_screenshot`; it ships with Windows.
- Network reachability to the central server on the LAN
  (e.g. `ws://192.168.1.50:8787` — see `docs/OPERATIONS.md` for the server
  side: static IP, firewall, systemd).
- A per-agent token from the server operator:
  `bun run admin -- agent add --name PC-01` on the server host.

## One-shot install (recommended)

Copy `rc-agent.exe`, `install.ps1` and `tray/*.ps1` to the machine (USB,
network share — whatever your LAN allows), then from an **unelevated**
PowerShell:

```powershell
.\install.ps1 -Server ws://192.168.1.50:8787 -Token mrc_xxxx -Name OFICINA-01
```

This installs to `%LOCALAPPDATA%\mcp-remote-control` (no admin needed),
writes `%APPDATA%\mcp-remote-control\agent.json` (token encrypted with DPAPI,
current user), registers Start with Windows (`HKCU\...\Run`) and starts the
agent — look for the tray icon next to the clock. Re-running updates files
and config (existing values are kept unless overridden).

Useful switches: `-InstallDir`, `-NoAutostart`, `-NoStart`,
`-Uninstall` (removes exe/autostart/process, keeps config),
`-Uninstall -Purge` (also removes `agent.json`).

## Manual first run (no installer)

1. Copy `rc-agent.exe` (or the repo for `bun run agent`) to the machine. The
   `.ps1` helpers are **embedded in the exe**, so no side files are needed.
2. Run it. On Windows, if there is no config yet and no `--name/--server/--token`
   flags were given, a **first-run dialog** asks for:
   - **Computer name** — how this machine appears in `agents_list`
     (prefilled with `%COMPUTERNAME%`, pattern `^[A-Za-z0-9._-]{1,32}$`).
   - **Server URL** — the central server's IP. A **bare IP is accepted**:
     `192.168.1.50` becomes `ws://192.168.1.50:8787`.
   - **Agent token** — only shown when one is not already available (baked into
     the exe or present in `agent.json`).
3. The name/server/token are stored in
   `%APPDATA%\mcp-remote-control\agent.json`; the token is **encrypted with
   DPAPI** (current Windows user) before it is written.
4. A tray icon appears next to the clock (see below). Choose **Settings...** to
   reopen the same dialog at any time.

> Building a fleet? `bun run build:exe --server ws://<host>:8787` bakes the
> server URL as the dialog's prefill (still editable). Omit it to ship a fully
> generic exe that asks for the server on every machine.

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

## Verifying on a fresh machine (checklist, < 10 min)

1. Copy `rc-agent.exe` + `install.ps1` + `tray/*.ps1`; run
   `.\install.ps1 -Server ws://<lan-ip>:8787 -Token <token> -Name TEST-01`.
2. Tray icon appears within seconds; tooltip `TEST-01 - Connected - ws://...`.
   `agents_list` from opencode shows the machine as **online** (not paused).
3. Tray: icon appears; tooltip `NAME - Connected - ws://...`; menu open/disable
   works; `Disable agent` flips the tooltip to *Paused* and
   `agents_list` shows `paused: true`; `Enable agent` reverses it.
4. `agent_screenshot` returns a correct primary-monitor image; with the agent
   started in session 0 it must fail with the clear `no interactive session`
   error instead.
5. `agent_ps` (list) shows processes with user/CPU/memory; `agent_ps` (kill)
   terminates a test process (try `notepad.exe`).
6. `Open logs` opens the log folder and `agent.log` has recent entries.
7. `Start with Windows` survives a logoff/logon cycle and `Exit` stops the
   agent (icon disappears immediately).
