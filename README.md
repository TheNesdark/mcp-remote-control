# mcp-remote-control

Central MCP server that lets an LLM agent (opencode) control remote machines
(Windows first) through a WebSocket link. Each target machine runs a small
tray application (`rc-agent.exe`) that connects **outbound** to the server, so
no ports are opened on the Windows side.

Full design and roadmap: [`PLAN.md`](./PLAN.md).

## Status — F3 (inventory, processes, screenshots, tray)

- [x] Shared wire protocol (`shared/protocol.ts`, zod-validated)
- [x] WebSocket hub: `hello`/`welcome`, heartbeats, `presence`, jobs with
      timeout + cancel, liveness sweeper
- [x] MCP tools: `agents_list`, `agent_exec`, `agent_fs_*` (list/read/write/
      upload/download), `agent_info`, `agent_ps_list`, `agent_ps_kill`,
      `agent_screenshot`
- [x] Real agent (`agent/src`) with reconnect/backoff: exec with process-tree
      kill, fs jobs, inventory, process listing/killing, screenshots
- [x] Chunked file transfers (SHA-256 verified both ways) and screenshots
      pulled chunked from the agent temp file (image embedded in the tool
      result, or path only)
- [x] Agent tray app for Windows: colored state icon, enable/disable without
      disconnecting, reconnect now, open logs, start with Windows, exit
      (PowerShell + WinForms helper)
- [x] Agent settings: `agent.json` config, first-run dialog on Windows, token
      encrypted with DPAPI, rotating file logs (`--log-file`)
- [x] Linux process listing without procps (reads `/proc`), BSD/macOS via `ps`,
      Windows via PowerShell (`Get-Process`, two-sample CPU%)
- [x] Unit tests (`bun test`) + black-box e2e (`bun run e2e`), including a
      50 MB binary transfer with matching hash
- [ ] Windows validation (VM): tray states/menu, DPAPI config + first-run,
      `cmd.exe`/`powershell.exe` shells, `taskkill /T /F`, `C:\` paths,
      screenshot with an interactive session and the session-0 error — F1–F3
      close-out
- [ ] `rc-agent.exe` packaging + installer (`install.ps1`) — F5

## Quickstart (dev)

Requires [Bun](https://bun.sh) ≥ 1.4.

```sh
bun install

# terminal 1: server (MCP over stdio + websocket hub on :8787)
MRC_TOKEN=dev-token bun run server

# terminal 2: the real agent (runs on Linux for development)
bun run agent -- --server ws://127.0.0.1:8787 --token dev-token --name PC-01
# stdin commands: pause | resume | quit

# tests
bun test        # unit + integration tests
bun run e2e     # MCP client <-> real server <-> fake + real agents
bun run typecheck
```

Using it from opencode: see [`docs/OPENCODE-MCP.md`](./docs/OPENCODE-MCP.md).

## Layout

```
shared/     wire protocol (server <-> agent), zod schemas, helpers
server/     MCP stdio server + websocket hub (one Bun process)
agent/      agent sources (exec engine, connection) + tray helper (Windows)
scripts/    fake agent + e2e harness (Linux, no Windows needed)
docs/       opencode integration, install notes
```
