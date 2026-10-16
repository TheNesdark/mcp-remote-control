import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExec, type ExecRequest, type ExecResult, type RunningExec } from "../../agent/src/exec.ts";

interface Collected {
  stdout: string;
  stderr: string;
}

async function collect(
  command: string,
  overrides: Partial<ExecRequest> = {},
  timeoutMs = 10_000,
): Promise<{ result: ExecResult; collected: Collected }> {
  const collected: Collected = { stdout: "", stderr: "" };
  const result = await runExec(
    { command, shell: "native", jobId: "test-job", timeoutMs, ...overrides },
    {
      onOutput: (stream, _seq, data) => {
        collected[stream] += data;
      },
    },
  );
  return { result, collected };
}

test("captures stdout and exit code 0", async () => {
  const { result, collected } = await collect("printf 'hello\\n'");
  expect(result.ok).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(collected.stdout).toBe("hello\n");
  expect(collected.stderr).toBe("");
  expect(result.error).toBeUndefined();
});

test("captures stderr separately", async () => {
  const { result, collected } = await collect("printf 'boom\\n' 1>&2");
  expect(result.ok).toBe(true);
  expect(collected.stderr).toBe("boom\n");
  expect(collected.stdout).toBe("");
});

test("reports non-zero exit codes as not ok", async () => {
  const { result } = await collect("exit 7");
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(7);
  expect(result.error).toBeUndefined();
});

test("honors cwd", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mrc-exec-")));
  const { result, collected } = await collect("pwd", { cwd: dir });
  expect(result.ok).toBe(true);
  expect(realpathSync(collected.stdout.trim())).toBe(dir);
});

test("passes extra environment variables", async () => {
  const { collected } = await collect("printf '%s' \"$MRC_TEST_VAR\"", { env: { MRC_TEST_VAR: "abc123" } });
  expect(collected.stdout).toBe("abc123");
});

test("feeds stdin to the command", async () => {
  const { result, collected } = await collect("cat", { stdin: "line from stdin\n" });
  expect(result.ok).toBe(true);
  expect(collected.stdout).toBe("line from stdin\n");
});

test("timeout kills the process tree", async () => {
  const { result } = await collect("sleep 5", {}, 300);
  expect(result.ok).toBe(false);
  expect(result.error).toBe("timed out after 300ms");
  expect(result.durationMs).toBeLessThan(3_000);
});

test("cancel kills the process tree", async () => {
  let handle: RunningExec | undefined;
  const started = Date.now();
  const promise = runExec(
    { command: "sleep 5", shell: "native", jobId: "cancel-job", timeoutMs: 10_000 },
    {
      onOutput: () => {},
      onHandle: (h) => {
        handle = h;
      },
    },
  );
  await Bun.sleep(200);
  expect(handle).toBeDefined();
  handle!.cancel();

  const result = await promise;
  expect(result.ok).toBe(false);
  expect(result.error).toBe("cancelled");
  expect(Date.now() - started).toBeLessThan(3_000);
});

test("fails cleanly when the command cannot start", async () => {
  const { result } = await collect("echo hi", { cwd: "/definitely/not/here" });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/failed to start command/);
});

test("reports large output in multiple chunks", async () => {
  const chunks: string[] = [];
  const result = await runExec(
    { command: "printf 'x%.0s' $(seq 1 200000)", shell: "native", jobId: "big", timeoutMs: 10_000 },
    { onOutput: (_stream, _seq, data) => chunks.push(data) },
  );
  expect(result.ok).toBe(true);
  expect(chunks.join("").length).toBe(200_000);
});

test("streams output incrementally, before the command finishes", async () => {
  let firstChunkAt: number | null = null;
  const started = Date.now();
  const result = await runExec(
    { command: "printf 'first\\n'; sleep 0.4; printf 'second\\n'", shell: "native", jobId: "stream", timeoutMs: 10_000 },
    {
      onOutput: (_stream, _seq, data) => {
        if (firstChunkAt === null && data.includes("first")) firstChunkAt = Date.now() - started;
      },
    },
  );
  expect(result.ok).toBe(true);
  expect(firstChunkAt).not.toBeNull();
  // The first chunk must arrive well before the process exits.
  expect(firstChunkAt!).toBeLessThan(result.durationMs - 200);
});
