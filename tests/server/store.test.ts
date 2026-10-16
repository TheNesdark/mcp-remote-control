import { expect, test } from "bun:test";
import { createRegistry } from "../../server/src/registry.ts";
import { AgentStore, generateToken, hashToken, StoreError } from "../../server/src/store.ts";

const HELLO = { name: "PC-01", host: "h", os: "Windows", version: "0.4.0", tags: ["oficina"] };

test("addAgent enrolls with a one-time token and binds on first use", () => {
  const store = new AgentStore(":memory:");
  try {
    const enrolled = store.addAgent({ name: "PC-01", tags: ["oficina"] });
    expect(enrolled.agentId).toBeNull();
    expect(enrolled.token.startsWith("mrc_")).toBe(true);

    const registry = createRegistry(store, { allowLegacy: false });
    const first = registry.verify(enrolled.token, null, HELLO);
    expect(first.status).toBe("ok");
    if (first.status !== "ok") throw new Error("unreachable");
    expect(first.bound).toBe(true);
    const agentId = first.agentId!;
    expect(agentId.startsWith("ag_")).toBe(true);

    // The token hash (not the token) is what is stored.
    const row = store.getByTokenHash(hashToken(enrolled.token));
    expect(row?.agentId).toBe(agentId);
    expect(row?.name).toBe("PC-01");
    expect(row?.firstSeenAt).not.toBeNull();

    // Second hello with the same id is fine; another id is rejected.
    expect(registry.verify(enrolled.token, agentId, HELLO).status).toBe("ok");
    expect(registry.verify(enrolled.token, null, HELLO).status).toBe("ok");
    const elsewhere = registry.verify(enrolled.token, "ag_other", HELLO);
    expect(elsewhere.status).toBe("bound-elsewhere");
    if (elsewhere.status === "bound-elsewhere") expect(elsewhere.agentId).toBe(agentId);
  } finally {
    store.close();
  }
});

test("addAgent rejects duplicate active names", () => {
  const store = new AgentStore(":memory:");
  try {
    store.addAgent({ name: "PC-01" });
    expect(() => store.addAgent({ name: "pc-01" })).toThrow(StoreError);
    // After revoking, the name can be reused.
    store.revoke("PC-01");
    const reused = store.addAgent({ name: "PC-01" });
    expect(reused.token.startsWith("mrc_")).toBe(true);
  } finally {
    store.close();
  }
});

test("revoke rejects the token and rotate replaces it", () => {
  const store = new AgentStore(":memory:");
  try {
    const enrolled = store.addAgent({ name: "PC-02" });
    const registry = createRegistry(store, { allowLegacy: false });
    const first = registry.verify(enrolled.token, "ag_fixed", HELLO);
    expect(first.status).toBe("ok");

    const revoked = store.revoke("PC-02");
    expect(revoked?.revokedAt).not.toBeNull();
    const verdict = registry.verify(enrolled.token, "ag_fixed", HELLO);
    expect(verdict.status).toBe("revoked");

    const rotated = store.rotate("PC-02");
    expect(rotated?.token).not.toBe(enrolled.token);
    expect(registry.verify(rotated!.token, rotated!.agentId, HELLO).status).toBe("ok");
    // The old token no longer exists.
    expect(registry.verify(enrolled.token, "ag_fixed", HELLO).status).toBe("unknown");
  } finally {
    store.close();
  }
});

test("unknown tokens are rejected and legacy mode is opt-out", () => {
  const store = new AgentStore(":memory:");
  try {
    const strict = createRegistry(store, { legacyToken: "shared", allowLegacy: false });
    expect(strict.verify("shared", null, HELLO).status).toBe("unknown");
    expect(strict.verify(generateToken(), null, HELLO).status).toBe("unknown");

    const lax = createRegistry(store, { legacyToken: "shared", allowLegacy: true });
    const verdict = lax.verify("shared", null, HELLO);
    expect(verdict.status).toBe("ok");
    expect(lax.verify("nope", null, HELLO).status).toBe("unknown");
  } finally {
    store.close();
  }
});

test("pre-bound ids from agent add --id are honored", () => {
  const store = new AgentStore(":memory:");
  try {
    const enrolled = store.addAgent({ name: "PC-03", agentId: "ag_custom" });
    expect(enrolled.agentId).toBe("ag_custom");
    const registry = createRegistry(store, { allowLegacy: false });
    expect(registry.verify(enrolled.token, null, HELLO)).toMatchObject({ status: "ok", agentId: "ag_custom" });
    expect(registry.verify(enrolled.token, "ag_other", HELLO).status).toBe("bound-elsewhere");
  } finally {
    store.close();
  }
});
