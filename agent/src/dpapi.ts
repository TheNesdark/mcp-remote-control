/**
 * DPAPI (Windows Data Protection API) via PowerShell, user scope.
 * Used to keep the agent token encrypted at rest in agent.json.
 */
import { runCommand } from "./run-command.ts";

const SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String($env:MRC_DPAPI_IN)
if ($env:MRC_DPAPI_MODE -eq "protect") {
  $out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
} else {
  $out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
}
[Convert]::ToBase64String($out)
`;

async function runDpapi(mode: "protect" | "unprotect", inputB64: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("DPAPI is only available on Windows");
  }
  const res = await runCommand(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
    { timeoutMs: 20_000, env: { MRC_DPAPI_MODE: mode, MRC_DPAPI_IN: inputB64 } },
  );
  if (res.code !== 0 || !res.stdout.trim()) {
    const message = (res.stderr.trim() || res.stdout.trim() || `powershell exit ${res.code}`).split("\n")[0];
    throw new Error(`DPAPI ${mode} failed: ${message}`);
  }
  return res.stdout.trim();
}

/** Encrypt a string for the current Windows user; returns base64. */
export async function protectString(plain: string): Promise<string> {
  return runDpapi("protect", Buffer.from(plain, "utf8").toString("base64"));
}

/** Decrypt a base64 blob produced by protectString. */
export async function unprotectString(protectedB64: string): Promise<string> {
  return runDpapi("unprotect", protectedB64);
}
