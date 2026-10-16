import { expect, test } from "bun:test";
import { isAutostartEnabled, setAutostartEnabled } from "../../agent/src/autostart.ts";

test("autostart is disabled off-Windows and refuses changes", async () => {
  if (process.platform === "win32") return; // covered on the Windows VM
  expect(isAutostartEnabled()).toBe(false);
  await expect(setAutostartEnabled(true)).rejects.toThrow(/only supported on Windows/);
});
