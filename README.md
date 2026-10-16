# mcp-remote-control

Central MCP server that lets an LLM agent (opencode) control remote machines
(Windows first) through a WebSocket link. Each target machine runs a small
tray application (`rc-agent.exe`) that connects **outbound** to the server, so
no ports are opened on the Windows side.

Full design and roadmap: [`PLAN.md`](./PLAN.md).

## Status — F0 (skeleton)

- [x] Shared wire protocol (`shared/protocol.ts`, zod-validated)
- [x] WebSocket hub: `hello`/`welcome`, heartbeats, `presence`, jobs with
      timeout + cancel, liveness sweeper
- [x] MCP server over stdio with the `agents_list` tool
- [x] Fake agent for development/CI on Linux
- [x] Unit tests (`bun test`) + black-box e2e (`bun run e2e`)
- [x] Tray spike scripts for Windows (`agent/tray/`, to validate on a VM)
- [ ] Real Windows agent binary (`rc-agent.exe`) — F1+

## Quickstart (dev)

Requires [Bun](https://bun.sh) ≥ 1.4.

```sh
bun install

# terminal 1: server (MCP over stdio + websocket hub on :8787)
MRC_TOKEN=dev-token bun run server

# terminal 2: fake agent
bun run agent:fake -- --server ws://127.0.0.1:8787 --token dev-token --name FAKE-01
# stdin commands: pause | resume | quit

# tests
bun test        # unit + protocol tests
bun run e2e     # MCP client <-> real server process <-> fake agents
bun run typecheck
```

Using it from opencode: see [`docs/OPENCODE-MCP.md`](./docs/OPENCODE-MCP.md).

## Layout

```
shared/     wire protocol (server <-> agent), zod schemas, helpers
server/     MCP stdio server + websocket hub (one Bun process)
agent/      rc-agent.exe sources + tray helper (Windows) — F1+
scripts/    fake agent + e2e harness (Linux, no Windows needed)
docs/       opencode integration, install notes
```
