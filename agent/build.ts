#!/usr/bin/env bun
/**
 * Cross-compile the Windows agent from Linux:
 *   bun run build:exe [--out dist/rc-agent.exe] [--server ws://192.168.1.50:8787] [--name OFICINA-01] [--token <token>]
 *
 * --server/--name/--token bake compile-time defaults into the exe (lowest-priority
 * config layer: CLI flags, env, agent.json and --name still override them).
 * Typical fleet flow: bake --server once, distribute the same exe everywhere;
 * names come from %COMPUTERNAME% (or the installer) automatically.
 * NOTE: --token baking is supported for convenience on trusted LANs. It puts
 * the shared token inside the binary (readable by anyone with the exe), so
 * prefer agent.json (installer/first-run) for multi-tenant or untrusted setups.
 *
 * Produces dist/rc-agent.exe (PE, no console window, embedded icon and
 * version metadata) and verifies the output. The tray/first-run .ps1 helpers
 * ship next to the exe (see agent/install.ps1).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "agent", "src", "index.ts");
const ICON = join(ROOT, "agent", "assets", "icon.ico");

const NAME_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;

function flagValue(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

async function readVersion(): Promise<string> {
  const text = await Bun.file(ENTRY).text();
  const match = /const VERSION = "([^"]+)"/.exec(text);
  if (!match) throw new Error("could not find VERSION in agent/src/index.ts");
  return match[1]!;
}

async function gitSha(): Promise<string> {
  try {
    const proc = Bun.spawn({ cmd: ["git", "rev-parse", "--short", "HEAD"], cwd: ROOT, stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out || "nogit";
  } catch {
    return "nogit";
  }
}

const outFlag = process.argv.indexOf("--out");
const out = outFlag >= 0 ? String(process.argv[outFlag + 1]) : join(ROOT, "dist", "rc-agent.exe");
mkdirSync(dirname(out), { recursive: true });

// Baked-in defaults (lowest-priority config layer in the exe).
const bakedServer = flagValue("--server");
if (bakedServer !== undefined && !/^wss?:\/\/[^/]+/.test(bakedServer)) {
  throw new Error(`--server must look like ws://host:8787 or wss://host:8787, got '${bakedServer}'`);
}
const bakedToken = flagValue("--token");
if (bakedToken !== undefined && bakedToken.trim().length === 0) {
  throw new Error("--token must not be empty");
}
const bakedName = flagValue("--name");
if (bakedName !== undefined && !NAME_PATTERN.test(bakedName)) {
  throw new Error(`--name must match ^[A-Za-z0-9._-]{1,32}$, got '${bakedName}'`);
}
const defines: string[] = [];
if (bakedServer !== undefined) defines.push(`--define`, `process.env.MRC_BUILT_IN_SERVER="${bakedServer}"`);
if (bakedToken !== undefined) {
  console.log("WARNING: baking --token into the exe. Every machine that runs it shares the same token; fine for a trusted LAN, risky otherwise.");
  defines.push(`--define`, `process.env.MRC_BUILT_IN_TOKEN="${bakedToken}"`);
}
if (bakedName !== undefined) defines.push(`--define`, `process.env.MRC_BUILT_IN_NAME="${bakedName}"`);

if (!existsSync(ICON)) {
  console.log("icon.ico missing, generating it");
  const proc = Bun.spawn({ cmd: ["bun", "run", join(ROOT, "agent", "assets", "make-icon.ts")], stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error("make-icon failed");
}

const version = await readVersion();
const sha = await gitSha();
const fileVersion = [...version.split("."), "0"].slice(0, 4).join(".");
console.log(`building rc-agent.exe version=${version} sha=${sha}`);

// NOTE: --windows-icon/title/publisher/version only work when compiling ON
// Windows. Linux cross-builds are functionally identical but carry default
// metadata; run this script on the Windows VM for the fully branded exe.
const windowsMeta =
  process.platform === "win32"
    ? [
        `--windows-icon=${ICON}`,
        "--windows-title=mcp-remote-control agent",
        "--windows-publisher=mcp-remote-control",
        `--windows-version=${fileVersion}`,
      ]
    : [];
if (windowsMeta.length === 0) {
  console.log("cross-compiling from Linux: exe metadata (icon/version) applies on Windows builds only");
}

const build = Bun.spawn({
  cmd: [
    "bun",
    "build",
    "--compile",
    "--target=bun-windows-x64",
    "--windows-hide-console",
    ...windowsMeta,
    ...defines,
    "--outfile",
    out,
    ENTRY,
  ],
  stdout: "inherit",
  stderr: "inherit",
});
const code = await build.exited;
if (code !== 0) throw new Error(`bun build --compile failed (exit ${code})`);

const file = Bun.file(out);
const bytes = new Uint8Array(await file.arrayBuffer());
if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
  throw new Error("output is not a Windows PE executable (missing MZ header)");
}
const peOffset = new DataView(bytes.buffer).getUint32(0x3c, true);
const peSig = String.fromCharCode(bytes[peOffset]!, bytes[peOffset + 1]!, bytes[peOffset + 2]!, bytes[peOffset + 3]!);
if (peSig !== "PE\0\0") {
  throw new Error("output is not a Windows PE executable (missing PE signature)");
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
console.log(`ok: ${basename(out)} (${(file.size / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}…)`);
