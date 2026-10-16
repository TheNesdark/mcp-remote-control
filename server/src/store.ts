/**
 * AgentStore: enrolled agents and their tokens in SQLite (bun:sqlite).
 *
 * - `agent add` creates a row with a fresh token (returned once, never stored
 *   in clear) and an optional pre-bound agent id.
 * - The token's SHA-256 is stored; the agent id is pinned on first `hello`.
 * - Revocation is a timestamp: the hub rejects new hellos and drops live
 *   sessions at the next heartbeat.
 */
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentRow {
  agentId: string | null;
  tokenHash: string;
  name: string;
  tags: string[];
  host: string;
  os: string;
  version: string;
  createdAt: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

export interface AgentMeta {
  host?: string;
  os?: string;
  version?: string;
  name?: string;
  tags?: string[];
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Single-use enrollment token: `mrc_` + 32 base64url chars. */
export function generateToken(): string {
  return `mrc_${randomBytes(24).toString("base64url")}`;
}

export function generateAgentId(): string {
  return `ag_${randomBytes(4).toString("hex")}`;
}

export class StoreError extends Error {}

function rowToAgent(row: Record<string, unknown>): AgentRow {
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.tags ?? "[]"));
    if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    tags = [];
  }
  return {
    agentId: (row.agent_id as string | null) ?? null,
    tokenHash: String(row.token_hash ?? ""),
    name: String(row.name ?? ""),
    tags,
    host: String(row.host ?? ""),
    os: String(row.os ?? ""),
    version: String(row.version ?? ""),
    createdAt: Number(row.created_at ?? 0),
    firstSeenAt: row.first_seen_at === null ? null : Number(row.first_seen_at),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

export class AgentStore {
  private readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id   TEXT UNIQUE,
        token_hash TEXT NOT NULL UNIQUE,
        name       TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '[]',
        host       TEXT NOT NULL DEFAULT '',
        os         TEXT NOT NULL DEFAULT '',
        version    TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        first_seen_at INTEGER,
        last_seen_at  INTEGER,
        revoked_at    INTEGER
      );
    `);
  }

  /** Enroll an agent. Returns the token once (only its hash is stored). */
  addAgent(input: { name: string; tags?: string[]; agentId?: string }): { agentId: string | null; token: string } {
    const name = input.name.trim();
    if (!name) throw new StoreError("agent name must not be empty");
    const existing = this.getByName(name);
    if (existing && existing.revokedAt === null) {
      throw new StoreError(`an active agent named '${name}' already exists (revoke it first or pick another name)`);
    }
    const agentId = input.agentId?.trim() || null;
    if (agentId && this.getById(agentId)) {
      throw new StoreError(`agent id '${agentId}' is already enrolled`);
    }
    const token = generateToken();
    const tokenHash = hashToken(token);
    if (this.getByTokenHash(tokenHash)) {
      // Astronomically unlikely; retry instead of violating UNIQUE.
      return this.addAgent(input);
    }
    this.db
      .query(
        "INSERT INTO agents (agent_id, token_hash, name, tags, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(agentId, tokenHash, name, JSON.stringify(input.tags ?? []), Date.now());
    return { agentId, token };
  }

  getByTokenHash(tokenHash: string): AgentRow | null {
    const row = this.db.query("SELECT * FROM agents WHERE token_hash = ?").get(tokenHash) as Record<
      string,
      unknown
    > | null;
    return row ? rowToAgent(row) : null;
  }

  getById(agentId: string): AgentRow | null {
    const row = this.db.query("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as Record<
      string,
      unknown
    > | null;
    return row ? rowToAgent(row) : null;
  }

  getByName(name: string): AgentRow | null {
    const row = this.db.query("SELECT * FROM agents WHERE lower(name) = lower(?) LIMIT 1").get(name) as Record<
      string,
      unknown
    > | null;
    return row ? rowToAgent(row) : null;
  }

  /** Pin a token to an agent id on first use. Returns true when claimed. */
  claim(tokenHash: string, agentId: string, meta: AgentMeta = {}): boolean {
    const now = Date.now();
    const result = this.db
      .query(
        `UPDATE agents SET agent_id = ?, first_seen_at = ?, last_seen_at = ?,
         host = ?, os = ?, version = ?
         WHERE token_hash = ? AND agent_id IS NULL AND revoked_at IS NULL`,
      )
      .run(
        agentId,
        now,
        now,
        meta.host ?? "",
        meta.os ?? "",
        meta.version ?? "",
        tokenHash,
      );
    return Number(result.changes) === 1;
  }

  /** Refresh last-seen (and reported metadata) for a bound agent. */
  touch(agentId: string, meta: AgentMeta = {}): void {
    const sets = ["last_seen_at = ?"];
    const values: Array<string | number> = [Date.now()];
    if (meta.host !== undefined) {
      sets.push("host = ?");
      values.push(meta.host);
    }
    if (meta.os !== undefined) {
      sets.push("os = ?");
      values.push(meta.os);
    }
    if (meta.version !== undefined) {
      sets.push("version = ?");
      values.push(meta.version);
    }
    if (meta.name !== undefined) {
      sets.push("name = ?");
      values.push(meta.name);
    }
    if (meta.tags !== undefined) {
      sets.push("tags = ?");
      values.push(JSON.stringify(meta.tags));
    }
    values.push(agentId);
    this.db.query(`UPDATE agents SET ${sets.join(", ")} WHERE agent_id = ?`).run(...values);
  }

  isRevoked(agentId: string): boolean {
    const row = this.db.query("SELECT revoked_at FROM agents WHERE agent_id = ?").get(agentId) as {
      revoked_at: number | null;
    } | null;
    return row !== null && row.revoked_at !== null;
  }

  /** Revoke by agent id or name. Returns the revoked row, or null. */
  revoke(ref: string): AgentRow | null {
    const row = this.getById(ref) ?? this.getByName(ref);
    if (!row || row.revokedAt !== null) return row;
    this.db.query("UPDATE agents SET revoked_at = ? WHERE token_hash = ?").run(Date.now(), row.tokenHash);
    return this.getByTokenHash(row.tokenHash);
  }

  /** Replace the token of an enrolled agent (old token stops working). */
  rotate(ref: string): { agentId: string | null; token: string } | null {
    const row = this.getById(ref) ?? this.getByName(ref);
    if (!row) return null;
    const token = generateToken();
    this.db.query("UPDATE agents SET token_hash = ?, revoked_at = NULL WHERE token_hash = ?").run(hashToken(token), row.tokenHash);
    return { agentId: row.agentId, token };
  }

  list(): AgentRow[] {
    const rows = this.db.query("SELECT * FROM agents ORDER BY name").all() as Array<Record<string, unknown>>;
    return rows.map(rowToAgent);
  }

  close(): void {
    this.db.close();
  }
}
