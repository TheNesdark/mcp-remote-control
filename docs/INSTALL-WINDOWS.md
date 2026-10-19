# Installing the agent on Windows

`rc-agent` is a small tray application that connects **outbound** to the central
server. No inbound ports are opened on the Windows machine; a firewall rule is
not needed for the agent to work.

The agent is the .NET 8 port in `agent-dotnet/` and ships as a single
self-contained `rc-agent.exe` (~154 MB) with everything inside: exec/fs/ps
handlers, the FlaUI/UIA3 computer-use engine, CDP browser control and screen
recording. There is no separate sidecar to compile on the target.

> **LAN-only deployment**: no Tailscale/VPN, plain `ws://` + `http://` on the
> trusted local network.

## Requirements

- Windows 10/11 (x64).
- Network reachability to the central server on the LAN
  (e.g. `ws://192.168.1.50:8787` — see `docs/OPERATIONS.md` for the server
  side: static IP, firewall, systemd).
- A per-agent token from the server operator:
  `bun run admin -- agent add --name PC-01` on the server host.
- For screen recordings as MP4: `ffmpeg.exe` on that machine (next to the agent
  or on `PATH`). Without it the engine writes a motion-JPEG `.avi` instead.

## Install (recommended: `INSTALAR-AGENTE.bat`)

The repo ships `scripts/INSTALAR-AGENTE.bat`, also dropped on the LAN share so
a machine can install itself from `\\<server>\Hermes`:

1. On the server, publish the exe from the repo (Linux cross-build works):

   ```sh
   cd agent-dotnet
   dotnet publish -c Release -r win-x64 --self-contained true \
     -p:PublishSingleFile=true -p:EnableWindowsTargeting=true -o ../dist
   ```

   Copy `dist/rc-agent.exe` to the share. Point `SRC` in the `.bat` at it.
2. On the Windows machine, run `INSTALAR-AGENTE.bat`. It:
   - stops any previous agent copy,
   - installs to `%LOCALAPPDATA%\mrc-remote-control\rc-agent.exe`,
   - launches it **from local** (not from the share, so the share stays
     writable) as `SERVER-<name>`,
   - waits 10 s and, if the process died, prints the tail of the log.

Set `SH`, `NAME`, `SERVER` and `TOKEN` at the top of the `.bat` for your LAN.

## Manual first run

1. Copy `rc-agent.exe` to the machine and run it. With no config and no
   `--name/--server/--token` flags, a **first-run dialog** asks for:
   - **Computer name** — how this machine appears in `agents_list`
     (prefilled with `%COMPUTERNAME%`).
   - **Server URL** — the central server's IP. A **bare IP is accepted**:
     `192.168.1.50` becomes `ws://192.168.1.50:8787`.
   - **Agent token** — only shown when one is not already available.
2. The name/server/token are stored in
   `%LOCALAPPDATA%\mrc-remote-control\settings.json`; the token is protected
   with **DPAPI** (current Windows user) before it is written.
3. A tray icon appears next to the clock (see below).

CLI flags and environment variables override the config file:
`--server`, `--token`, `--name`, `--tags a,b`, `--id ag_xxx`, `--paused`,
`--log-level debug|info|warn|error`, `--max-jobs N`, `--config <file>`,
`--log-file <file>`, `--tray` / `--no-tray`.

## Tray icon

The tray is a WinForms `NotifyIcon` built into the exe. States: green
**Connected** · yellow **Paused (disabled locally)** · gray **Connecting...** ·
red **Disconnected**. The tooltip shows the state and the server URL.

Menu:

- `Enable agent` / `Disable agent` — pauses the agent **without disconnecting**:
  the server keeps it online but refuses new jobs with
  `agent paused locally`.
- `Reconnect now` — drops the current socket and skips the reconnect backoff.
- `Open logs` — opens `%LOCALAPPDATA%\mrc-remote-control\logs`.
- `Start with Windows` — writes/deletes the `HKCU\...\CurrentVersion\Run` entry.
- `Exit` — stops the agent.

## Deployment options

| Option | Screenshots | Notes |
|---|---|---|
| **User logon (recommended)** — run once + `Start with Windows` | ✅ works | The agent must run in the interactive session, which screenshots require. |
| **Task Scheduler at logon** ("run only when user is logged on") | ✅ works | Same session requirement; useful for central deployment. |
| **Task Scheduler at startup** ("whether logged on or not") | ❌ | Everything except screenshots works; a locked/absent desktop makes `agent_screenshot` fail with `no interactive session`. |
| **Windows service** (session 0) | ❌ | Not supported in v1; screenshots are impossible. |

Screenshot failures are explicit: the agent detects session 0 /
`[Environment]::UserInteractive = false` and replies
`no interactive session: screenshot requires a logged-in desktop session`.

## Logs

- File: `%LOCALAPPDATA%\mrc-remote-control\logs\agent.log`. Level controlled
  with `--log-level`.
- The server logs to stderr (`MRC_LOG_LEVEL`); under opencode those logs show up
  in the MCP server output.

## Antivirus / EDR notes

- The agent only makes an **outbound** websocket connection and runs commands /
  file operations requested by the server operator.
- Unsigned binaries can be blocked: add an exclusion for `rc-agent.exe` or plan
  for code signing (backlog).

## Bonus: controlling the user's browser

`agent_cua_browser` drives the Chrome/Edge the user already runs, over the
DevTools Protocol of their real profile — no debug port on a throwaway profile.
Chrome 136+ only exposes it once the user turns **`chrome://inspect/#remote-debugging`
→ "Allow remote debugging"** on (this writes `DevToolsActivePort` into the
profile). The first time the agent attaches to a tab, the browser asks
"Allow debugging?" once; accept it and later commands are silent while the agent
process lives.
