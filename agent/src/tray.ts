/**
 * Tray integration: keeps the PowerShell NotifyIcon helper (tray/tray.ps1) in
 * sync with the agent over JSON lines and routes user actions back.
 *
 *   agent  -> helper (stdin):  {"type":"state","state":"connected","label":"PC-01",...}
 *   helper -> agent (stdout):  {"type":"action","action":"toggle"|"reconnect"|"open_logs"|"autostart"|"exit","enabled":bool}
 *
 * Disabled automatically on non-Windows hosts and in tests without a helper
 * command override. The helper is a child process: stop() asks it to exit and
 * kills it if it does not leave on its own.
 */
import type { ConnectionState } from "./connection.ts";
import { resolveHelperScript } from "./helper-scripts.ts";
import { snapshotEnv } from "@mrc/shared/env";

export interface TrayActionMessage {
  type: "action";
  action: "toggle" | "reconnect" | "open_logs" | "autostart" | "exit" | "already_running";
  enabled?: boolean;
}

export interface TrayOptions {
  enabled: boolean;
  label: string;
  detail: string;
  logDir: string;
  autostart: boolean;
  onToggle?: () => void;
  onReconnect?: () => void;
  onOpenLogs?: () => void;
  onAutostart?: (enabled: boolean) => void;
  onExit?: () => void;
  /** Test/advanced override: command that speaks the JSON-lines protocol. */
  helperCommand?: string[];
  log?: (level: "warn" | "info", msg: string, fields?: Record<string, unknown>) => void;
}

export class TrayIntegration {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private state: ConnectionState = "connecting";
  private detail: string;
  private autostart: boolean;
  private readonly enabled: boolean;

  constructor(private readonly opts: TrayOptions) {
    this.enabled = opts.enabled;
    this.detail = opts.detail;
    this.autostart = opts.autostart;
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  start(): void {
    if (!this.enabled || this.proc) return;
    const command = this.opts.helperCommand ?? defaultTrayCommand(this.opts.label);
    if (!command) {
      this.log("warn", "tray helper not available (script missing); running without tray");
      return;
    }
    try {
      const proc = Bun.spawn({
        cmd: command,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: snapshotEnv(),
      });
      this.proc = proc;
      this.log("info", "tray helper started", { command: command[0] });
      void this.readStdout(proc);
      void this.readStderr(proc);
      proc.exited.then((code) => {
        if (this.proc === proc) {
          this.proc = null;
          this.log("warn", "tray helper exited", { code });
        }
      });
      // Initial state so the icon shows the right color immediately.
      this.setState("connecting");
    } catch (err) {
      this.proc = null;
      this.log("warn", `could not start tray helper: ${String(err)}`);
    }
  }

  setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    if (detail !== undefined) this.detail = detail;
    this.writeLine({
      type: "state",
      state,
      label: this.opts.label,
      detail: this.detail,
      autostart: this.autostart,
      logDir: this.opts.logDir,
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try {
      this.writeLine({ type: "exit" });
    } catch {
      // stdin may already be closed
    }
    const exited = await Promise.race([
      proc.exited.then(() => true),
      Bun.sleep(700).then(() => false),
    ]);
    if (!exited) {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
  }

  // -------------------------------------------------------------------------

  private writeLine(payload: Record<string, unknown>): void {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
      void proc.stdin.flush();
    } catch {
      // helper gone; process exit handler will notice
    }
  }

  private async readStdout(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
          if (line) this.handleActionLine(line);
        }
      }
    } catch {
      // helper closed
    }
  }

  private handleActionLine(line: string): void {
    let msg: TrayActionMessage;
    try {
      msg = JSON.parse(line) as TrayActionMessage;
    } catch {
      this.log("warn", "tray helper sent a non-JSON line", { line });
      return;
    }
    if (msg.type !== "action") return;
    switch (msg.action) {
      case "toggle":
        this.opts.onToggle?.();
        this.setState(this.state); // helper flips after the agent state arrives
        return;
      case "reconnect":
        this.opts.onReconnect?.();
        return;
      case "open_logs":
        this.opts.onOpenLogs?.();
        return;
      case "autostart": {
        const enabled = Boolean(msg.enabled);
        this.autostart = enabled;
        this.opts.onAutostart?.(enabled);
        return;
      }
      case "exit":
        this.opts.onExit?.();
        return;
      case "already_running":
        this.log("warn", "another tray instance is already running");
        return;
      default:
        return;
    }
  }

  private async readStderr(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk).trim();
        if (text) this.log("warn", `tray: ${text}`);
      }
    } catch {
      // helper closed
    }
  }

  private log(level: "warn" | "info", msg: string, fields?: Record<string, unknown>): void {
    this.opts.log?.(level, msg, fields);
  }
}

/** Default helper command on Windows (installed exe dir, %APPDATA%, or dev checkout). */
export function defaultTrayCommand(label: string): string[] | null {
  if (process.platform !== "win32") return null;
  const script = resolveHelperScript("tray.ps1");
  if (!script) return null;
  return [
    "powershell.exe",
    "-NoProfile",
    "-NonInteractive",
    "-Sta",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Label",
    label,
  ];
}
