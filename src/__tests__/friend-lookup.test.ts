import { describe, it, expect } from "vitest"

import { findFriendByDid, setNervesEmitter } from "../index"
import type { FriendStore, FriendRecord, NervesEvent } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

class MemoryStore implements FriendStore {
  readonly records = new Map<string, FriendRecord>()
  constructor(initial: FriendRecord[] = []) {
    for (const f of initial) this.records.set(f.id, f)
  }
  async get(id: string) {
    return this.records.get(id) ?? null
  }
  async put(id: string, record: FriendRecord) {
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
  async listAll() {
    return Array.from(this.records.values())
  }
}

/** A store that deliberately omits the optional listAll method. */
class NoListAllStore implements FriendStore {
  async get() {
    return null
  }
  async put() {}
  async delete() {}
  async findByExternalId() {
    return null
  }
}

function agent(overrides: Partial<FriendRecord> = {}, agentMeta?: FriendRecord["agentMeta"]): FriendRecord {
  return {
    id: "f-1",
    name: "Peer",
    role: "agent-peer",
    trustLevel: "stranger",
    connections: [],
    externalIds: [{ provider: "a2a-agent", externalId: "did:key:zPeer", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "agent",
    agentMeta: agentMeta ?? {
      bundleName: "peer",
      familiarity: 0,
      sharedMissions: [],
      outcomes: [],
    },
    ...overrides,
  }
}

describe("findFriendByDid", () => {
  it("finds a record by its durable identity.did", async () => {
    const store = new MemoryStore([
      agent({ id: "f-1" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zHome" } }),
    ])
    const found = await findFriendByDid(store, "did:key:zHome")
    expect(found?.id).toBe("f-1")
  })

  it("finds a record by a migrated legacy a2a.did (via resolveAgentIdentity)", async () => {
    const store = new MemoryStore([
      agent({ id: "f-2" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], a2a: { did: "did:key:zLegacy", agentId: "did:key:zLegacy" } }),
    ])
    const found = await findFriendByDid(store, "did:key:zLegacy")
    expect(found?.id).toBe("f-2")
  })

  it("does not match a did-less record against a did query", async () => {
    const store = new MemoryStore([
      agent({ id: "f-3" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], a2a: { agentId: "peer-1" } }),
    ])
    expect(await findFriendByDid(store, "did:key:zNope")).toBeNull()
  })

  // SECURITY (finding 5, MEDIUM): a duplicate did is an anomaly, and the tie-break
  // must NOT reward back-dating. The old rule (lowest createdAt wins) let an attacker
  // mint a duplicate-did record with an earlier createdAt to silently shadow a legit
  // record. The new rule: warn loudly, prefer a trust-relevant signal (a pinned/
  // verified record), and use a STABLE non-temporal tie-break (lowest id) otherwise.
  it("on a duplicate did, prefers the pinned/verified record even when an attacker back-dates createdAt", async () => {
    // Attacker record: NO pinnedKey, but a back-dated (earlier) createdAt to try to win.
    const attacker = agent(
      { id: "f-attacker", createdAt: "2020-01-01T00:00:00.000Z" },
      { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } },
    )
    // Legit record: a TOFU-pinned key (the trust-relevant signal), later createdAt.
    const legit = agent(
      { id: "f-legit", createdAt: "2026-03-01T00:00:00.000Z" },
      { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup", pinnedKey: "k-pinned" } },
    )
    const store = new MemoryStore([attacker, legit])
    const found = await findFriendByDid(store, "did:key:zDup")
    // The pinned record wins despite the attacker's earlier createdAt.
    expect(found?.id).toBe("f-legit")
  })

  it("emits a loud (warn-level) anomaly warning when a duplicate did is detected", async () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    try {
      const a = agent({ id: "f-a" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } })
      const b = agent({ id: "f-b" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } })
      const store = new MemoryStore([a, b])
      await findFriendByDid(store, "did:key:zDup")
      const warns = seen.filter((e) => e.level === "warn" && e.event === "friends.duplicate_did")
      expect(warns).toHaveLength(1)
      expect(warns[0].meta?.did).toBe("did:key:zDup")
    } finally {
      setNervesEmitter(null)
    }
  })

  it("does NOT warn for a unique did (no anomaly)", async () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    try {
      const store = new MemoryStore([
        agent({ id: "f-1" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zSolo" } }),
      ])
      await findFriendByDid(store, "did:key:zSolo")
      expect(seen.filter((e) => e.event === "friends.duplicate_did")).toHaveLength(0)
    } finally {
      setNervesEmitter(null)
    }
  })

  it("uses a stable lowest-id tie-break (not createdAt) when neither duplicate is pinned", async () => {
    // Both unpinned: createdAt must NOT decide it. f-aaa has a LATER createdAt but a
    // lower id, and still wins — proving the tie-break is non-temporal (back-date-proof).
    const lowerId = agent(
      { id: "f-aaa", createdAt: "2026-12-01T00:00:00.000Z" },
      { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } },
    )
    const higherId = agent(
      { id: "f-zzz", createdAt: "2020-01-01T00:00:00.000Z" },
      { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } },
    )
    // Storage order: higherId first, then lowerId — exercises both comparison arms.
    const store = new MemoryStore([higherId, lowerId])
    const found = await findFriendByDid(store, "did:key:zDup")
    expect(found?.id).toBe("f-aaa")
  })

  it("keeps the pinned record when it appears AFTER an unpinned duplicate in storage order", async () => {
    // Storage order: unpinned first, pinned second — exercises the 'replace current
    // best because the candidate is pinned' arm.
    const unpinned = agent({ id: "f-unpinned" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } })
    const pinned = agent({ id: "f-pinned" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup", pinnedKey: "k" } })
    const store = new MemoryStore([unpinned, pinned])
    const found = await findFriendByDid(store, "did:key:zDup")
    expect(found?.id).toBe("f-pinned")
  })

  it("keeps the first pinned record when a SECOND, lower-id pinned duplicate appears (pinned ties break by id)", async () => {
    const pinnedHigh = agent({ id: "f-pinned-z" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup", pinnedKey: "k1" } })
    const pinnedLow = agent({ id: "f-pinned-a" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup", pinnedKey: "k2" } })
    // pinnedHigh first, then pinnedLow — both pinned, so the lower id wins.
    const store = new MemoryStore([pinnedHigh, pinnedLow])
    const found = await findFriendByDid(store, "did:key:zDup")
    expect(found?.id).toBe("f-pinned-a")
  })

  it("does not replace a pinned best with a later unpinned duplicate (pinned beats unpinned regardless of order/id)", async () => {
    const pinned = agent({ id: "f-pinned-z" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup", pinnedKey: "k" } })
    // Lower id but unpinned, appears second → must NOT win over the pinned record.
    const unpinnedLowId = agent({ id: "f-aaa" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } })
    const store = new MemoryStore([pinned, unpinnedLowId])
    const found = await findFriendByDid(store, "did:key:zDup")
    expect(found?.id).toBe("f-pinned-z")
  })

  it("returns null for a store with no listAll method", async () => {
    const store = new NoListAllStore()
    expect(await findFriendByDid(store, "did:key:zAny")).toBeNull()
  })

  // SECURITY (finding 4, MEDIUM): a falsy did query must never match a did-less
  // record. Previously findFriendByDid(store, undefined|"") returned the first
  // did-less record (undefined !== undefined is false → treated as a match), so an
  // absent/empty query silently resolved to an unrelated peer.
  it("returns null for an undefined did query even when did-less records exist", async () => {
    const store = new MemoryStore([
      agent({ id: "f-nodid" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], a2a: { agentId: "peer-1" } }),
    ])
    expect(await findFriendByDid(store, undefined as unknown as string)).toBeNull()
  })

  it("returns null for an empty-string did query even when did-less records exist", async () => {
    const store = new MemoryStore([
      agent({ id: "f-nodid" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], a2a: { agentId: "peer-1" } }),
    ])
    expect(await findFriendByDid(store, "")).toBeNull()
  })

  it("never matches a record whose RESOLVED did is empty-string, even on a real did query", async () => {
    // A record carrying an empty-string identity.did must not be a matchable key.
    const store = new MemoryStore([
      agent({ id: "f-emptydid" }, { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "" } }),
    ])
    expect(await findFriendByDid(store, "")).toBeNull()
    expect(await findFriendByDid(store, "did:key:zReal")).toBeNull()
  })
})
