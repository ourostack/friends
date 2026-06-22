import { describe, it, expect } from "vitest"

import { findFriendByDid } from "../index"
import type { FriendStore, FriendRecord } from "../index"

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

  it("on a duplicate did, returns the record with the LOWEST createdAt (stable tie-break)", async () => {
    const earliest = agent(
      { id: "f-early", createdAt: "2026-01-01T00:00:00.000Z" },
      { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } },
    )
    const middle = agent(
      { id: "f-mid", createdAt: "2026-02-01T00:00:00.000Z" },
      { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } },
    )
    const latest = agent(
      { id: "f-late", createdAt: "2026-03-01T00:00:00.000Z" },
      { bundleName: "p", familiarity: 0, sharedMissions: [], outcomes: [], identity: { did: "did:key:zDup" } },
    )
    // Order: latest, earliest, middle — exercises BOTH comparison arms (a later
    // record that beats the current best, AND a later record that does NOT), and
    // proves the tie-break is by createdAt, not storage order.
    const store = new MemoryStore([latest, earliest, middle])
    const found = await findFriendByDid(store, "did:key:zDup")
    expect(found?.id).toBe("f-early")
  })

  it("returns null for a store with no listAll method", async () => {
    const store = new NoListAllStore()
    expect(await findFriendByDid(store, "did:key:zAny")).toBeNull()
  })
})
