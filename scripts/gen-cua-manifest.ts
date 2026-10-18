#!/usr/bin/env bun
/**
 * Regenerate shared/cua-tools.ts from a `cua-driver dump-docs` JSON.
 *
 * Usage:
 *   ./cua-driver dump-docs > /tmp/cua-dump.json
 *   bun run gen:cua-manifest -- /tmp/cua-dump.json
 */
import { writeFileSync } from "node:fs";

const source = process.argv[2];
if (!source) {
  console.error("usage: bun run gen:cua-manifest -- <dump-docs.json>");
  process.exit(2);
}
const dump = await Bun.file(source).json();
type DumpTool = { name: string; description: string; input_schema?: unknown; destructive?: boolean; read_only?: boolean; idempotent?: boolean };
const tools = (dump.mcp?.tools ?? []) as DumpTool[];
if (tools.length === 0) {
  console.error("no tools.found in the dump");
  process.exit(1);
}
const entries = tools
  .map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: (t.input_schema ?? {}) as Record<string, unknown>,
    destructive: Boolean(t.destructive),
    readOnly: Boolean(t.read_only),
    idempotent: Boolean(t.idempotent),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const body = JSON.stringify(entries, null, 1);
const out = `/**
 * Cua Driver MCP tool manifest — GENERATED, do not edit by hand.
 * Source: \`cua-driver dump-docs\` on cua-driver-rs v${dump.mcp.version}.
 * Regenerate: bun run gen:cua-manifest -- <dump.json>  (against the pinned
 * shared/cua-version.ts build; then keep the pin and this file in sync).
 *
 * The server registers each entry as an \`agent_cua_<name>\` MCP tool so the
 * whole driver surface is reachable through the hub while the agent stays a
 * dumb pipe (fixed \`cua-driver call <name>\` exec). \`destructive\` mirrors the
 * driver's own flag: those tools require confirm=true through our hub.
 */
export interface CuaToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
  readOnly: boolean;
  idempotent: boolean;
}

export const CUA_TOOLS_SOURCE_VERSION = ${JSON.stringify(String(dump.mcp.version))};

const tools = ${body} as const satisfies readonly CuaToolSpec[];

export const CUA_TOOLS = tools;
`;
const target = new URL("../shared/cua-tools.ts", import.meta.url).pathname;
writeFileSync(target, out);
console.log(`wrote ${target} (${entries.length} tools, driver v${dump.mcp.version})`);
