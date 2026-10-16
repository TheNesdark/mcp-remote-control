import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, readJsonLines } from "../../scripts/test-utils.ts";

const CLI = join(import.meta.dir, "../../server/src/cli.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn({ cmd: ["bun", CLI, ...args], stdout: "pipe", stderr: "pipe", env: cleanEnv(env) });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

test("admin enrolls, lists, revokes and rotates agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mrc-cli-"));
  const env = { MRC_DB_PATH: join(dir, "mcp.db"), MRC_AUDIT_PATH: join(dir, "audit.jsonl") };

  const add = await runCli(["agent", "add", "--name", "VM-01", "--tags", "oficina"], env);
  expect(add.code).toBe(0);
  const token = /mrc_[A-Za-z0-9_-]+/.exec(add.stdout)?.[0];
  expect(token).toBeDefined();

  const duplicate = await runCli(["agent", "add", "--name", "VM-01"], env);
  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toMatch(/already exists/);

  const list = await runCli(["agent", "list"], env);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain("VM-01");
  expect(list.stdout).not.toContain(token!);

  const revoke = await runCli(["agent", "revoke", "VM-01"], env);
  expect(revoke.code).toBe(0);
  expect(revoke.stdout).toMatch(/revoked/);

  const listed = await runCli(["agent", "list"], env);
  expect(listed.stdout).toMatch(/revoked/);

  const rotate = await runCli(["agent", "rotate", "VM-01"], env);
  expect(rotate.code).toBe(0);
  const rotatedToken = /mrc_[A-Za-z0-9_-]+/.exec(rotate.stdout)?.[0];
  expect(rotatedToken).toBeDefined();
  expect(rotatedToken).not.toBe(token);

  const unknown = await runCli(["agent", "revoke", "ghost"], env);
  expect(unknown.code).toBe(1);

  const status = await runCli(["server", "status"], env);
  expect(status.code).toBe(0);
  expect(status.stdout).toMatch(/agents:/);
  expect(status.stdout).toMatch(/auth:/);

  const audit = await readJsonLines(join(dir, "audit.jsonl"));
  const ops = audit.map((line) => (line as { op: string }).op);
  expect(ops).toContain("agent:add");
  expect(ops).toContain("agent:revoke");
  expect(ops).toContain("agent:rotate");
}, 60_000);
