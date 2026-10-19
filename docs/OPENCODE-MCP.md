# Connecting opencode to mcp-remote-control

The server speaks MCP over **stdio**: opencode spawns it as a local server, and
exposes its tools as `remote_control_<tool>` (e.g. `remote_control_agents_list`).

## CLI (recommended, V2)

From the project where you want the tools:

```sh
opencode mcp add remote-control \
  --env MRC_TOKEN=change-me \
  --env MRC_HOST=0.0.0.0 \
  --env MRC_PORT=8787 \
  -- bun run /root/proyectos/mcp-remote-control/server/src/index.ts

opencode mcp list
```

Add `--global` to make it available in every project.

## Manual configuration

`opencode.jsonc` (project) or `~/.config/opencode/opencode.jsonc` (global):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "remote-control": {
        "type": "local",
        "command": ["bun", "run", "/root/proyectos/mcp-remote-control/server/src/index.ts"],
        "environment": {
          "MRC_HOST": "0.0.0.0",
          "MRC_PORT": "8787",
          "MRC_TOKEN": "{env:MRC_TOKEN}"
        }
      }
    }
  }
}
```

### Only three variables matter in production

`server/env.example` is deliberately short. A LAN deployment needs:

```sh
MRC_TOKEN=<long random secret>     # required in production
MRC_MCP_HTTP_PORT=8788             # only if opencode connects over HTTP
MRC_REQUIRE_DB_TOKENS=1            # only once per-agent tokens are enrolled
```

Everything else has a default that works: paths derive from `MRC_DATA_DIR`
(itself defaulting to `server/data`), the OTA version comes from the build and
the agent binary is discovered on its own.

### All variables (every one is optional except `MRC_TOKEN`)

| Variable | Default | Meaning |
|---|---|---|
| `MRC_HOST` | `127.0.0.1` | Bind address for the websocket hub. Use `0.0.0.0` (or the LAN IP) so machines on the LAN can connect. |
| `MRC_PORT` | `8787` | Websocket port. |
| `MRC_TOKEN` | `dev-token` | Shared enrollment token (dev convenience). In production, enroll per-agent tokens (`bun run admin -- agent add --name PC-01`) and set `MRC_REQUIRE_DB_TOKENS=1`. |
| `MRC_REQUIRE_DB_TOKENS` | _(off)_ | Set to `1` to reject the shared token; only enrolled per-agent tokens work. |
| `MRC_DATA_DIR` | `server/data` | Single root for data: `mcp.db`, `audit.jsonl` and `screenshots/` all live inside it. |
| `MRC_MCP_HTTP_PORT` | _(off)_ | Serve MCP over Streamable HTTP at `/mcp` on this port (LAN clients, `Authorization: Bearer <MRC_TOKEN>`). Used with `--no-mcp-stdio`. |
| `MRC_PUBLIC_URL` | _(derived)_ | Base URL clients use to fetch screenshots (e.g. `http://192.168.1.192:8788`). When set, `agent_screenshot` returns a ready-to-use `downloadUrl` and stops embedding the image by default (SSE is slow). |
| `MRC_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (goes to stderr). |

Tuning knobs (leave unset unless you have a reason):

| Variable | Default | Meaning |
|---|---|---|
| `MRC_JOB_TIMEOUT_MS` | `30000` | Default job timeout. |
| `MRC_MAX_JOBS_PER_AGENT` | `8` | Max in-flight jobs per agent (`agent_busy` above). |
| `MRC_MAX_JOBS_PER_MIN` | `120` | Max tool-call jobs per agent per rolling 60 s (`rate_limited` above). |
| `MRC_JOB_HISTORY_MAX` | `100` | Finished `agent_exec` async jobs kept in memory for `agent_jobs` (status/list). |
| `MRC_JOB_HISTORY_TTL_MS` | `1800000` | How long a finished async job stays queryable (30 min). |
| `MRC_DB_PATH` | `<data>/mcp.db` | Override the SQLite registry path. |
| `MRC_AUDIT_PATH` | `<data>/audit.jsonl` | Override the audit trail path. |
| `MRC_SCREENSHOT_DIR` | `<data>/screenshots` | Override where `agent_screenshot` saves images. |
| `MRC_SCREENSHOT_KEEP` | `200` | Newest screenshots to keep on disk; older ones are pruned after each capture and at boot (0 = keep everything). |
| `MRC_TLS_CERT` / `MRC_TLS_KEY` | _(off)_ | PEM pair: both faces serve `wss://` + `https://`. |

Auto-update (OTA) — no variable needed when the image ships the build:

| Variable | Default | Meaning |
|---|---|---|
| `MRC_AGENT_LATEST_VERSION` | `shared/version.ts` | Fixed to the build's own version on purpose: the only way to publish a new agent is bumping `shared/version.ts`, so server and agent never drift. |
| `MRC_AGENT_BINARY_PATH` | `<repo>/agent/rc-agent.exe` if it exists | Local agent build served at `/agent/latest.exe`. The Docker image sets this and ships the binary. |
| `MRC_AGENT_BINARY_SHA256` | _(computed at boot)_ | Expected fingerprint of that build; verified by the agent before swapping. |
| `MRC_AGENT_BINARY_URL` | _(hub)_ | Point agents at a CDN instead of the hub. |

## Remote client (persistent LAN server)

Instead of spawning the server per session over stdio, point opencode at a
server running under systemd (`docs/OPERATIONS.md`, LAN deployment) as a
remote MCP server:

```jsonc
{
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

## Permissions

To keep the agent from using the tools without asking, restrict them by name:

```jsonc
{
  "permissions": [
    { "action": "remote_control_*", "resource": "*", "effect": "ask" }
  ]
}
```

## Verify

1. `opencode mcp list` → `remote-control` should show as connected.
2. In a session, ask the model to run `agents_list` — with no agents running it
   returns `[]`.
3. Start an agent (the real one runs on Linux for development):

   ```sh
   bun run /root/proyectos/mcp-remote-control/agent/src/index.ts \
     --server ws://127.0.0.1:8787 --token change-me --name PC-01
   ```

   or the fake echo agent:

   ```sh
   bun run /root/proyectos/mcp-remote-control/scripts/fake-agent.ts \
     --server ws://127.0.0.1:8787 --token change-me --name FAKE-01
   ```

4. Call `agents_list` → the agent appears online. Stop it (Ctrl+C) and it turns
   offline.
5. Ask the model to run a command, e.g.:

   ```
   agent_exec(agent="PC-01", command="echo hello")
   ```

   Result JSON includes `stdout`, `stderr`, `exitCode`, `durationMs` and
   `truncated`. On timeout the remote process tree is killed and `error`
   explains it.
6. File tools:

   ```
   agent_fs(operation="list", agent="PC-01", path="C:\\Users\\User\\Documents")
   agent_fs(operation="read", agent="PC-01", path="C:\\temp\\log.txt")
   agent_fs(operation="write", agent="PC-01", path="C:\\temp\\hello.txt", content="hi")
   agent_fs_transfer(operation="upload", agent="PC-01", localPath="/root/installer.msi", remotePath="C:\\temp\\installer.msi")
   agent_fs_transfer(operation="download", agent="PC-01", remotePath="C:\\temp\\report.pdf", localPath="/root/report.pdf")
   ```

   `upload`/`download` copy between **this server's machine** and the remote
   machine in chunks, and verify SHA-256 (and size) in both directions. Writes
   are limited to 512 KiB per call; use upload for bigger files
   (`agent_fs` write supports `mkdirs=true`).
7. Inventory, processes and screenshots:

   ```
   agent_info(agent="PC-01")
   agent_ps(operation="list", agent="PC-01", filter="chrome", top=20, sort="cpu")
   agent_ps(operation="kill", agent="PC-01", pid=1234)               # tree + force by default
   agent_ps(operation="kill", agent="PC-01", name="notepad.exe")     # kills every match
   agent_screenshot(agent="PC-01")                      # primary monitor, embedded image
   agent_screenshot(agent="PC-01", format="jpeg", quality=70, embed=false)
   ```

   - `agent_info` returns hostname, OS, user, uptime, CPU, memory, IPs and disks
     with free space.
   - `agent_ps` (list) sorts by `cpu` (default), `mem`, `pid` or `name` and can
     filter by process name / command line substring. `force=false` and
     `tree=false` request a graceful single-process kill instead.
   - `agent_screenshot` captures **only the primary monitor**. The agent never
     writes the image to the remote disk: it streams it inside the job and the
     server verifies size + SHA-256, saves its local copy (`localPath`) and, by
     default, embeds it in the tool result (`embed=false` for path-only). Over
     the HTTP face (MRC_PUBLIC_URL set) embedding defaults to false because a
     multi-MB base64 blob in the SSE response is slow and times out on clients:
     fetch the image through downloadUrl instead. On
     Windows the agent must run in an interactive desktop session: session 0
     (service) or a locked desktop fails with `no interactive session`.
     Screenshots above 8 MB are not embedded (use the `localPath` or JPEG).
8. Windows operations (the server only builds a PowerShell script from the
   validated arguments; the agent returns one JSON envelope):

   ```
   agent_services(agent="PC-01", filter="spooler", state="running")
   agent_services(operation="control", agent="PC-01", name="Spooler", action="restart", waitSeconds=30)
   agent_eventlog(agent="PC-01", log="System", level="error", hours=48, max=50)
   agent_net(operation="ports", agent="PC-01", state="listen", filter="445")
   agent_net(operation="test", agent="PC-01", host="srv-01", port=445)
   agent_fs(operation="hash", agent="PC-01", path="C:\\temp\\rc-agent.exe")
   ```

   - `agent_services` lists name / displayName / status / startType, filtered by
     a case-insensitive substring and/or state. `agent_services` (control) starts,
     stops, restarts or inspects one service and reports its resulting state
     (`force=true` also affects dependents; many services need an elevated
     agent, otherwise you get `Access is denied`).
   - `agent_eventlog` reads Windows event logs (System / Application /
     Security), newest first, filtered by severity, provider and look-back
     hours. Messages are truncated to `messageChars`.
   - `agent_net` (ports) lists TCP/UDP endpoints with the owning pid **and**
     process name (needs Windows 8 / Server 2012 or newer); `agent_net` (test)
     resolves, pings and TCP-connects from the remote machine's point of view,
     which is what tells you whether a backup target or database is reachable
     from that host.
   - `agent_fs` (hash) returns the SHA-256 and size of a remote file without
     transferring it (useful to verify an installer or OTA build).
   - These tools need **Windows**; on a POSIX agent they fail fast with
     `needs Windows` (use `agent_exec` there).
9. Files and power:

   ```
   agent_fs(operation="search", agent="PC-01", path="C:\\Logs", pattern="*.log", recursive=true, olderThanDays=7)
   agent_fs(operation="mkdir", agent="PC-01", path="C:\\Temp\\2026")
   agent_fs(operation="move", agent="PC-01", source="C:\\a.txt", destination="C:\\b.txt")
   agent_fs(operation="copy", agent="PC-01", source="C:\\a.txt", destination="D:\\backup", overwrite=true)
   agent_fs(operation="delete", agent="PC-01", path="C:\\Temp\\old", recursive=true, confirm=true)
   agent_power(agent="PC-01", action="restart", delaySeconds=30, message="Mantenimiento", confirm=true)
   agent_message(agent="PC-01", text="Cierre las aplicaciones, hay mantenimiento", style="warning")
   ```

   - `agent_fs` (search) lists files under a directory (newest first) with size /
     age filters; `agent_fs` mkdir/move/copy work
     entirely on the remote machine (no bytes cross the server) and refuse to
     replace an existing destination unless `overwrite=true`.
   - `agent_fs` (delete) is permanent (no recycle bin) and therefore needs
     `confirm=true`; drive roots are rejected and the path is used literally
     (no wildcards). Non-empty directories need `recursive=true`.
   - `agent_power` actions: `shutdown`, `restart`, `logoff`, `lock`, `sleep`,
     `hibernate` and `abort` (cancels a pending shutdown). Everything except
     `lock`/`abort` needs `confirm=true`. `delaySeconds` defaults to 5 so the
     call returns before the machine goes down; the agent connection dropping
     after a restart/shutdown is the action succeeding.
   - `agent_message` pops a Windows message box on the remote desktop, shown by
     a detached process: it returns as soon as the box is on screen and the
     user's answer is not reported.
10. Async jobs (long work without blocking the session):

   ```
   agent_exec(agent="PC-01", command="backup.cmd", async=true, timeoutMs=3600000)
   agent_jobs(operation="status", jobId="0f4c...")
   agent_jobs(operation="list", agent="PC-01", state="running")
   agent_jobs(operation="cancel", jobId="0f4c...")
   ```

   `agent_exec` with `async=true` returns a `jobId` as soon as the command is running (same
   arguments as `agent_exec`). `agent_jobs` (status) reports the state
   (`running` | `ok` | `failed`), exit code, duration, stdout/stderr and
   metadata; output of a finished job is capped and the history is bounded by
   `MRC_JOB_HISTORY_MAX` / `MRC_JOB_HISTORY_TTL_MS`. `agent_jobs` (list) also shows
   running synchronous jobs, and `agent_jobs` (cancel) kills the whole remote
   process tree (the agent confirms; the server gives up after a couple of
   seconds and marks the job failed).
11. Diagnostics (fixed PowerShell probes, Windows only):

   ```
   agent_software(agent="PC-01", filter="Office")
   agent_time(agent="PC-01")
   agent_sessions(agent="PC-01")
   ```

   - `agent_software` inventories installed programs from the Add/Remove
     Programs registry keys (64-bit, 32-bit, optionally per-user), deduplicated
     and filtered by a case-insensitive substring. Silent installers and
     portable apps are not listed, same as Settings > Apps.
   - `agent_time` reads the clock, timezone and NTP health and measures the
     agent's clock against the server's (`offsetFromServerMs`). Read this first
     when a machine has Kerberos / domain-logon errors.
   - `agent_sessions` shows who is logged on (console and RDP by default) via
     CIM, so it works on any display language; `interactiveOnly=false` adds
     service/batch/network sessions collapsed per user.
 12. Computer use (Windows only, UIA through **FlaUI** inside the agent binary;
     the CUA engine used to be a separate sidecar compiled on the target - that
     is gone, there is one `rc-agent.exe`):

    ```
    agent_cua_list_windows(agent="SRV-RX")                            # hwnd/pid/title per window
    agent_cua_get_window_state(agent="SRV-RX", window_id=262414)      # UIA tree with element rects
    agent_cua_screenshot(agent="SRV-RX", window_id=262414)            # PNG pulled to the hub
    agent_cua_click(agent="SRV-RX", x=820, y=460, window_id=262414, confirm=true)
    agent_cua_type_text(agent="SRV-RX", text="hola", window_id=262414, confirm=true)
    agent_cua_press_key(agent="SRV-RX", key="enter", window_id=262414, confirm=true)
    agent_cua_scroll(agent="SRV-RX", x=820, y=460, ticks=-3, confirm=true)
    agent_cua_focus(agent="SRV-RX", window_id=262414)
    ```

    - Coordinates come from the element rects of `agent_cua_get_window_state`;
      `window_id` is the HWND in decimal. Every input tool steals the target
      window's foreground first and needs `confirm=true` (the engine refuses
      runs without it).

    Element-oriented tools - prefer these over coordinate arithmetic, they keep
    working when a window moves or scrolls:

    ```
    agent_cua_find_element(agent="SRV-RX", window_id=262414, name="Guardar")         # rect + click_point
    agent_cua_invoke(agent="SRV-RX", window_id=262414, name="Guardar", confirm=true) # UIA InvokePattern
    agent_cua_set_value(agent="SRV-RX", window_id=262414, name="Total", value="1234", confirm=true)
    agent_cua_wait_for(agent="SRV-RX", window_id=262414, name="Listo", timeout_ms=20000)
    agent_cua_table_read(agent="SRV-RX", window_id=262414, max_rows=200)             # rows of cells
    agent_cua_clipboard_set(agent="SRV-RX", text="hola", confirm=true)               # + press_key ctrl+v
    ```

    - Criteria (`name`, `automation_id`, `class_name`, `control_type`) are
      substring matches except `control_type`, which is exact; `nth` picks among
      several matches and `whole_desktop` searches every window.
    - `invoke` uses the UIA pattern and falls back to a real click when the
      control exposes none. `set_value` writes without stealing focus.
      `wait_for` removes the need for fixed sleeps (`until_gone` waits for a
      dialog to close). `table_read` uses GridPattern when the app has it and
      otherwise walks DataItem/ListItem rows.
    - `find_element`/`wait_for`/`table_read` are read-only; `invoke`,
      `set_value` and `clipboard_set` need `confirm=true`.

    Desktop control and extraction:

    ```
    agent_cua_clipboard_set(agent="SRV-RX", text="hola", confirm=true)               # then press ctrl+v
    agent_cua_clipboard_get(agent="SRV-RX")                                         # read what was copied
    agent_cua_window(agent="SRV-RX", action="maximize", window_id=262414, confirm=true)
    agent_cua_window(agent="SRV-RX", action="move", window_id=262414, x=0, y=0, width=1280, height=720, confirm=true)
    agent_cua_send_hotkey(agent="SRV-RX", keys="ctrl+s", window_id=262414, confirm=true)
    agent_cua_drag(agent="SRV-RX", from_name="Fila 3", to_name="Fila 1", window_id=262414, confirm=true)
    agent_cua_element_screenshot(agent="SRV-RX", window_id=262414, name="Factura")   # one control only
    ```

    - `clipboard_get` is the extraction path for apps with no usable UIA tree:
      select-all + copy inside the app, then read here. `window` takes
      close/minimize/maximize/restore/move. `send_hotkey` presses a whole chord
      atomically. `drag` accepts either coordinates (`from_x/from_y`,
      `to_x/to_y`) or element names at both ends, and `element_screenshot`
      captures a single control (fetch the path with `agent_fs_download`).
    - `clipboard_get`, `element_screenshot` (and the criteria tools above) are
      read-only; `window`, `send_hotkey` and `drag` need `confirm=true`.

    Native browser control (`agent_cua_browser`) drives the browser the USER
    already runs — their real profile, tabs and logins — over its DevTools
    Protocol port:

    ```
    agent_cua_browser(agent="SRV-RX", operation="state")                # url/title/text preview
    agent_cua_browser(agent="SRV-RX", operation="tabs")                 # tab list with target_id
    agent_cua_browser(agent="SRV-RX", operation="text", max_chars=8000) # page text
    agent_cua_browser(agent="SRV-RX", operation="open", url="https://example.com", confirm=true)
    agent_cua_browser(agent="SRV-RX", operation="navigate", url="https://example.com", confirm=true)
    agent_cua_browser(agent="SRV-RX", operation="click", match="log in", confirm=true)
    ```

    - One-time setup on the machine: open `chrome://inspect/#remote-debugging`
      in Chrome (or `edge://inspect`) and turn on "Allow remote debugging".
      Chrome then writes a `DevToolsActivePort` file the agent discovers.
      The FIRST time a tab is touched Chrome shows an "Allow debugging?"
      prompt; the user accepts it once per tab. Firefox has no CDP port: use
      `agent_cua_get_window_state` + `agent_cua_click` there.
    - `state`/`tabs`/`text` are read-only. `open` creates a new tab at `url`,
      `navigate` drives the chosen tab (see `target_id` from `tabs`), `click`
      clicks the nth enabled link/button whose text contains `match`.
      `open`/`navigate`/`click` need `confirm=true` and only accept
      `http(s)://` or `file://` URLs.
    - For anything outside the page (dialogs, non-browser windows) read the
      tree with `agent_cua_get_window_state` and click by coordinates.

    Screen recording (`agent_cua_record`) captures the primary monitor for a
    bounded clip and pulls the finished file to the hub:

    ```
    agent_cua_record(agent="SRV-RX", duration_sec=15, fps=4, confirm=true)
    ```

    - MP4/h264 when `ffmpeg.exe` is on that machine (next to the sidecar or on
      PATH), otherwise a motion-JPEG `.avi` (playable in VLC; remux with
      `ffmpeg -i in.avi -c copy out.mp4`). The call blocks for the clip plus
      encoding (1–60 s, 1–10 fps), needs `confirm=true`, and the clip is saved
      with the screenshots (`downloadUrl` included when `MRC_PUBLIC_URL` is
      set). Nothing is ever uploaded anywhere: the file lands on the hub disk.


### Saving a screenshot on the client's machine

The MCP server cannot write to the client's disk (MCP is request/response). The
image reaches the client embedded in the tool result, and the server keeps its
own copy in `MRC_SCREENSHOT_DIR`. To land the file on the machine where opencode
runs (a different host), use the download link the tool returns:

```bash
# downloadPath is relative; downloadUrl (prefixed with MRC_PUBLIC_URL) is ready to use
curl -fL -H "Authorization: Bearer $MRC_TOKEN" \
     "http://192.168.1.192:8788/screenshots/agent-PC-01-2026-10-17_18-30-00.png" \
     -o shot.png
```

`GET /screenshots/<file>` is served on the **MCP HTTP port** and accepts the
bearer header or `?token=<MRC_TOKEN>`; only files directly inside
`MRC_SCREENSHOT_DIR` are served. Set `MRC_PUBLIC_URL` (e.g.
`http://192.168.1.192:8788`) so `agent_screenshot` returns a full `downloadUrl`.

   - `agent_ps` (kill) refuses to kill the agent process itself.
