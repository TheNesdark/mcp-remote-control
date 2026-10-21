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

## The agent comes back by itself

When the hub goes down (a deploy, a restart) it closes every agent socket with
1001 "server shutting down". The agent must come back on its own: nobody is
watching the screen of a remote machine.

The loop used to stop there. `ConnectOnceAsync` returned after the close and
`RunAsync` waited on a semaphore that only a *requested* reconnect (the hub
asking, or the tray button) releases. With the hub down nothing released it:
the process stayed alive, the watchdog saw a live pid and did nothing, and the
machine was unreachable until somebody ran the installer by hand.

Now a session says how it ended: a requested reconnect waits for the request to
be consumed and reconnects at once, any other close retries with the usual
backoff (1 s, then up to 60 s). `agent_diagnose` reports `watchdog`, so "is
anything watching this agent" has an answer. The watchdog mutex is taken with
`WaitOne(0)` and an abandoned mutex is taken over: a watchdog killed with the
session no longer blocks the next one forever.

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

The server and the agent share **one version** (`shared/version.ts`). The
agent exe is published from `agent-dotnet/` (self-contained win-x64) and placed
where the server can serve it, with `MRC_AGENT_BINARY_PATH` pointing at it; the
SHA256 is **computed at runtime** from that file, so no manual hash is needed.
The server image does **not** build the agent (its publish is Windows-only).

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
- only standalone executables self-update;
- `MRC_AGENT_BINARY_URL` can point at a CDN instead of the hub (the binary then
  never travels through the server).

Publishing a new agent version:

```sh
# 1. bump shared/version.ts  (e.g. 1.0.8 -> 1.0.9)
# 2. cd agent-dotnet && dotnet publish -c Release -r win-x64 \
#      --self-contained true -p:PublishSingleFile=true -o ../dist
# 3. copy dist/rc-agent.exe to the share and to MRC_AGENT_BINARY_PATH
#    (the sha256 is computed at boot from that file).
# 4. agents pick it up on their next reconnect (no env vars to touch).
```

`scripts/deploy-hub.sh` does all of it (publish the agent, upload it to the
share and redeploy the hub), with the order that matters: **the binary on the
share first, the hub afterwards**. The agent refuses an update whose version
is not exactly the one the hub announces, so a share ahead of the hub is not
picked up, and a share behind it is rejected.

### One binary on the share

`MRC_AGENT_BINARY_UNC` points at `\\192.168.1.191\Hermes\rc-agent-update.exe`
and `scripts/INSTALAR-AGENTE.bat` copies **the same file**. Keep it that way:
with two files on the share one of them stays behind and the installer puts an
old build on the machine. The installer prints the version it copied, read
from the file that was just written.

### Deploying the hub (Dokploy)

Use **application.deploy**, not application.redeploy: `redeploy` reuses the
clone Dokploy made earlier and can deploy an old commit, which shows up as a
hub that announces a version that is not in the repository. `deploy` clones
again.

There is no GitHub webhook for this repository (the hub lives on the LAN and
GitHub cannot reach it), so `autoDeploy` on push never fires: the deploy is
always manual.

### The Java Access Bridge is powerful and fragile

Swing applications are invisible to UIA3, so the agent reads them through the
Java Access Bridge. Two rules keep that from taking the application down:

- the JDK copies `count - startIndex` children into the caller's buffer and
  fills a 256 entry array on its own stack, so a node with more visible
  children than that overflows the stack of the JVM and kills it (an access
  violation in `jvm.dll`). Nodes that big are skipped and logged;
- every walk has a budget (nodes, depth and wall clock) and only one job at a
  time is inside the bridge: the AT thread stops broadcasting while a job is
  using the DLL.

When a bridge call fails, `agent_diagnose` says whether the application is
still alive; "the Java application is no longer running" means the JVM died,
and `hs_err_pid*.log` next to the jar explains why.


### How UIA is driven

UIA is a COM API and its objects belong to the thread that created them. The
jobs arrive on the websocket thread and finish on the pool, so two calls at
once (or one call that awaits in the middle) used to read the tree from a
thread that did not own the automation object. Every property read failed,
the walk swallowed the exception per node and the window came back with
`element_count: 0` as if it had no elements (1.0.47). Now:

- all of `agent_cua_*` runs on **one STA thread**, one job at a time;
- the automation object is created lazily on that thread, never in a static
  initializer (the first thread to touch the class would own it);
- `wait_for` polls with a blocking wait instead of `await`, so it stays on
  that thread;
- every property is read on its own: `AutomationId` (and others) throw
  `PropertyNotSupportedException` on plenty of elements (WinUI, Chrome, the
  desktop), and one of those used to empty the whole tree;
- when UIA cannot read even the root, the call fails with
  `UIA could not read the window: <exception>` instead of returning an empty
  tree. `get_window_state` also carries `uia_error` when a subtree failed.

### The watchdog

The agent is started by the user (HKCU Run key) and by the installer, but
nothing used to bring it back when it died: a crash left the machine
unreachable until somebody walked to it. The agent now starts a **watchdog**,
a second copy of the same executable with `--watchdog` that

- watches the pid of the agent (written in `agent.pid` in the agent's
  directory) and starts it again when it is gone;
- waits 8 seconds before doing so, because an update replaces the executable
  and starts the new one: the agent is alive, with another pid;
- stops when the agent is closed on purpose (the tray writes
  `watchdog.stop`), and never opens a window;
- needs no scheduled task and no administrator rights.

`agent_diagnose` says whether the watchdog is running. `--no-watchdog` turns
it off.

### New tools

| Tool | What it does |
| --- | --- |
| `agent_diagnose` | One call with the state of the agent, the bridge, the Java windows, the recording and the last log lines. |
| `agent_settings` | Reads and writes the name, the hub, the token and the autostart of the agent from the outside. The token is never returned in full. |
| `agent_cua_read_value` | Reads what a field holds (focus, select, copy, read the clipboard, put the clipboard back). The only way to read a Java field. |
| `agent_cua_jab_wait_for` | Waits for an element of a Java application; the UIA `wait_for` cannot see Swing. |
| `agent_cua_clipboard_set_image` | Puts an image in the clipboard. |
| `agent_cua_clipboard_set_files` | Puts files in the clipboard, the way the explorer does it. |

Every CUA call accepts `bridge: "off"` to skip the Java Access Bridge for
that call (some applications crash the JVM when the bridge walks their
tree), and every call that moves the mouse or the keyboard returns the
`steps` it did.

### How the bridge walks a Java window

Two rules, both learned the hard way with GENOMA (1.0.45):

- **Children come from `AccessibleContextInfo.childrenCount` plus
  `getAccessibleChildFromContext`**, one level at a time. The
  `getVisibleChildren` family is not a list of direct children: the JDK
  descends the whole subtree there and returns every descendant in the
  SHOWING state flattened into one list. Walking that list visits the same
  panel under several ancestors (the duplicated panes), spends the node
  budget on repeats and never asks a panel for its own children.
- **The JDK counts as accessible children only the components that
  implement `Accessible`** (`Container.getAccessibleChildrenCount`). A panel
  built out of AWT heavyweights, or one that paints its widgets itself,
  reports zero children and there is nothing to expose: no flag, no API and
  no other bridge changes that. When `childrenCount` says zero on a big box
  the agent probes indexes 0..23 anyway (two misses in a row stop it) and
  logs `children found by index although the count said zero` when the
  counter lied.

GENOMA is a mixed case: the login dialog is plain Swing and the bridge reads
it (USUARIO, CONTRASEÑA, SEDE, buttons), while the workspace panels answer
zero children and have no child HWNDs either, so its tree and forms are
painted by the application and are driven with coordinates.

### Errors with a code

A failure of the agent now carries a stable code and a hint:

```json
{"ok": false, "error": {"code": "jvm_died", "message": "...", "hint": "look for hs_err_pid*.log"}}
```

The codes are `jvm_died`, `bridge_unavailable`, `bridge_hostile`,
`element_not_found`, `window_not_found`, `timeout`, `invalid_args`,
`not_supported` and `internal`.

## Windows 7 (legacy build)

.NET 8 does not run on Windows 7. The same sources also build against
`net6.0-windows`, the last runtime that supports Windows 7 SP1: the `Win7`
MSBuild property switches the target framework and the package versions
(`FlaUI.UIA3` 4.0, `System.Management` 6.0, `System.Drawing.Common` 6.0), and
`ApplicationHighDpiMode` drops from `PerMonitorV2` to `SystemAware`. The
`required` attributes that C# 11 emits are polyfilled in
`agent-dotnet/src/Net6Polyfills.cs` (compiled out on net8).

```sh
# 64-bit Windows 7 (the usual case)
dotnet publish agent-dotnet -c Release -r win-x64 --self-contained true \
  -p:EnableWindowsTargeting=true -p:Win7=true \
  -p:IncludeNativeLibrariesForSelfExtract=true -o out/win7-x64

# 32-bit Windows 7
dotnet publish agent-dotnet -c Release -r win-x86 --self-contained true \
  -p:EnableWindowsTargeting=true -p:Win7=true \
  -p:IncludeNativeLibrariesForSelfExtract=true -o out/win7-x86
```

`IncludeNativeLibrariesForSelfExtract` matters here: without it
`vcruntime140_cor3.dll` is published next to the exe, and the OTA path only
carries a single file.

Publish the result to the share as `rc-agent-win7-x64.exe` /
`rc-agent-win7-x86.exe`. **Never point `agent_restart` with `updatePath`, or
the hub's `MRC_AGENT_BINARY_UNC`, at a Windows 7 machine using
`rc-agent-update.exe`**: that is the net8 build and it will not start.

The Win7 target also requires SP1, KB2533623 and KB4474419 on the machine.
UIA through FlaUI 4.x has not been validated against a real Windows 7 box;
CDP works with Chrome 109, the last Chrome for Windows 7. The legacy build
reports the same version as the net8 one, so the hub cannot tell them apart.

The Windows 7 build disables auto-update on purpose (`AutoUpdate.SupportedBuild`
is false on `net6.0-windows`): `rc-agent-update.exe` is the net8 binary and
would leave the machine without an agent. Those machines are updated by hand
with `INSTALAR-AGENTE-WIN7.bat`, and the agent logs the skipped update.
