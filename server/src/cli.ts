#!/usr/bin/env bun
/**
 * mcp-remote-control admin CLI: enroll agents, manage tokens, inspect status.
 *
 * Operates directly on the SQLite registry (server/data/mcp.db by default),
 * so it works whether the server is running or not. Revoking a token takes
 * effect on new connections immediately; live sessions are dropped at the
 * next heartbeat (~10s).
 *
 * Usage:
 *   bun run admin -- agent add --name PC-01 [--tags oficina,dev] [--id ag_x]
 *   bun run admin -- agent list
 *   bun run admin -- agent revoke <id|name>
 *   bun run admin -- agent rotate <id|name>
 *   bun run admin -- server status
 */
import { argString, parseArgv } from "@mrc/shared/args";
import { AuditLog } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { setLogLevel } from "./log.ts";
import { AgentStore, StoreError, type AgentRow } from "./store.ts";

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function formatTs(ts: number | null): string {
  if (ts === null) return "never";
  const ago = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return `${new Date(ts).toISOString()} (${ago}s ago)`;
}

function statusOf(row: AgentRow): string {
  if (row.revokedAt !== null) return "revoked";
  if (row.lastSeenAt !== null) return "seen";
  if (row.agentId !== null) return "bound";
  return "enrolled";
}

function printRow(row: AgentRow): void {
  console.log(
    `- ${row.agentId ?? "(unbound)"}  name=${row.name}  status=${statusOf(row)}  tags=[${row.tags.join(",")}]  ` +
      `host=${row.host || "-"}  os=${row.os || "-"}  token=${row.tokenHash.slice(0, 8)}…  ` +
      `firstSeen=${formatTs(row.firstSeenAt)}  lastSeen=${formatTs(row.lastSeenAt)}`,
  );
}

const raw = process.argv.slice(2);
const [resource, action, ...tail] = raw;
// Positional operands come first; everything from the first -- token is flags.
const firstFlag = tail.findIndex((token) => token.startsWith("--"));
const positionals = firstFlag === -1 ? tail : tail.slice(0, firstFlag);
const positional = positionals[0];
if (positionals.length > 1) {
  fail(`unexpected arguments: ${positionals.slice(1).join(" ")} (usage: admin <agent|server> <action> [ref] [--flags])`);
}
const args = parseArgv(firstFlag === -1 ? [] : tail.slice(firstFlag));

const config = loadConfig();
setLogLevel("error");

const store = new AgentStore(config.dbPath);
const audit = new AuditLog(config.auditPath);

try {
  if (resource === "agent" && action === "add") {
    const name = argString(args, "name")?.trim();
    if (!name) fail("agent add requires --name <machine-name>");
    const tags = (argString(args, "tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean);
    const agentId = argString(args, "id")?.trim() || undefined;
    try {
      const enrolled = store.addAgent({ name: name!, tags, agentId });
      audit.append({ actor: "admin", op: "agent:add", agent: name, params: { tags, agentId: enrolled.agentId }, ok: true });
      console.log(`enrolled agent '${name}'${enrolled.agentId ? ` (id ${enrolled.agentId})` : " (id assigned on first connection)"}`);
      console.log(`token: ${enrolled.token}`);
      console.log("Give this token to the agent (it is shown only once).");
    } catch (err) {
      if (err instanceof StoreError) fail(err.message);
      throw err;
    }
  } else if (resource === "agent" && action === "list") {
    const rows = store.list();
    if (rows.length === 0) {
      console.log("no agents enrolled (use: admin agent add --name <machine>)");
    } else {
      for (const row of rows) printRow(row);
    }
  } else if (resource === "agent" && action === "revoke") {
    if (!positional) fail("agent revoke requires an agent id or name");
    const row = store.revoke(positional);
    if (!row) fail(`unknown agent '${positional}'`);
    audit.append({ actor: "admin", op: "agent:revoke", agent: row!.agentId ?? row!.name, ok: true });
    console.log(`revoked agent '${row!.name}' (${row!.agentId ?? "unbound"})`);
    console.log("New connections with its token are rejected; live sessions drop at the next heartbeat.");
  } else if (resource === "agent" && action === "rotate") {
    if (!positional) fail("agent rotate requires an agent id or name");
    const rotated = store.rotate(positional);
    if (!rotated) fail(`unknown agent '${positional}'`);
    audit.append({ actor: "admin", op: "agent:rotate", agent: rotated!.agentId ?? positional, ok: true });
    console.log(`rotated token for agent '${rotated!.agentId ?? positional}' (the old token stops working)`);
    console.log(`token: ${rotated!.token}`);
  } else if (resource === "server" && action === "status") {
    const rows = store.list();
    const active = rows.filter((row) => row.revokedAt === null);
    const revoked = rows.length - active.length;
    const recentlySeen = active.filter((row) => row.lastSeenAt !== null && Date.now() - row.lastSeenAt < 2 * config.heartbeatIntervalMs);
    console.log(`agents: ${rows.length} enrolled (${active.length} active, ${revoked} revoked; ~${recentlySeen.length} likely online)`);
    console.log(`auth: ${config.requireDbTokens ? "per-agent tokens only" : "shared token accepted alongside per-agent tokens"}`);
    console.log(`hub: ws://${config.host}:${config.port}  jobTimeout=${config.defaultJobTimeoutMs}ms  maxJobsPerAgent=${config.maxJobsPerAgent}  maxJobsPerMinute=${config.maxJobsPerMinute}`);
    console.log(`data: ${config.dataDir}  db=${config.dbPath}  audit=${config.auditPath}`);
    for (const row of rows) printRow(row);
  } else {
    console.error("usage:");
    console.error("  admin agent add --name <machine> [--tags a,b] [--id ag_x]");
    console.error("  admin agent list");
    console.error("  admin agent revoke <id|name>");
    console.error("  admin agent rotate <id|name>");
    console.error("  admin server status");
    process.exit(1);
  }
} finally {
  store.close();
}
