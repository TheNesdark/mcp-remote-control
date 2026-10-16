/**
 * Tiny argv helper shared by the agent and the development scripts.
 * Supports `--key value` and bare `--flag` (and `--flag=false` to negate).
 */

export type ArgMap = Map<string, string | true>;

export function parseArgv(argv: string[]): ArgMap {
  const args: ArgMap = new Map();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i++;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

export function argString(args: ArgMap, key: string): string | undefined {
  const value = args.get(key);
  return typeof value === "string" ? value : undefined;
}

export function argFlag(args: ArgMap, key: string): boolean {
  const value = args.get(key);
  if (value === undefined) return false;
  if (value === true) return true;
  return value !== "false" && value !== "0" && value !== "no";
}
