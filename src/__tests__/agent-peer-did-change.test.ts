import { describe, it, expect } from "vitest"

import { upsertAgentPeer, findFriendByDid, setNervesEmitter } from "../index"
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
  async findByExternalId(provider: string, externalId: string) {
    for (const r of this.records.values()) {
      if (r.externalIds.some((e) => e.provider === provider && e.externalId === externalId)) return r
    }
    return null
  }
  async listAll() {
    return Array.from(this.records.values())
  }
}

function familyPeer(): FriendRecord {
  return {
    id: "claude-code",
    name: "Claude Code",
    role: "agent-peer",
    trustLevel: "family",
    admissionState: "active",
    capabilityProfileId: "sanctuary-owner",
    delegationGrant: { scope: "principal_commands", grantedAt: NOW, source: "operator" },
    connections: [],
    externalIds: [
      { provider: "a2a-agent", externalId: "peer-1", linkedAt: NOW },
      { provider: "telegram-user", externalId: "42", linkedAt: NOW },
    ],
    tenantMemberships: [],
    toolPreferences: {},
    notes: { likes: { value: "tea", savedAt: NOW } },
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "agent",
    agentMeta: {
      bundleName: "claude-code",
      familiarity: 5,
      sharedMissions: [],
      outcomes: [],
      identity: { did: "did:key:GOOD", pinnedKey: "KEY" },
      a2a: { agentId: "peer-1", did: "did:key:GOOD", endpointUrl: "https://good.example/a2a", cardUrl: "https://good.example/card" },
    },
  }
}

describe("upsertAgentPeer — a DID change resets authority (audit finding 3)", () => {
  it("drops family trust, the grant and the capability profile when the DID differs", async () => {
    const store = new MemoryStore([familyPeer()])
    const events: NervesEvent[] = []
    setNervesEmitter((e) => events.push(e))
    try {
      const result = await upsertAgentPeer(store, {
        name: "Claude Code",
        agentId: "peer-1",
        a2a: { did: "did:key:EVIL", endpointUrl: "https://evil.example/a2a" },
      })
      expect(result.trustLevel).toBe("stranger")
      expect(result.admissionState).toBe("unverified")
      expect(result.capabilityProfileId).toBeUndefined()
      expect(result.delegationGrant).toBeUndefined()
      expect(result.didChanged).toBe(true)
      expect(result.previousDid).toBe("did:key:GOOD")
      expect(result.trustReset).toEqual({
        at: expect.any(String),
        reason: "did_changed",
        previousDid: "did:key:GOOD",
        previousTrust: "family",
      })
      // Kept: notes and external ids.
      expect(result.notes.likes?.value).toBe("tea")
      expect(result.externalIds.map((e) => e.externalId).sort()).toEqual(["42", "peer-1"])
      // The old endpoint and the old pin do not carry over to the new DID.
      expect(result.agentMeta?.a2a?.endpointUrl).toBe("https://evil.example/a2a")
      expect(result.agentMeta?.a2a?.cardUrl).toBeUndefined()
      expect(result.agentMeta?.identity).toBeUndefined()
      // The stored record is the reset one.
      const stored = store.records.get("claude-code")!
      expect(stored.trustLevel).toBe("stranger")
      expect(stored.delegationGrant).toBeUndefined()
      expect(stored.trustReset?.previousTrust).toBe("family")
      // The new DID resolves to the record, but only as a stranger with no authority.
      const found = await findFriendByDid(store, "did:key:EVIL")
      expect(found?.trustLevel).toBe("stranger")
      expect(found?.delegationGrant).toBeUndefined()
      const warn = events.find((e) => e.event === "friends.peer_did_changed")
      expect(warn?.level).toBe("warn")
    } finally {
      setNervesEmitter(null)
    }
  })

  it("ignores a caller-supplied trustLevel when the DID changed (no rotation exemption)", async () => {
    const store = new MemoryStore([familyPeer()])
    const result = await upsertAgentPeer(store, {
      name: "Claude Code",
      agentId: "peer-1",
      trustLevel: "family",
      a2a: { did: "did:key:EVIL" },
    })
    expect(result.trustLevel).toBe("stranger")
  })

  it("keeps trust and grant when the DID is unchanged and does not flag a change", async () => {
    const store = new MemoryStore([familyPeer()])
    const result = await upsertAgentPeer(store, {
      name: "Claude Code",
      agentId: "peer-1",
      a2a: { did: "did:key:GOOD" },
    })
    expect(result.trustLevel).toBe("family")
    expect(result.delegationGrant).toBeDefined()
    expect(result.didChanged).toBeUndefined()
    expect(result.trustReset).toBeUndefined()
  })

  it("a stranger with no profile and no DID adopting its first DID is a plain first pin", async () => {
    const record = familyPeer()
    delete record.agentMeta!.identity
    delete record.agentMeta!.a2a!.did
    record.trustLevel = "stranger"
    record.admissionState = "unverified"
    delete record.capabilityProfileId
    delete record.delegationGrant
    const store = new MemoryStore([record])
    const result = await upsertAgentPeer(store, { name: "Claude Code", agentId: "peer-1", a2a: { did: "did:key:GOOD" } })
    expect(result.trustLevel).toBe("stranger")
    expect(result.didChanged).toBeUndefined()
    expect(result.trustReset).toBeUndefined()
    expect(result.agentMeta?.a2a?.did).toBe("did:key:GOOD")
  })

  for (const [label, patch] of [
    ["family trust", { trustLevel: "family" as const }],
    ["friend trust", { trustLevel: "friend" as const }],
    ["a capability profile", { trustLevel: "stranger" as const, capabilityProfileId: "p" }],
    ["a legacy grant", { trustLevel: "stranger" as const, delegationGrant: { scope: "principal_commands" as const, grantedAt: NOW, source: "operator" } }],
    ["active admission", { trustLevel: "stranger" as const, admissionState: "active" as const }],
  ]) {
    it(`a DID-less record holding authority (${label}) loses it when it adopts its first DID`, async () => {
      const record = familyPeer()
      delete record.agentMeta!.identity
      delete record.agentMeta!.a2a!.did
      delete record.capabilityProfileId
      delete record.delegationGrant
      record.admissionState = "unverified"
      Object.assign(record, patch)
      const store = new MemoryStore([record])
      const result = await upsertAgentPeer(store, { name: "Claude Code", agentId: "peer-1", a2a: { did: "did:key:EVIL" } })
      expect(result.trustLevel).toBe("stranger")
      expect(result.admissionState).toBe("unverified")
      expect(result.capabilityProfileId).toBeUndefined()
      expect(result.delegationGrant).toBeUndefined()
      expect(result.didChanged).toBe(true)
      expect(result.previousDid).toBeUndefined()
      expect(result.trustReset?.reason).toBe("did_adopted")
      expect(result.trustReset?.previousDid).toBeUndefined()
    })
  }

  for (const empty of ["", "   "]) {
    it(`an empty DID (${JSON.stringify(empty)}) neither erases the pinned DID nor opens a bypass`, async () => {
      const store = new MemoryStore([familyPeer()])
      const first = await upsertAgentPeer(store, { name: "Claude Code", agentId: "peer-1", a2a: { did: empty } })
      expect(first.agentMeta?.a2a?.did).toBe("did:key:GOOD")
      expect(first.trustLevel).toBe("family")
      const second = await upsertAgentPeer(store, { name: "Claude Code", agentId: "peer-1", a2a: { did: "did:key:EVIL" } })
      expect(second.trustLevel).toBe("stranger")
      expect(second.delegationGrant).toBeUndefined()
      expect(second.didChanged).toBe(true)
    })
  }

  it("drops the old mailbox on a DID change unless the input supplies one", async () => {
    const record = familyPeer()
    record.agentMeta!.mailbox = { repo: "/old", selfOutboxAgentId: "a" }
    const store = new MemoryStore([record])
    const dropped = await upsertAgentPeer(store, { name: "Claude Code", agentId: "peer-1", a2a: { did: "did:key:EVIL" } })
    expect(dropped.agentMeta?.mailbox).toBeUndefined()
    const store2 = new MemoryStore([record])
    const kept = await upsertAgentPeer(store2, { name: "Claude Code", agentId: "peer-1", a2a: { did: "did:key:EVIL" }, mailbox: { repo: "/new", selfOutboxAgentId: "b" } })
    expect(kept.agentMeta?.mailbox).toEqual({ repo: "/new", selfOutboxAgentId: "b" })
  })

  it("keeps the existing DID when a re-onboard supplies no a2a", async () => {
    const store = new MemoryStore([familyPeer()])
    const result = await upsertAgentPeer(store, { name: "Claude Code", agentId: "peer-1" })
    expect(result.agentMeta?.a2a?.did).toBe("did:key:GOOD")
    expect(result.trustLevel).toBe("family")
    expect(result.didChanged).toBeUndefined()
  })

  it("reports previousTrust as stranger when the record had no trust level", async () => {
    const record = familyPeer()
    delete record.trustLevel
    const store = new MemoryStore([record])
    const result = await upsertAgentPeer(store, { name: "Claude Code", agentId: "peer-1", a2a: { did: "did:key:EVIL" } })
    expect(result.trustReset?.previousTrust).toBe("stranger")
  })
})
