/**
 * Screenshot retention: the screenshot directory would otherwise grow forever
 * (a few MB per capture). After every save we prune the oldest files down to
 * the newest MRC_SCREENSHOT_KEEP. Only regular files directly inside the
 * directory are ever deleted, so an operator can drop a "keep" subdir there
 * and it is never touched.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./log.ts";

/** Extensions the pruner recognizes as its own files. */
const SCREENSHOT_EXTENSIONS = /\.(png|jpg)$/i;

export interface PruneResult {
  deleted: number;
  kept: number;
}

/**
 * Delete all but the newest `keep` screenshot files (mtime order).
 * Returns the counts; never throws for missing/unreadable directories.
 */
export async function pruneScreenshots(dir: string, keep: number): Promise<PruneResult> {
  if (keep <= 0) return { deleted: 0, kept: 0 };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { deleted: 0, kept: 0 };
  }
  const files: { path: string; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!SCREENSHOT_EXTENSIONS.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isFile()) files.push({ path, mtimeMs: info.mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
  if (files.length <= keep) return { deleted: 0, kept: files.length };
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const victims = files.slice(keep);
  let deleted = 0;
  for (const victim of victims) {
    try {
      await rm(victim.path, { force: true });
      deleted += 1;
    } catch (err) {
      logger.warn("could not prune screenshot", { path: victim.path, error: String(err) });
    }
  }
  return { deleted, kept: files.length - deleted };
}

/** Fire-and-forget prune used after each screenshot save. */
export function scheduleScreenshotPrune(dir: string, keep: number): void {
  if (keep <= 0) return;
  void pruneScreenshots(dir, keep).then((result) => {
    if (result.deleted > 0) {
      logger.info("pruned old screenshots", { dir, deleted: result.deleted, kept: result.kept });
    }
  });
}
