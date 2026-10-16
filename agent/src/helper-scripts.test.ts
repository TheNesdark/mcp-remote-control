import { expect, test } from "bun:test";
import { resolveHelperScript } from "./helper-scripts.ts";

test("resolveHelperScript finds the checkout helpers", () => {
  // In the repo the dev copies exist, so resolution succeeds on any platform.
  expect(resolveHelperScript("tray.ps1")?.endsWith("tray.ps1")).toBe(true);
  expect(resolveHelperScript("first-run.ps1")?.endsWith("first-run.ps1")).toBe(true);
  expect(resolveHelperScript("does-not-exist.ps1")).toBeNull();
});
