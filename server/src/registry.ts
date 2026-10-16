/**
 * TokenRegistry: decides whether a `hello` token is accepted.
 *
 * Two modes, checked in order:
 * 1. Legacy shared token (`MRC_TOKEN`, dev convenience): accepted as-is, no
 *    persistence. Disabled with MRC_REQUIRE_DB_TOKENS=1.
 * 2. Per-agent tokens from the SQLite store: unknown → reject; revoked →
 *    reject; bound to another agent id → reject; unbound → bind (pin) the
 *    agent id on first use and accept.
 *
 * Everything is synchronous (bun:sqlite is sync) so the hub stays simple.
 */
import { sameSecret } from "@mrc/shared/secret";
import { generateAgentId, hashToken, type AgentMeta, type AgentStore } from "./store.ts";

export interface HelloIdentity extends AgentMeta {
  name: string;
  tags: string[];
}

export type TokenVerdict =
  | { status: "ok"; agentId: string | null; bound: boolean; name: string }
  | { status: "unknown" }
  | { status: "revoked"; agentId: string }
  | { status: "bound-elsewhere"; agentId: string };

export interface TokenRegistry {
  verify(token: string, claimedAgentId: string | null, hello: HelloIdentity): TokenVerdict;
  touch(agentId: string, meta?: AgentMeta): void;
  isRevoked(agentId: string): boolean;
  close(): void;
}

export interface RegistryOptions {
  legacyToken?: string;
  /** When false, the shared legacy token is rejected (production mode). */
  allowLegacy?: boolean;
  generateId?: () => string;
}

export function createRegistry(store: AgentStore, opts: RegistryOptions = {}): TokenRegistry {
  const allowLegacy = opts.allowLegacy ?? true;
  const generateId = opts.generateId ?? generateAgentId;

  return {
    verify(token: string, claimedAgentId: string | null, hello: HelloIdentity): TokenVerdict {
      if (allowLegacy && opts.legacyToken && sameSecret(token, opts.legacyToken)) {
        return { status: "ok", agentId: claimedAgentId, bound: false, name: hello.name };
      }

      const row = store.getByTokenHash(hashToken(token));
      if (!row) return { status: "unknown" };
      if (row.revokedAt !== null) {
        return { status: "revoked", agentId: row.agentId ?? row.name };
      }
      if (row.agentId) {
        if (claimedAgentId === null || claimedAgentId === row.agentId) {
          return { status: "ok", agentId: row.agentId, bound: false, name: row.name };
        }
        return { status: "bound-elsewhere", agentId: row.agentId };
      }

      // First use of this token: pin the agent id.
      const agentId = claimedAgentId ?? generateId();
      const meta: AgentMeta = {
        host: hello.host ?? "",
        os: hello.os ?? "",
        version: hello.version ?? "",
        name: hello.name,
        tags: hello.tags,
      };
      if (!store.claim(hashToken(token), agentId, meta)) {
        // Lost a race with another hello using the same token: re-read.
        const fresh = store.getByTokenHash(hashToken(token));
        if (fresh?.agentId && (claimedAgentId === null || claimedAgentId === fresh.agentId)) {
          return { status: "ok", agentId: fresh.agentId, bound: false, name: fresh.name };
        }
        return { status: "bound-elsewhere", agentId: fresh?.agentId ?? "another agent" };
      }
      return { status: "ok", agentId, bound: true, name: hello.name };
    },

    touch(agentId: string, meta: AgentMeta = {}): void {
      try {
        store.touch(agentId, meta);
      } catch {
        // Registry writes are best-effort; a legacy (unregistered) agent id
        // simply matches no row.
      }
    },

    isRevoked(agentId: string): boolean {
      try {
        return store.isRevoked(agentId);
      } catch {
        return false;
      }
    },

    close(): void {
      store.close();
    },
  };
}
