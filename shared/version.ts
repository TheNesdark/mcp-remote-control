/** Single source of truth for the version of both the server and the agent. */
export const VERSION = "0.7.7";

/** "0.5.10" > "0.5.9"; unparsable components count as 0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split("-")[0]!.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
