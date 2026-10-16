# Tray spike (F0) — validate on a Windows VM

These scripts are the risky part of the agent design (see `PLAN.md` §2.2).
They are **spikes**: run them by hand on a real Windows machine to validate the
approach before wiring them into the compiled `rc-agent.exe` (F3).

Requirements: Windows 10/11 (PowerShell 5.1 is enough). No installation needed.

## 1. First-run dialog

```powershell
powershell -NoProfile -Sta -ExecutionPolicy Bypass -File first-run.ps1
```

Expected: a small dialog asking for the computer name (prefilled with
`%COMPUTERNAME%`), server URL and token. On "Save" it prints one JSON line and
exits 0; "Cancel" prints `{"cancelled":true}` and exits 2.

## 2. Tray icon + menu

With the agent (F3, not built yet):

```powershell
powershell -NoProfile -Sta -ExecutionPolicy Bypass -File tray.ps1 -Label "PC-01"
```

Standalone demo (no agent needed — cycles `connecting → connected → paused →
disconnected` every 2s and lets you click the menu):

```powershell
powershell -NoProfile -Sta -ExecutionPolicy Bypass -File tray.ps1 -Demo
```

Expected:
- An icon appears next to the clock; tooltip shows `PC-01 - <state>`.
- Right click opens the menu; `Enable/Disable agent`, `Reconnect now`,
  `Open logs`, `Start with Windows` (writes `HKCU\...\Run`), `Exit`.
- Double click emits a `toggle` action and nothing crashes.
- Menu clicks print JSON action lines to stdout, e.g. `{"type":"action","action":"toggle"}`.
- Running it twice: the second instance exits immediately with `already_running`.

## 3. Manual state injection (optional)

From a second PowerShell while `tray.ps1` is running, the Bun agent would send
lines like this on the helper's stdin; to emulate it, smoke-test by piping:

```powershell
'{"type":"state","state":"connected","label":"PC-01"}' | powershell -NoProfile -Sta -ExecutionPolicy Bypass -File tray.ps1
```

(One state then EOF; the helper should exit cleanly when stdin closes.)

## Notes / known limits (spike scope)

- Icon is the generic `SystemIcons.Application`; the real `.ico` arrives in F3
  (`--windows-icon` for the exe, custom icon for the tray).
- `Start with Windows` writes `powershell.exe` to the Run key in the spike; F3
  points it at the real `rc-agent.exe`.
- Autostart via `HKCU` only runs when the user logs in (required for
  screenshots anyway; see the session-0 note in `PLAN.md` §2.2).
