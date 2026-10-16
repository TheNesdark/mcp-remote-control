import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger, setLogFile } from "./log.ts";

test("setLogFile mirrors logger output to a file", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mrc-log-")), "agent.log");
  setLogFile(path);
  try {
    logger.info("hello file log", { n: 1 });
    const content = readFileSync(path, "utf8");
    expect(content).toContain("hello file log");
    expect(content).toContain('"n":1');
    expect(content.trim().split("\n").length).toBe(1);
  } finally {
    setLogFile(null);
  }

  // After disabling, nothing more is written.
  logger.info("after disable");
  const content = readFileSync(path, "utf8");
  expect(content).not.toContain("after disable");
});
