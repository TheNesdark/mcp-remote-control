/**
 * Snapshot of the process environment as plain string pairs, with optional
 * overrides (`undefined` deletes the key).
 *
 * Bun.spawn does not inherit `process.env` mutations made after startup, so
 * callers that need a predictable child environment pass this explicitly.
 */
export function snapshotEnv(extra?: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
