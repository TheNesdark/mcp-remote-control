/**
 * Helpers for the Windows tools: thin, validated wrappers over `agent_exec`
 * with `shell: "powershell"`.
 *
 * The model never composes PowerShell. Each tool builds a fixed script from
 * validated arguments (`buildPsScript`) and the agent answers with a single
 * JSON envelope, so:
 *   - failures come back as data instead of being lost in stderr;
 *   - the script exits non-zero on failure, which keeps the audit trail honest;
 *   - non-ASCII text (service names, event messages) survives, because the
 *     console output encoding is forced to no-BOM UTF-8.
 */
import type { Hub, JobOutcome } from "../hub.ts";

/** Default timeout for the Windows helpers; service/event queries can be slow. */
export const PS_DEFAULT_TIMEOUT_MS = 30_000;
/** How much raw output to quote back when something other than JSON comes out. */
const SNIPPET_CHARS = 600;
/** PowerShell invocation used by every Windows helper. */
export const PS_SHELL = "powershell" as const;

/** Quote a value as a PowerShell single-quoted literal (doubling `'`). */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Render a boolean as a PowerShell literal. */
export function psBool(value: boolean): string {
  return value ? "$true" : "$false";
}

/**
 * Wrap a script body in the shared preamble/epilogue.
 *
 * The body must assign its payload to `$__r`. The envelope prints
 * `{ ok, data }` or `{ ok, error }` and exits non-zero when `ok` is false.
 */
export function buildPsScript(body: readonly string[]): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "try {",
    ...body.map((line) => `  ${line}`),
    "  $__mrc = @{ ok = $true; data = $__r }",
    "} catch {",
    "  $__mrc = @{ ok = $false; error = $_.Exception.Message }",
    "}",
    "$__mrc | ConvertTo-Json -Compress -Depth 8",
    "if (-not $__mrc.ok) { exit 1 }",
  ].join("\n");
}

/** Exec params for a helper script (`agent_exec` with shell=powershell). */
export function psExecParams(script: string): { command: string; shell: typeof PS_SHELL } {
  return { command: script, shell: PS_SHELL };
}

export type PsEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

/** Parse the JSON envelope printed by `buildPsScript` scripts. */
export function parsePsEnvelope<T = unknown>(stdout: string): PsEnvelope<T> {
  const text = stdout.trim();
  if (!text) return { ok: false, error: "PowerShell returned no output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `PowerShell returned non-JSON output: ${snippet(text)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `PowerShell returned an unexpected payload: ${snippet(text)}` };
  }
  const record = parsed as Record<string, unknown>;
  if (record.ok === true) return { ok: true, data: (record.data ?? null) as T };
  return {
    ok: false,
    error: typeof record.error === "string" && record.error ? record.error : "PowerShell reported an unknown failure",
  };
}

/** `buildResult` payload: unwrap the envelope, or throw (registerJobTool -> toolError). */
export function psEnvelopeData<T>(stdout: string): T {
  const envelope = parsePsEnvelope<T>(stdout);
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data;
}

/** `buildFailure` payload: prefer the script's own error message over the exec plumbing. */
export function psFailure(outcome: JobOutcome): { ok: false; error: string } {
  return { ok: false, error: envelopeError(outcome.stdout) ?? execFailure(outcome) };
}

/** Error text of a `{ ok: false }` envelope, or null when there is no envelope at all. */
function envelopeError(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.ok === true) return null;
  return typeof record.error === "string" && record.error ? record.error : "PowerShell reported an unknown failure";
}

/** Human-readable explanation for an exec job that did not finish cleanly. */
export function execFailure(outcome: JobOutcome): string {
  const stderr = stripClixml(outcome.stderr).trim().split("\n").slice(0, 3).join(" ").trim();
  const detail = outcome.error ?? (stderr || "no error output");
  const code = outcome.exitCode !== undefined ? ` (exit ${outcome.exitCode})` : "";
  return `PowerShell failed${code}: ${snippet(detail)}`;
}

/**
 * `validate` builder for Windows-only tools: returns an error string when the
 * target agent is not Windows, or null when it is (or when the agent is
 * unknown, so the hub produces its own routing error).
 */
export function windowsOnly(hub: Hub): (args: { agent: string }) => string | null {
  return (args) => {
    let os: string;
    try {
      os = hub.resolve(args.agent).os;
    } catch {
      return null;
    }
    return /win/i.test(os)
      ? null
      : `agent '${args.agent}' runs '${os}': this tool needs Windows; use agent_exec on POSIX agents`;
  };
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}...` : flat;
}

/** PowerShell may wrap redirected stderr in CLIXML; keep the readable part. */
function stripClixml(text: string): string {
  if (!text.includes("CLIXML")) return text;
  return text
    .replace(/#<\s*CLIXML\s*/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}
