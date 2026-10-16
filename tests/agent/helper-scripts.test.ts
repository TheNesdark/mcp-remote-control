import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeHelper, resolveHelperScript } from "../../agent/src/helper-scripts.ts";

test("resolveHelperScript finds the checkout helpers", () => {
  // In the repo the dev copies exist, so resolution succeeds on any platform.
  expect(resolveHelperScript("tray.ps1")?.endsWith("tray.ps1")).toBe(true);
  expect(resolveHelperScript("first-run.ps1")?.endsWith("first-run.ps1")).toBe(true);
  expect(resolveHelperScript("does-not-exist.ps1")).toBeNull();
});

test("materializeHelper writes the embedded script once and reuses it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mrc-helpers-"));
  const first = materializeHelper("tray.ps1", dir);
  expect(first).toBe(join(dir, "tray.ps1"));
  expect(readFileSync(first, "utf8")).toContain("NotifyIcon");
  const second = materializeHelper("tray.ps1", dir);
  expect(second).toBe(first);
  expect(() => materializeHelper("does-not-exist.ps1", dir)).toThrow(/no embedded helper/);
});
