# Server operations (F4)

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
and large blobs (e.g. `agent_fs_write` content) are truncated to ~1 KB, so
the log stays small. Transfer chunk traffic is internal plumbing and is not
logged per chunk — the enclosing tool call is the single audited entry.

## Limits

| Limit | Default | Env | Behavior |
|---|---|---|---|
| Job timeout | 30 s | `MRC_JOB_TIMEOUT_MS` | Server sends `job.cancel`; agent kills the process tree |
| In-flight jobs per agent | 8 | `MRC_MAX_JOBS_PER_AGENT` | New jobs rejected with `agent_busy` |
| Jobs per agent per rolling 60 s | 120 | `MRC_MAX_JOBS_PER_MIN` | Rejected with `rate_limited` (tool calls; internal transfer chunks don't count) |
| Job output accumulation | 1 MB | — | `truncated: true`, caller should redirect to a file |
| Chunk size | 256 KiB (max 512 KiB) | — | Transfers stay under the WS frame limit |
| Transfer size | 1 GiB | — | `agent_fs_upload` / `agent_fs_download` |
| Screenshot embed | 8 MB | — | Larger images return `localPath` only |

## Restart procedure

The server is stateless apart from SQLite: stop it, start it again, agents
reconnect on their own with backoff (1 s → 60 s cap) keeping their stable
agent ids, and pending jobs from the old process settle as disconnect errors
on the client side. Agent identities and tokens survive restarts (same
`MRC_DB_PATH`).

## Data layout

`MRC_DATA_DIR` (default `server/data/`):

- `mcp.db` — enrolled agents, token hashes, first/last seen (`MRC_DB_PATH`)
- `audit.jsonl` — audit trail (`MRC_AUDIT_PATH`)
- `screenshots/` — images pulled by `agent_screenshot` (`MRC_SCREENSHOT_DIR`)
