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
