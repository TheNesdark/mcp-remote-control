import { expect, test } from "bun:test";
import type { Hub, JobOutcome } from "../../server/src/hub.ts";
import {
  buildPsScript,
  parsePsEnvelope,
  PS_DEFAULT_TIMEOUT_MS,
  psBool,
  psEnvelopeData,
  psExecParams,
  psFailure,
  psQuote,
  windowsOnly,
} from "../../server/src/tools/powershell.ts";

function outcome(overrides: Partial<JobOutcome> = {}): JobOutcome {
  return { jobId: "job-1", ok: false, durationMs: 1, stdout: "", stderr: "", truncated: false, ...overrides };
}

/** Minimal stand-in: windowsOnly() only ever calls hub.resolve(). */
function hubReporting(os: string): Hub {
  return { resolve: () => ({ name: "PC-01", os }) } as unknown as Hub;
}

test("psQuote escapes single quotes", () => {
  expect(psQuote("plain")).toBe("'plain'");
  expect(psQuote("a'b")).toBe("'a''b'");
  expect(psQuote("$env:PATH; Remove-Item")).toBe("'$env:PATH; Remove-Item'");
});

test("psBool renders PowerShell literals", () => {
  expect(psBool(true)).toBe("$true");
  expect(psBool(false)).toBe("$false");
});

test("buildPsScript wraps the body in the shared envelope", () => {
  const script = buildPsScript(["$__r = @{ n = 1 }"]);
  expect(script).toContain("$ErrorActionPreference = 'Stop'");
  expect(script).toContain("[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false");
  expect(script).toContain("\n  $__r = @{ n = 1 }\n");
  expect(script).toContain("$__mrc = @{ ok = $true; data = $__r }");
  expect(script).toContain("$__mrc | ConvertTo-Json -Compress -Depth 8");
  expect(script.trimEnd().endsWith("if (-not $__mrc.ok) { exit 1 }")).toBe(true);
});

test("parsePsEnvelope unwraps data and errors", () => {
  expect(parsePsEnvelope('{"ok":true,"data":{"a":1}}')).toEqual({ ok: true, data: { a: 1 } });
  expect(parsePsEnvelope('{"ok":true}')).toEqual({ ok: true, data: null });
  const failed = parsePsEnvelope('{"ok":false,"error":"boom"}');
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.error).toBe("boom");
});

test("parsePsEnvelope reports empty, non-JSON and unexpected payloads", () => {
  const empty = parsePsEnvelope("  \n ");
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error).toContain("no output");

  const nonJson = parsePsEnvelope("Get-Service : Cannot find any service");
  expect(nonJson.ok).toBe(false);
  if (!nonJson.ok) expect(nonJson.error).toContain("non-JSON");

  expect(parsePsEnvelope("[1,2]").ok).toBe(false);
  expect(parsePsEnvelope('"text"').ok).toBe(false);
});

test("psEnvelopeData throws on a failed envelope", () => {
  expect(() => psEnvelopeData('{"ok":false,"error":"service not found"}')).toThrow("service not found");
  expect(psEnvelopeData<{ n: number }>('{"ok":true,"data":{"n":7}}')).toEqual({ n: 7 });
});

test("psFailure prefers the script error over the exec plumbing", () => {
  expect(psFailure(outcome({ stdout: '{"ok":false,"error":"Access is denied"}' }))).toEqual({
    ok: false,
    error: "Access is denied",
  });

  const exec = psFailure(outcome({ exitCode: 1, stderr: "Get-Service : Cannot find any service\r\n" }));
  expect(exec.ok).toBe(false);
  expect(exec.error).toContain("PowerShell failed (exit 1)");
  expect(exec.error).toContain("Cannot find any service");
});

test("exec failure falls back to the job error when stderr is empty", () => {
  const payload = psFailure(outcome({ error: "job timed out after 30000ms" }));
  expect(payload.error).toContain("job timed out after 30000ms");
});

test("psExecParams always runs through the powershell shell", () => {
  expect(psExecParams("Get-Service")).toEqual({ command: "Get-Service", shell: "powershell" });
  expect(PS_DEFAULT_TIMEOUT_MS).toBe(30_000);
});

test("windowsOnly accepts Windows agents and rejects the rest", () => {
  expect(windowsOnly(hubReporting("Windows_NT 10.0.19045"))({ agent: "PC-01" })).toBeNull();

  const rejected = windowsOnly(hubReporting("Linux 6.1.0"))({ agent: "PC-01" });
  expect(rejected).toContain("needs Windows");

  const unknown = {
    resolve: () => {
      throw new Error("unknown agent");
    },
  } as unknown as Hub;
  expect(windowsOnly(unknown)({ agent: "ghost" })).toBeNull();
});

test("a CLIXML stderr blob is reduced to readable text", () => {
  const payload = psFailure(
    outcome({ exitCode: 1, stderr: "#< CLIXML\n<Objs Version=\"1.1\"><S S=\"Error\">denied</S></Objs>" }),
  );
  expect(payload.error).toContain("denied");
});
