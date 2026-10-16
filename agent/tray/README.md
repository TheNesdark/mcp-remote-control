# Tray helper — validate on a Windows VM (F3 close-out)

These scripts are the risky part of the agent design (see `PLAN.md` §2.2).
They speak a JSON-lines protocol with the Bun agent; the F0 spikes are now the
real helpers used by `agent/src/tray.ts` (tray) and `agent/src/settings.ts`
(first-run dialog).

Requirements: Windows 10/11 (PowerShell 5.1 is enough). No installation needed.

## 1. First-run dialog

```powershell
powershell -NoProfile -Sta -ExecutionPolicy Bypass -File first-run.ps1
```

Expected: a small dialog asking for the computer name (prefilled with
`%COMPUTERNAME%`), server URL and token. On "Save" it prints one JSON line and
exits 0; "Cancel" prints `{"cancelled":true}` and exits 2; an invalid name
prints `{"error":"invalid_name",...}` and exits 3.

## 2. Tray icon + menu (demo mode, no agent needed)

```powershell
powershell -NoProfile -Sta -ExecutionPolicy Bypass -File tray.ps1 -Demo
```

Expected:
- An icon appears next to the clock and cycles
  `connecting → connected → paused → disconnected` every 2s, switching between
  the gray/green/yellow/red dots.
- Right click opens the menu; `Enable/Disable agent`, `Reconnect now`,
  `Open logs`, `Start with Windows`, `Exit`.
- Menu clicks print JSON action lines to stdout, e.g.
  `{"type":"action","action":"toggle"}` (the agent performs the actual work;
  in demo mode nothing happens).
- Double click emits a `toggle` action and nothing crashes.
- Running it twice: the second instance exits immediately with
  `already_running`.

## 3. Driven by the agent (real integration)

On the Windows machine, run the agent with the tray enabled (default):

```powershell
bun run agent -- --server ws://<server>:8787 --token <token> --name PC-01
# or from the compiled exe: rc-agent.exe
```

Expected:
- Tray icon appears in the color for the current state; tooltip shows
  `PC-01 - Connected - ws://<server>:8787`.
- `Disable agent` in the menu → the agent sends `presence {paused:true}`
  (server logs "agent paused locally", `agents_list` shows paused) **without**
  disconnecting; `Enable agent` reverses it.
- `Reconnect now` drops and re-establishes the socket (~1s), skipping the
  backoff.
- `Open logs` opens `%APPDATA%\mcp-remote-control\logs`; while the agent runs,
  `agent.log` receives one line per event.
- `Start with Windows` adds/removes the `HKCU\...\Run` entry (compiled exe
  only; under `bun run` the agent refuses and the checkbox reverts on the next
  state line).
- `Exit` stops the agent; the icon disappears immediately.
- Killing the agent process (Task Manager) also removes the icon (the helper
  exits when stdin closes).

## 4. Manual state injection (optional)

From a second PowerShell while `tray.ps1` is running:

```powershell
'{"type":"state","state":"connected","label":"PC-01","detail":"ws://127.0.0.1:8787","autostart":true}' |
  powershell -NoProfile -Sta -ExecutionPolicy Bypass -File tray.ps1
```

(One state then EOF; the helper should exit cleanly when stdin closes.)

## Known limits (until F5 packaging)

- Icon is drawn at runtime (colored dot); the final `.ico` for the exe lands in
  F5 (`--windows-icon`).
- Under `bun run agent` the autostart checkbox cannot work (the Run entry would
  point at `bun`, not the agent); it requires the compiled `rc-agent.exe`.
- The helper is executed from `agent/tray/tray.ps1`; the F5 build will embed and
  copy it next to `agent.json` in `%APPDATA%`.
