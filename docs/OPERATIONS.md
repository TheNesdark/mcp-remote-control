# Server operations (F4–F5)

How to enroll agents, manage tokens, read the audit trail, run the server
persistently on the LAN, and understand the safety limits.

How to enroll agents, manage tokens, read the audit trail, and understand
the server's safety limits. All admin commands work whether the server is
running or not — they operate directly on the SQLite registry
(`server/data/mcp.db` by default).

## Enrolling an agent

```sh
bun run admin -- agent add --name PC-01 --tags oficina
# enrolled agent 'PC-01' (id assigned on first connection)
# token: mrc_97LN-ghFBDYaWNNyygs03B_BP_DYIYAJ
# Give this token to the agent (it is shown only once).
```

- Only the token's **SHA-256 hash is stored**; the token itself is shown once
  and cannot be recovered later (use `rotate` if it is lost).
- The agent id is pinned to the token on first `hello`: `--id ag_x` pre-binds
  it, otherwise the server assigns one and the agent persists it in
  `agent.json` for future reconnects.
- A token presented by a **different** agent id is rejected (`token is
  already bound`), so a leaked token cannot enroll a second machine.
- Names of active agents must be unique (needed for unambiguous `agent <name>`
  references); revoke first to reuse a name.

```sh
bun run admin -- agent list
bun run admin -- agent revoke <id|name>   # new connections rejected; live sessions drop at the next heartbeat (~10s)
bun run admin -- agent rotate <id|name>   # prints a new token, old one stops working
bun run admin -- server status            # counts, auth mode, limits, per-agent last-seen
```

## Auth modes

| Mode | How | When |
|---|---|---|
| Shared token (`MRC_TOKEN`, default `dev-token`) | Any agent presenting it is accepted, no registry row | Local dev only |
| Per-agent tokens (`admin agent add`) | Checked against SQLite: unknown / revoked / bound-elsewhere are rejected with `auth_failed` (fatal for the agent, no retry loop) | Production |
| Strict (`MRC_REQUIRE_DB_TOKENS=1`) | The shared token is rejected too | Production lockdown |

Revocation takes effect on new connections immediately; a connected agent is
dropped at its next heartbeat and its reconnect is rejected.

## Audit trail

`server/data/audit.jsonl` (override with `MRC_AUDIT_PATH`), one JSON object
per line, rotated at 10 MB (keeps one `audit.jsonl.1`):

```json
{"ts":"2026-10-16T02:00:00.000Z","actor":"tool","op":"agent_exec","agent":"PC-01","params":{"agent":"PC-01","command":"echo hi"},"ok":true,"durationMs":42}
{"ts":"...","actor":"hub","op":"agent:auth_failed","agent":"PC-99","ok":false,"error":"invalid token"}
{"ts":"...","actor":"admin","op":"agent:revoke","agent":"ag_abc123","ok":true}
```

Recorded: every tool call (operation, agent, sanitized params, outcome,
duration, transferred bytes when applicable), hub connection events
(connect/disconnect/auth failures/revocation drops/heartbeat timeouts), and
admin CLI actions. Secrets in params (`token`, `password`, …) are redacted
and large blobs (e.g. `agent_fs` write content) are truncated to ~1 KB, so
the log stays small. Transfer chunk traffic is internal plumbing and is not
logged per chunk — the enclosing tool call is the single audited entry.

## Limits

| Limit | Default | Env | Behavior |
|---|---|---|---|
| Job timeout | 30 s | `MRC_JOB_TIMEOUT_MS` | Server sends `job.cancel`; agent kills the process tree |
| In-flight jobs per agent | 8 | `MRC_MAX_JOBS_PER_AGENT` | New jobs rejected with `agent_busy` |
| Jobs per agent per rolling 60 s | 120 | `MRC_MAX_JOBS_PER_MIN` | Rejected with `rate_limited` (tool calls; internal transfer chunks don't count) |
| Job output accumulation | 1 MB | — | `truncated: true`, caller should redirect to a file |
| Async job history | 100 entries | `MRC_JOB_HISTORY_MAX` | Finished `agent_exec` async jobs kept for `agent_jobs` (status/list) |
| Async job TTL | 30 min | `MRC_JOB_HISTORY_TTL_MS` | How long a finished async job stays queryable |
| Chunk size | 256 KiB (max 512 KiB) | — | Transfers stay under the WS frame limit |
| Transfer size | 1 GiB | — | `agent_fs_transfer` upload/download |
| Screenshot embed | 8 MB | — | Larger images return `localPath` only |

## Restart procedure

The server is stateless apart from SQLite: stop it, start it again, agents
reconnect on their own with backoff (1 s → 60 s cap) keeping their stable
agent ids, and pending jobs from the old process settle as disconnect errors
on the client side. Agent identities and tokens survive restarts (same
`MRC_DB_PATH`).

## Data layout

Everything lives under one directory, `MRC_DATA_DIR` (default `server/data/`,
`/app/server/data` in the image), so a single mount/backup covers it:

- `mcp.db` — enrolled agents, token hashes, first/last seen
- `audit.jsonl` — audit trail
- `screenshots/` — images received by `agent_screenshot` (streamed by the agent
  and saved on this host). Served read-only to MCP clients at
  `GET /screenshots/<file>` on the MCP HTTP port (Bearer `MRC_TOKEN` or
  `?token=`), so a client on another machine can `curl` them.

`MRC_DB_PATH`, `MRC_AUDIT_PATH` and `MRC_SCREENSHOT_DIR` can override each path
individually, but they are unnecessary: moving `MRC_DATA_DIR` moves all three.

## LAN deployment (F5, no VPN)

Posture: plain `ws://` (agents) + `http://` (MCP) on the **trusted local
network**. No Tailscale/VPN — never expose these ports beyond the LAN.
Optional native TLS (`wss://`/`https://`) covers the whole path without a
VPN; see "TLS" below. If you need to reach the server through the public
internet instead of a LAN, use a named Cloudflare tunnel ("Stable URLs").

### TLS (optional, native)

Set `MRC_TLS_CERT`/`MRC_TLS_KEY` (PEM) and both faces serve `wss://` +
`https://`; generate a self-signed LAN cert with the one-liner in
`server/env.example`. Agents accept a self-signed cert via `--tls-insecure`
(or `MRC_TLS_INSECURE=1`), or trust your CA via `NODE_EXTRA_CA_CERTS`.
The MCP HTTP face is plain HTTPS for opencode (add your CA to the client,
or use a real certificate for the hostname).

### 1. Server host (always-on Linux box, static LAN IP)

1. Give the host a stable address: static IP or a DHCP reservation in the
   router (e.g. `192.168.1.50`).
2. Copy this repo to `/opt/mcp-remote-control`, create user `mrc`, install
   Bun for that user, `bun install`.
3. Copy `server/env.example` to `/etc/mcp-remote-control/env` and set at
   least `MRC_HOST=0.0.0.0`, `MRC_TOKEN` (long random value),
   `MRC_REQUIRE_DB_TOKENS=1` and `MRC_MCP_HTTP_PORT=8788`.
4. Install the unit and start it:

   ```sh
   sudo cp server/mcp-remote-control.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now mcp-remote-control
   sudo systemctl status mcp-remote-control
   ```

   It runs hub (`:8787`) + MCP over HTTP (`:8788`), no MCP stdio.
5. Firewall (server host): allow LAN → TCP 8787 (agents) and 8788 (opencode).
   Example with ufw:

   ```sh
   sudo ufw allow from 192.168.1.0/24 to any port 8787,8788 proto tcp
   ```

   Windows agents need **no** firewall rule (outbound only).

### 2. opencode (any LAN machine, incl. the server host)

Point opencode at the persistent server as a **remote** MCP server instead
of spawning stdio (if your opencode version names these keys differently,
check `opencode mcp add --help`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "remote-control": {
        "type": "remote",
        "url": "http://192.168.1.50:8788/mcp",
        "headers": { "Authorization": "Bearer <MRC_TOKEN>" }
      }
    }
  }
}
```

Tools behave exactly like the stdio face (same hub underneath). The audit
trail records these calls with `actor: "tool"` like any other.

### 3. Agents

Enroll each machine (`bun run admin -- agent add --name PC-01`, run with the
same `MRC_DB_PATH` the service uses), then install with
`docs/INSTALL-WINDOWS.md`:

```powershell
.\install.ps1 -Server ws://192.168.1.50:8787 -Token mrc_xxxx -Name OFICINA-01
```

## Stable URLs (named Cloudflare tunnel)

`cloudflared tunnel --url` (quick tunnels) mint a **random**
`trycloudflare.com` hostname per process; agents must then be reconfigured
after every server restart. For a permanent free URL, use a named tunnel on
a domain hosted in Cloudflare (free plan): `scripts/hermes-tunnel.sh` wraps
`cloudflared tunnel create/route dns/run` with an ingress for the two faces
(`MRC_WS_HOSTNAME` → hub `:8787`, optional `MRC_MCP_HOSTNAME` → MCP `:8788`)
and documents a systemd unit for the connector. Agents then always connect
to `wss://<your-host>/agent`, no matter how often the server restarts.

## Self-update (OTA)

`agent_restart` (MCP tool) relaunches the agent detached. With
`updatePath` — the staged new binary, typically uploaded with
`agent_fs_transfer` upload into the same directory as the running exe (see the
`execPath` field in `agent_info`) — it swaps the exe first (rename-self →
move-new-in) and relaunches, then cleans the `.old` file. Typical flow:

```
agent_info            -> read execPath (e.g. C:\rc-agent\rc-agent.exe)
agent_fs_transfer (upload) -> local new exe -> C:\rc-agent\rc-agent.new.exe
agent_restart         -> updatePath=C:\rc-agent\rc-agent.new.exe
agents_list           -> back online in seconds, new version
```

The swap+relaunch runs as a detached `cmd` script, so it works even while
the old process is still running; it also works with the antivirus/AMSI
posture (plain `cmd`, no PowerShell).

## Auto-update (pull on connect)

The server and the agent now share **one version** (`shared/version.ts`,
currently `0.7.0`). On every redeploy the Docker build cross-compiles a fresh
`rc-agent.exe` (version baked in at build time) and places it at
`/app/agent/rc-agent.exe` inside the image, with `MRC_AGENT_BINARY_PATH`
pointing at it. The SHA256 is **computed at runtime** from that file, so no
manual hash is needed.

Redesplegar the server does **not** touch the agent binaries on the Windows
machines, so agents pull updates themselves when they reconnect:

```
server env                              agent behaviour
MRC_AGENT_LATEST_VERSION (default =     -> welcome announces the version
  shared VERSION, e.g. 0.7.0)
MRC_AGENT_BINARY_PATH=/app/agent/...     -> served at /agent/latest.exe
MRC_AGENT_BINARY_SHA256 (auto-computed  -> verified before swapping
  from the file if unset)
```

On every `welcome` the agent compares `latestAgentVersion` with its own
version and, when the server is strictly ahead, downloads the binary,
**verifies the sha256**, stages it next to the running exe and reuses the
detached swap+relaunch from `agent_restart` (old binary kept as `.old`).

Why pull: after a redeploy nobody is connected yet (agents reconnect with
backoff up to 60 s), so a server-side push at boot would find an empty
roster. Asking on connect covers every case — server restart, PC reboot,
network blip.

### What is the SHA256 for?

`MRC_AGENT_BINARY_SHA256` is the **expected fingerprint** of the agent binary.
When an agent downloads the update it computes the SHA256 of the bytes it
received and compares it to this value. If they differ the swap is aborted, so
a tampered or corrupted download (man-in-the-middle, partial transfer, disk
error) can never replace the running agent. SHA256 is a one-way cryptographic
hash: any change to the binary, even a single bit, produces a completely
different 64-hex-char digest, and it is computationally infeasible to craft a
different file with the same digest.

Safety:
- never downgrades (strictly newer only) and never swaps an unverified file;
- `--no-auto-update` / `MRC_AUTO_UPDATE=0` disables it per machine;
- only standalone executables self-update (a dev `bun run agent` does not);
- `MRC_AGENT_BINARY_URL` can point at a CDN instead of the hub (the 92 MB
  binary then never travels through the server).

Publishing a new agent version:

```sh
# 1. bump shared/version.ts  (e.g. 0.7.0 -> 0.7.1)
# 2. commit + push  -> Dokploy rebuilds the image, cross-compiles a fresh exe
#    and serves it at /agent/latest.exe with its sha256 computed at boot.
# 3. agents pick it up on their next reconnect (no env vars to touch).
```

Agents still running an older build pick it up on their next reconnect; new
ones get it at first start. With Dokploy: redeploy after bumping the version
in `shared/version.ts`.
