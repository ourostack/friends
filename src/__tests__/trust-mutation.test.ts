import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { setFriendTrust, FileFriendStore, MemoryAuditSink, setNervesEmitter } from "../index"
import type { FriendStore, FriendRecord, IdentityProvider, TrustLevel } from "../index"
import type { NervesEvent } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

class MemoryStore implements FriendStore {
  readonly records = new Map<string, FriendRecord>()
  putCalls = 0
  constructor(initial: FriendRecord[] = []) {
    for (const f of initial) this.records.set(f.id, f)
  }
  async get(id: string) {
    return this.records.get(id) ?? null
  }
  async put(id: string, record: FriendRecord) {
    this.putCalls += 1
    this.records.set(id, record)
  }
  async delete(id: string) {
    this.records.delete(id)
  }
  async findByExternalId(provider: string, externalId: string, tenantId?: string) {
    for (const r of this.records.values()) {
      if (r.externalIds.find((e) => e.provider === provider && e.externalId === externalId && e.tenantId === tenantId)) {
        return r
      }
    }
    return null
  }
  async hasAnyFriends() {
    return this.records.size > 0
  }
  async listAll() {
    return Array.from(this.records.values())
  }
}

function friend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "f-1",
    name: "Person",
    role: "stranger",
    trustLevel: "stranger",
    connections: [],
    externalIds: [{ provider: "aad" as IdentityProvider, externalId: "x1", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

describe("setFriendTrust", () => {
  it("sets both trustLevel and role to the given level and bumps updatedAt", async () => {
    const store = new MemoryStore([friend()])
    const result = await setFriendTrust(store, "f-1", "friend")
    expect(result.ok).toBe(true)
    expect(result.status).toBe("updated")
    expect(result.record?.trustLevel).toBe("friend")
    expect(result.record?.role).toBe("friend")
    const stored = await store.get("f-1")
    expect(stored?.trustLevel).toBe("friend")
    expect(stored?.role).toBe("friend")
    expect(stored?.updatedAt).not.toBe(NOW)
  })

  it("maps each of the four trust levels correctly", async () => {
    const levels: TrustLevel[] = ["family", "friend", "acquaintance", "stranger"]
    for (const level of levels) {
      const store = new MemoryStore([friend()])
      const result = await setFriendTrust(store, "f-1", level)
      expect(result.record?.trustLevel).toBe(level)
      expect(result.record?.role).toBe(level)
    }
  })

  it("returns not_found (no throw) when the friend is missing", async () => {
    const store = new MemoryStore()
    const result = await setFriendTrust(store, "missing", "friend")
    expect(result.ok).toBe(false)
    expect(result.status).toBe("not_found")
    expect(store.putCalls).toBe(0)
  })

  it("persists trust and role through a real FileFriendStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-trust-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      await store.put("f-1", friend())
      await setFriendTrust(store, "f-1", "family")
      const reloaded = await store.findByExternalId("aad", "x1")
      expect(reloaded?.trustLevel).toBe("family")
      expect(reloaded?.role).toBe("family")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Bug B — every successful trust mutation writes one append-only control-plane
// audit record through an injected sink. No sink ⇒ unchanged (no-op audit). The
// not_found early-return writes NOTHING. Self-contained: `targetDid` is ctx-only
// here; the identity.did-derived path is asserted in Unit 5b.
describe("setFriendTrust — Bug B: control-plane audit", () => {
  it("appends exactly one record on a successful mutation, with the supplied fields", async () => {
    const store = new MemoryStore([friend()])
    const sink = new MemoryAuditSink()
    const result = await setFriendTrust(store, "f-1", "friend", {
      actor: "owner-cli",
      originSense: "management",
      basis: "same_account",
      sink,
    })
    expect(result.ok).toBe(true)
    const records = sink.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      action: "set_trust",
      targetId: "f-1",
      level: "friend",
      actor: "owner-cli",
      originSense: "management",
      basis: "same_account",
    })
    expect(typeof records[0].ts).toBe("string")
  })

  it("is append-only: two sequential mutations leave two records in order (no overwrite)", async () => {
    const store = new MemoryStore([friend()])
    const sink = new MemoryAuditSink()
    await setFriendTrust(store, "f-1", "acquaintance", { actor: "a1", sink })
    await setFriendTrust(store, "f-1", "friend", { actor: "a2", sink })
    const records = sink.list()
    expect(records.map((r) => r.level)).toEqual(["acquaintance", "friend"])
    expect(records.map((r) => r.actor)).toEqual(["a1", "a2"])
  })

  it("writes NO audit record on the not_found path (audit fires only on a real mutation)", async () => {
    const store = new MemoryStore()
    const sink = new MemoryAuditSink()
    const result = await setFriendTrust(store, "missing", "friend", { actor: "a1", sink })
    expect(result.status).toBe("not_found")
    expect(sink.list()).toHaveLength(0)
  })

  it("defaults actor to the literal 'unknown' when none is supplied", async () => {
    const store = new MemoryStore([friend()])
    const sink = new MemoryAuditSink()
    await setFriendTrust(store, "f-1", "friend", { sink })
    expect(sink.list()[0].actor).toBe("unknown")
  })

  it("does not throw and still returns updated when called 3-arg (no ctx) — back-compat", async () => {
    const store = new MemoryStore([friend()])
    const result = await setFriendTrust(store, "f-1", "friend")
    expect(result.ok).toBe(true)
    expect(result.status).toBe("updated")
  })

  it("does not throw when a ctx is supplied with no sink", async () => {
    const store = new MemoryStore([friend()])
    const result = await setFriendTrust(store, "f-1", "friend", { actor: "a1" })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("updated")
  })

  it("omits targetDid when the record carries no DID hint", async () => {
    const store = new MemoryStore([friend()])
    const sink = new MemoryAuditSink()
    await setFriendTrust(store, "f-1", "friend", { sink, originSense: "x" })
    // With no DID on the record, targetDid is absent (the ?:{} false arm).
    expect(sink.list()[0].targetDid).toBeUndefined()
  })

  it("derives targetDid from the record's DID hint when present", async () => {
    // Unit 2b derives targetDid from the record's a2a.did; Unit 5b upgrades the
    // source to the identity-aware resolver (preferring identity.did).
    const agentWithDid = friend({
      id: "f-did",
      kind: "agent",
      externalIds: [{ provider: "a2a-agent" as IdentityProvider, externalId: "did:key:zPeer", linkedAt: NOW }],
      agentMeta: {
        bundleName: "peer",
        familiarity: 0,
        sharedMissions: [],
        outcomes: [],
        a2a: { agentId: "did:key:zPeer", did: "did:key:zPeer" },
      },
    })
    const store = new MemoryStore([agentWithDid])
    const sink = new MemoryAuditSink()
    await setFriendTrust(store, "f-did", "friend", { sink })
    expect(sink.list()[0].targetDid).toBe("did:key:zPeer")
  })

  it("still emits the friends.trust_set nerves event on a mutation", async () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    try {
      const store = new MemoryStore([friend()])
      await setFriendTrust(store, "f-1", "friend", { actor: "a1", sink: new MemoryAuditSink() })
      expect(seen.some((e) => e.event === "friends.trust_set")).toBe(true)
    } finally {
      setNervesEmitter(null)
    }
  })
})
