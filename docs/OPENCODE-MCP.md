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

Environment variables (all optional except the token in production):

| Variable | Default | Meaning |
|---|---|---|
| `MRC_HOST` | `127.0.0.1` | Bind address for the websocket hub. Use `0.0.0.0` (or the Tailscale IP) so Windows agents can connect. |
| `MRC_PORT` | `8787` | Websocket port. |
| `MRC_TOKEN` | `dev-token` | Shared enrollment token. **Always set this** outside local dev. |
| `MRC_JOB_TIMEOUT_MS` | `30000` | Default job timeout. |
| `MRC_SCREENSHOT_DIR` | `server/data/screenshots` | Where `agent_screenshot` saves pulled images. |
| `MRC_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (goes to stderr). |

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
   agent_fs_list(agent="PC-01", path="C:\\Users\\User\\Documents")
   agent_fs_read(agent="PC-01", path="C:\\temp\\log.txt")
   agent_fs_write(agent="PC-01", path="C:\\temp\\hello.txt", content="hi")
   agent_fs_upload(agent="PC-01", localPath="/root/installer.msi", remotePath="C:\\temp\\installer.msi")
   agent_fs_download(agent="PC-01", remotePath="C:\\temp\\report.pdf", localPath="/root/report.pdf")
   ```

   `upload`/`download` copy between **this server's machine** and the remote
   machine in chunks, and verify SHA-256 (and size) in both directions. Writes
   are limited to 512 KiB per call; use upload for bigger files
   (`agent_fs_write` supports `mkdirs=true`).
7. Inventory, processes and screenshots:

   ```
   agent_info(agent="PC-01")
   agent_ps_list(agent="PC-01", filter="chrome", top=20, sort="cpu")
   agent_ps_kill(agent="PC-01", pid=1234)               # tree + force by default
   agent_ps_kill(agent="PC-01", name="notepad.exe")     # kills every match
   agent_screenshot(agent="PC-01")                      # primary monitor, embedded image
   agent_screenshot(agent="PC-01", format="jpeg", quality=70, embed=false)
   ```

   - `agent_info` returns hostname, OS, user, uptime, CPU, memory, IPs and disks
     with free space.
   - `agent_ps_list` sorts by `cpu` (default), `mem`, `pid` or `name` and can
     filter by process name / command line substring. `force=false` and
     `tree=false` request a graceful single-process kill instead.
   - `agent_screenshot` captures **only the primary monitor** and saves the
     image on the server host (path in `localPath`) while embedding it in the
     tool result (`embed=false` for path-only). On Windows the agent must run in
     an interactive desktop session: session 0 (service) or a locked desktop
     fails with `no interactive session`. Screenshots above 8 MB are not
     embedded (use the `localPath` or JPEG).
   - `agent_ps_kill` refuses to kill the agent process itself.
