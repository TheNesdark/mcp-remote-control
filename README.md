# mcp-remote-control

Central MCP server that lets an LLM agent (opencode) control remote machines
(Windows first) through a WebSocket link. Each target machine runs a small
tray application (`rc-agent.exe`) that connects **outbound** to the server, so
no ports are opened on the Windows side.

Full design and roadmap: [`PLAN.md`](./PLAN.md).

## Status — F1 (exec)

- [x] Shared wire protocol (`shared/protocol.ts`, zod-validated)
- [x] WebSocket hub: `hello`/`welcome`, heartbeats, `presence`, jobs with
      timeout + cancel, liveness sweeper
- [x] MCP tools: `agents_list`, `agent_exec`
- [x] Real agent (`agent/src`) with reconnect/backoff: executes commands,
      streams stdout/stderr, kills the process tree on timeout/cancel
- [x] Fake agent for development/CI on Linux
- [x] Unit tests (`bun test`) + black-box e2e (`bun run e2e`)
- [x] Tray spike scripts for Windows (`agent/tray/`, to validate on a VM)
- [ ] Windows validation of the agent: `cmd.exe`/`powershell.exe` shells and
      `taskkill /T /F` kill path (VM) — F1 close-out
- [ ] `rc-agent.exe` packaging (tray + file config + DPAPI token) — F3

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
