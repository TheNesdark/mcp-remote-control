# mcp-remote-control

Central MCP server that lets an LLM agent (opencode) control remote machines
(Windows first) through a WebSocket link. Each target machine runs a small
tray application (`rc-agent.exe`) that connects **outbound** to the server, so
no ports are opened on the Windows side.

Full design and roadmap: [`PLAN.md`](./PLAN.md).

## Status — F5 (packaging + LAN: exe, installer, MCP over HTTP, systemd)

- [x] `bun run build:exe` cross-compiles `dist/rc-agent.exe` (valid PE: MZ +
      PE signature, ~92 MB, no console window; icon/version metadata only when
      built on Windows — Bun limitation, documented)
- [x] `agent/assets/icon.ico` (16/32/48/256, generated in-repo, determinism test)
- [x] `agent/install.ps1`: user scope, no admin, DPAPI token, HKCU autostart,
      idempotent re-runs, uninstall + purge
- [x] Helpers resolved next to the exe first (`helper-scripts.ts`), then
      %APPDATA%, then the checkout
- [x] MCP over Streamable HTTP at `/mcp` (Bearer `<MRC_TOKEN>`, 401 otherwise):
      `--mcp-http-port` / `--no-mcp-stdio` flags for the systemd persistent server
- [x] `server/mcp-remote-control.service` + `server/env.example`; LAN deployment
      docs (`docs/OPERATIONS.md`): static IP, ufw firewall, remote opencode client
- [x] LAN-only posture (no Tailscale/VPN): plain `ws://` + `http://` on the
      trusted LAN; optional native TLS (`MRC_TLS_CERT/KEY`, agent
      `--tls-insecure`) now covers wss/https without a VPN
- [ ] Windows validation (VM): clean-machine install < 10 min, branded exe built
      on Windows, remote opencode against `:8788` — F1–F5 close-out
- [ ] `rc-agent.exe` code signing — F6 backlog

- [x] Per-agent enrollment tokens in SQLite (`server/src/store.ts`, `bun:sqlite`):
      `admin agent add/list/revoke/rotate`, token id pinned on first `hello`,
      only SHA-256 hashes stored, active names unique
- [x] Revocation enforced on new connections and on live sessions (dropped at
      the next heartbeat); strict mode `MRC_REQUIRE_DB_TOKENS=1` disables the
      shared dev token
- [x] Append-only JSONL audit trail (`server/data/audit.jsonl`, 10 MB rotation):
      every tool call (op, agent, sanitized params, outcome, duration, bytes),
      hub connection events, admin actions; secrets redacted, blobs truncated
- [x] Server-side limits: per-agent in-flight cap (`agent_busy`), per-minute
      rate limit (`rate_limited`, transfer chunks exempt), job timeout + cancel
- [x] Stable agent identity across server restarts (server-assigned id persisted
      to `agent.json`); restart resilience covered by test
- [x] Ops docs (`docs/OPERATIONS.md`); `bun run admin` CLI
- [x] Unit + integration tests (store/registry, audit, auth, limits, CLI, restart)
      + e2e with a concurrent phase across 2 agents

### F6 highlights (already delivered)

- [x] Windows real-host validation (first real machine): exec/info/ps/fs/screenshot
      over the tunnel; found+fixed AMSI-blocked screenshot (csc.exe fallback),
      single-session MCP HTTP (now one session per client), UNC-inherited cwd
      for cmd.exe spawns
- [x] F6 pulled forward: native TLS on both faces (`MRC_TLS_CERT/KEY`, agent
      `--tls-insecure`), OTA self-update (`agent_restart` + `updatePath` exe
      swap), GitHub Actions CI incl. a real `windows-latest` job, named
      Cloudflare tunnel script for stable URLs (`scripts/hermes-tunnel.sh`)
- [ ] Restart the real Windows agent on the new exe (share has v0.5.3) so the
      screenshot fallback goes live there
- [ ] Windows validation (VM): tray states/menu, DPAPI config + first-run,
      branded exe built on Windows — F1–F5 close-out
- [ ] `rc-agent.exe` code signing — F6 backlog

### Earlier phases (F0–F4)

- [x] Shared wire protocol (`shared/protocol.ts`, zod-validated)
- [x] WebSocket hub: `hello`/`welcome`, heartbeats, `presence`, jobs with
      timeout + cancel, liveness sweeper
- [x] MCP tools: `agents_list`, `agent_exec` (sync or `async=true`) + `agent_jobs`
      (status/list/cancel), `agent_fs` (list/read/write/hash/search/mkdir/move/
      copy/delete) + `agent_fs_transfer` (upload/download), `agent_info`,
      `agent_ps` (list/kill), `agent_screenshot`, Windows operations
      (`agent_services` with a control operation, `agent_eventlog`, `agent_net`
      ports/test), `agent_power`, `agent_message`, diagnostics
      (`agent_software`, `agent_time`, `agent_sessions`), `GET /health`.
      Auditing keeps per-operation names (`agent_ps_kill`, `agent_fs_delete`,
      `agent_exec_async`, ...).
- [x] Real agent (`agent/src`) with reconnect/backoff: exec with process-tree
      kill, fs jobs, inventory, process listing/killing, screenshots
- [x] Chunked file transfers (SHA-256 verified both ways) and screenshots
      pulled chunked from the agent temp file (image embedded in the tool
      result, or path only)
- [x] Agent tray app for Windows: colored state icon, enable/disable without
      disconnecting, reconnect now, open logs, start with Windows, exit
      (PowerShell + WinForms helper)
- [x] Agent settings: `agent.json` config, first-run dialog on Windows (asks for
      server IP + name; bare IPs accepted; also reachable from the tray
      **Settings...** menu), token encrypted with DPAPI, rotating file logs
      (`--log-file`). The `tray/*.ps1` helpers are embedded in the exe.
- [x] Linux process listing without procps (reads `/proc`), BSD/macOS via `ps`,
      Windows via PowerShell (`Get-Process`, two-sample CPU%)
- [x] Unit tests (`bun test`) + black-box e2e (`bun run e2e`), including a
      50 MB binary transfer with matching hash

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

# enroll a production agent (per-agent token) and check status
bun run admin -- agent add --name PC-01 --tags oficina
bun run admin -- server status
```

Using it from opencode: see [`docs/OPENCODE-MCP.md`](./docs/OPENCODE-MCP.md).

## Layout

```
shared/     wire protocol (server <-> agent), zod schemas, helpers (args,
            env, log, secret)
server/     MCP server (stdio + HTTP) + websocket hub (one Bun process):
            hub + job-limits, registry/store (SQLite tokens), audit,
            tools/* (one MCP tool per file, job-tool.ts helper), cli (admin)
agent/      agent sources: connection, jobs dispatch, exec/fs/ps (procfs
            readers)/sysinfo/screenshot handlers, settings + autostart +
            first-run, tray integration + tray/*.ps1 helpers (Windows)
scripts/    fake agent + e2e harness + test-utils (Linux, no Windows needed)
tests/      unit + integration tests mirroring the tree (agent/server/shared)
docs/       opencode integration, install + operations notes
```
