/**
 * Runner for our own CUA engine sidecar (agent/cua/mrc-cua.cs).
 *
 * The sidecar is a plain one-shot CLI: every call spawns
 * `mrc-cua.exe <tool> --param value ...` and expects one JSON object on
 * stdout. That design (no resident driver daemon, no session state) removes
 * the failure modes the old third-party driver had: stale sessions, stale
 * element tokens and a background authorization process holding the
 * foreground lock.
 *
 * Where the exe comes from (first hit wins):
 * 1. MRC_CUA_EXE (env override; used by tests).
 * 2. Next to the agent executable (built by install.ps1 / OTA packaging).
 * 3. `%LOCALAPPDATA%\mrc-remote-control\cua\mrc-cua.exe` — self-provisioned:
 *    the embedded sources are written there and compiled with csc.exe
 *    (the .NET Framework 4.8 compiler every Windows 10/11 ships) on the
 *    first `cua` call. No installer step needed.
 */
import { readdirSync } from "node:fs";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CuaParams } from "@mrc/shared";
import CUA_CS from "../cua/mrc-cua.cs" with { type: "text" };
import type { ShortJobResult } from "./job-result.ts";

export const CUA_EXE = "mrc-cua.exe";
const CUA_DEFAULT_TIMEOUT_MS = 60_000;

export interface CuaRunnerOptions {
  /** Override the exe path wholesale (tests). */
  exe?: string;
  /** Override the provisioning dir for tests. */
  provisionDir?: string;
  /** Override csc.exe path (tests; resolved from the framework dir by default). */
  csc?: string;
}

// ---------------------------------------------------------------------------
// exe resolution + provisioning
// ---------------------------------------------------------------------------

export function cuaExeCandidates(opts: CuaRunnerOptions = {}): string[] {
  if (opts.exe) return [opts.exe];
  const list: string[] = [];
  const override = process.env.MRC_CUA_EXE;
  if (override && override.length > 0) list.push(override);
  if (process.execPath) list.push(join(dirname(process.execPath), CUA_EXE));
  const local = process.env.LOCALAPPDATA;
  if (local && local.length > 0) list.push(join(local, "mrc-remote-control", "cua", CUA_EXE));
  return list;
}

/** Locates a strongly-named GAC assembly dll (UIA lives in GAC_MSIL, not GAC_64). */
function findInGacs(name: string): string | null {
  const base = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "assembly");
  for (const gac of ["GAC_MSIL", "GAC_64", "GAC_32"]) {
    const dir = join(base, gac, name);
    if (!existsSync(dir)) continue;
    for (const version of safeReaddir(dir)) {
      const dll = join(dir, version, `${name}.dll`);
      if (existsSync(dll)) return dll;
    }
  }
  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function findCsc(): string | null {
  const windir = process.env.WINDIR ?? "C:\\Windows";
  for (const flavor of ["Framework64", "Framework"]) {
    const csc = join(windir, "Microsoft.NET", flavor, "v4.0.30319", "csc.exe");
    if (existsSync(csc)) return csc;
  }
  return null;
}

async function compileSidecar(target: string, dir: string, cscPath: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const cs = join(dir, "mrc-cua.cs");
  writeFileSync(cs, CUA_CS, "utf8");

  const refs: string[] = [];
  for (const asm of ["UIAutomationClient", "UIAutomationTypes"]) {
    const dll = findInGacs(asm);
    if (!dll) throw new Error(`cua sidecar compilation failed: ${asm}.dll not found in the GAC`);
    refs.push(`/r:${dll}`);
  }
  // Forms and Drawing: csc auto-references the runtime-dir copies, so using the
  // same files (instead of their GAC twins) avoids CS1703 duplicate assembly.
  const runtime = dirname(cscPath);
  refs.push(`/r:${join(runtime, "System.Windows.Forms.dll")}`);
  refs.push(`/r:${join(runtime, "System.Drawing.dll")}`);

  const args = ["/nologo", "/warn:0", `/out:${target}`, ...refs, cs];
  const proc = Bun.spawn([cscPath, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 || !existsSync(target)) {
    const detail = `${stdout}${stderr}`.trim().slice(0, 400);
    throw new Error(`cua sidecar compilation failed${detail ? `: ${detail}` : ""}`);
  }
}

/** Returns the exe path, compiling the embedded sources when missing. */
export async function ensureCuaExe(opts: CuaRunnerOptions = {}): Promise<string> {
  for (const candidate of cuaExeCandidates(opts)) {
    if (existsSync(candidate)) return candidate;
  }
  if (process.platform !== "win32") {
    throw new Error("cua sidecar not found (set MRC_CUA_EXE or place mrc-cua.exe next to the agent)");
  }
  const cscPath = opts.csc ?? findCsc();
  if (!cscPath) throw new Error("cua sidecar not found and csc.exe is unavailable (no .NET Framework 4.8)");
  const local = opts.provisionDir ?? join(process.env.LOCALAPPDATA ??dirname(process.execPath), "mrc-remote-control", "cua");
  const target = join(local, CUA_EXE);
  if (!existsSync(target)) await compileSidecar(target, local, cscPath);
  return target;
}

// ---------------------------------------------------------------------------
// one-shot invocation
// ---------------------------------------------------------------------------

export async function runCuaCall(params: CuaParams, opts: CuaRunnerOptions = {}): Promise<ShortJobResult> {
  const exe = await ensureCuaExe(opts);
  const argv: string[] = [exe, params.tool];
  for (const [key, value] of Object.entries(params.args ?? {})) {
    if (value === undefined) continue;
    argv.push(`--${key}`, String(value));
  }
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timeoutMs = params.timeoutMs ?? CUA_DEFAULT_TIMEOUT_MS;
  // Two guards: kill the process at timeout, and reject shortly after so a
  // pipe-owning grandchild (not killed by child.kill) cannot wedge the call.
  const killer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }, timeoutMs);
  const rejector = new Promise<never>((_, reject) => {
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(new Error(`cua sidecar timed out after ${timeoutMs}ms`));
    }, timeoutMs + 250);
  });
  try {
    const [stdout, stderr, code] = (await Promise.race([
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      rejector,
    ])) as [string, string, number];
    if (code !== 0) {
      throw new Error(`cua sidecar exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ""}`);
    }
    const parsed = parseSidecarOutput(stdout);
    if (typeof parsed.ok !== "boolean") throw new Error("cua sidecar returned invalid JSON");
    if (!parsed.ok) throw new Error(parsed.error != null ? String(parsed.error) : "cua call failed");
    const meta: Record<string, unknown> = { ...parsed, ok: true };
    delete meta.error;
    return { meta } satisfies ShortJobResult;
  } finally {
    clearTimeout(killer);
  }
}

type SidecarOutput = { ok?: boolean; error?: unknown; [key: string]: unknown };

function parseSidecarOutput(stdout: string): SidecarOutput {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) throw new Error("cua sidecar produced no output");
  // One-shot protocol: the whole stdout is the JSON object; tolerate stray
  // prefix lines by scanning forward from the first balanced brace.
  let start = trimmed.indexOf("{");
  while (start >= 0) {
    try {
      return JSON.parse(trimmed.slice(start)) as SidecarOutput;
    } catch {
      start = trimmed.indexOf("{", start + 1);
    }
  }
  throw new Error("cua sidecar output is not JSON");
}
