import { describe, it, expect } from "vitest"

import { prepareMissionShare, importMissionShare } from "../index"
import type {
  FriendStore,
  GrantStore,
  MissionStore,
  FriendRecord,
  ShareGrant,
  MissionRecord,
  MissionShareEnvelope,
  IdentityProvider,
  AgentVerifier,
} from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

// ── In-file fakes (the project idiom) ──

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
      if (r.externalIds.find((e) => e.provider === provider && e.externalId === externalId && (tenantId === undefined || e.tenantId === tenantId))) {
        return r
      }
    }
    return null
  }
  async listAll() {
    return Array.from(this.records.values())
  }
}

class MemoryGrantStore implements GrantStore {
  readonly grants = new Map<string, ShareGrant>()
  constructor(initial: ShareGrant[] = []) {
    for (const g of initial) this.grants.set(g.id, g)
  }
  async get(id: string) {
    return this.grants.get(id) ?? null
  }
  async put(id: string, grant: ShareGrant) {
    this.grants.set(id, grant)
  }
  async delete(id: string) {
    this.grants.delete(id)
  }
  async listAll() {
    return Array.from(this.grants.values())
  }
}

class MemoryMissionStore implements MissionStore {
  readonly missions = new Map<string, MissionRecord>()
  putCalls = 0
  constructor(initial: MissionRecord[] = []) {
    for (const m of initial) this.missions.set(m.id, m)
  }
  async get(id: string) {
    return this.missions.get(id) ?? null
  }
  async put(id: string, mission: MissionRecord) {
    this.putCalls += 1
    this.missions.set(id, mission)
  }
  async delete(id: string) {
    this.missions.delete(id)
  }
  async findByMissionKey(missionKey: string) {
    for (const m of this.missions.values()) {
      if (m.missionKey === missionKey) return m
    }
    return null
  }
  async listAll() {
    return Array.from(this.missions.values())
  }
}

// ── Fixtures ──

function mission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: "m-local-uuid",
    missionKey: "PROJ-1234",
    title: "Ship the ledger",
    status: "active",
    participants: [{ agentId: "agent-self" }],
    outcomes: [],
    learnings: {
      gotcha: { value: "rebase not merge", savedAt: NOW, shareable: true, provenance: { origin: "first_party" } },
      secret: { value: "private detail", savedAt: NOW, shareable: false, provenance: { origin: "first_party" } },
    },
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

function recipientAgent(trustLevel: FriendRecord["trustLevel"], agentId = "agent-b"): FriendRecord {
  return {
    id: `rec-${agentId}`,
    name: "Recipient",
    role: "agent-peer",
    trustLevel,
    connections: [],
    externalIds: [{ provider: "a2a-agent" as IdentityProvider, externalId: agentId, linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "agent",
  }
}

function missionGrant(scope: ShareGrant["scope"], overrides: Partial<ShareGrant> = {}): ShareGrant {
  return {
    id: "g-1",
    subjectKey: "PROJ-1234", // keyed by the missionKey, NOT the local UUID
    recipientAgentId: "agent-b",
    scope,
    grantedAt: NOW,
    ...overrides,
  }
}

function envelope(overrides: Partial<MissionShareEnvelope> = {}): MissionShareEnvelope {
  return {
    subject: { missionKey: "PROJ-1234", title: "Ship the ledger" },
    fromAgentId: "agent-a",
    scope: "mission",
    learnings: [{ key: "gotcha", value: "rebase not merge", originallyAssertedBy: { agentId: "agent-a" } }],
    issuedAt: NOW,
    ...overrides,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PRODUCER — prepareMissionShare
// ════════════════════════════════════════════════════════════════════════════

describe("prepareMissionShare — producer", () => {
  it("returns not_found when the missionId does not resolve", async () => {
    const missions = new MemoryMissionStore()
    const store = new MemoryStore()
    const grants = new MemoryGrantStore()
    const result = await prepareMissionShare(missions, store, grants, {
      missionId: "ghost",
      toAgentId: "agent-b",
      scope: "mission",
      selfAgentId: "agent-self",
    })
    expect(result).toEqual({ ok: false, status: "not_found" })
  })

  it("returns no_consent for scope mission with NO grant (tiered: content needs an explicit grant)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const store = new MemoryStore([recipientAgent("friend")])
    const grants = new MemoryGrantStore()
    const result = await prepareMissionShare(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      scope: "mission",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("no_consent")
  })

  it("defaults an unknown recipient to stranger (refused on a content scope)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const store = new MemoryStore() // no recipient record
    const grants = new MemoryGrantStore()
    const result = await prepareMissionShare(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "unknown-agent",
      scope: "mission",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("no_consent")
  })

  it("with a mission-scoped grant (keyed by missionKey): carries ONLY shareable learnings, attributed to self", async () => {
    const missions = new MemoryMissionStore([mission()])
    const store = new MemoryStore([recipientAgent("friend")])
    const grants = new MemoryGrantStore([missionGrant("mission")])
    const result = await prepareMissionShare(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      scope: "mission",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Only the shareable learning is carried; the private one is withheld.
      expect(result.envelope.learnings).toHaveLength(1)
      expect(result.envelope.learnings![0].key).toBe("gotcha")
      expect(result.envelope.learnings![0].value).toBe("rebase not merge")
      // First-party learning attributed to self (no laundering).
      expect(result.envelope.learnings![0].originallyAssertedBy).toEqual({ agentId: "agent-self" })
      // The private learning's value never appears anywhere in the envelope.
      expect(JSON.stringify(result.envelope)).not.toContain("private detail")
      // mission scope carries no outcomes.
      expect(result.envelope.outcomes).toBeUndefined()
    }
  })

  it("preserves originallyAssertedBy for an imported learning (never laundered to self)", async () => {
    const missions = new MemoryMissionStore([
      mission({
        learnings: {
          relayed: {
            value: "from elsewhere",
            savedAt: NOW,
            shareable: true,
            provenance: { origin: "imported", assertedBy: { agentId: "origin-agent", agentName: "Origin" } },
          },
        },
      }),
    ])
    const store = new MemoryStore([recipientAgent("friend")])
    const grants = new MemoryGrantStore([missionGrant("mission")])
    const result = await prepareMissionShare(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      scope: "mission",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.learnings![0].originallyAssertedBy).toEqual({ agentId: "origin-agent", agentName: "Origin" })
    }
  })

  it("private-only learnings (nothing shareable) yields an empty learnings array on a mission share", async () => {
    const missions = new MemoryMissionStore([
      mission({ learnings: { secret: { value: "private", savedAt: NOW, shareable: false } } }),
    ])
    const store = new MemoryStore([recipientAgent("friend")])
    const grants = new MemoryGrantStore([missionGrant("mission")])
    const result = await prepareMissionShare(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      scope: "mission",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.envelope.learnings).toEqual([])
  })

  it("outcomes scope carries the mission's outcomes and NO learnings", async () => {
    const missions = new MemoryMissionStore([
      mission({ outcomes: [{ missionId: "m-local-uuid", result: "success", timestamp: NOW }] }),
    ])
    const store = new MemoryStore([recipientAgent("friend")])
    const grants = new MemoryGrantStore([missionGrant("outcomes")])
    const result = await prepareMissionShare(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      scope: "outcomes",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.outcomes).toHaveLength(1)
      expect(result.envelope.outcomes![0].missionId).toBe("m-local-uuid")
      expect(result.envelope.learnings).toBeUndefined()
    }
  })

  it("names the mission by missionKey + title, NEVER the local UUID", async () => {
    const missions = new MemoryMissionStore([mission()])
    const store = new MemoryStore([recipientAgent("friend")])
    const grants = new MemoryGrantStore([missionGrant("mission")])
    const result = await prepareMissionShare(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      scope: "mission",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.subject.missionKey).toBe("PROJ-1234")
      expect(result.envelope.subject.title).toBe("Ship the ledger")
      // The local UUID must never leak onto the wire.
      expect(JSON.stringify(result.envelope)).not.toContain("m-local-uuid")
      expect(result.envelope.fromAgentId).toBe("agent-self")
    }
  })

  it("stamps the proof slot when provided and omits it otherwise", async () => {
    const missions = new MemoryMissionStore([mission()])
    const store = new MemoryStore([recipientAgent("friend")])
    const grants = new MemoryGrantStore([missionGrant("mission")])
    const withProof = await prepareMissionShare(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      scope: "mission",
      selfAgentId: "agent-self",
      proof: "sig-xyz",
    })
    expect(withProof.ok).toBe(true)
    if (withProof.ok) expect(withProof.envelope.proof).toBe("sig-xyz")

    const withoutProof = await prepareMissionShare(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      scope: "mission",
      selfAgentId: "agent-self",
    })
    expect(withoutProof.ok).toBe(true)
    if (withoutProof.ok) expect("proof" in withoutProof.envelope).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// CONSUMER — importMissionShare (the non-clobbering merge)
// ════════════════════════════════════════════════════════════════════════════

describe("importMissionShare — consumer (the non-clobbering merge)", () => {
  it("refuses when the source trust is below the acceptance floor (stranger) and the mission is known", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await importMissionShare(missions, {
      envelope: envelope(),
      fromAgentId: "agent-a",
      trustOfSource: "stranger",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
    expect(missions.putCalls).toBe(0)
  })

  it("refuses when the verifier rejects the source, even at high trust", async () => {
    const denyVerifier: AgentVerifier = { verify: () => false }
    const missions = new MemoryMissionStore([mission()])
    const result = await importMissionShare(
      missions,
      { envelope: envelope(), fromAgentId: "agent-a", trustOfSource: "family" },
      { verifier: denyVerifier },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
  })

  it("resolves by findByMissionKey and lands imported learnings WITHOUT touching first-party learnings", async () => {
    const missions = new MemoryMissionStore([
      mission({
        learnings: { gotcha: { value: "FIRST-PARTY", savedAt: NOW, provenance: { origin: "first_party" } } },
      }),
    ])
    const result = await importMissionShare(missions, {
      envelope: envelope({ learnings: [{ key: "gotcha", value: "IMPORTED", originallyAssertedBy: { agentId: "origin" } }] }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("imported")
      expect(result.record.id).toBe("m-local-uuid")
      // First-party learning physically untouched.
      expect(result.record.learnings.gotcha.value).toBe("FIRST-PARTY")
      // Imported learning lives in the separate namespace under the source agentId.
      const imported = result.record.importedLearnings!["agent-a"].gotcha
      expect(imported.value).toBe("IMPORTED")
      expect(imported.assertedBy).toEqual({ agentId: "agent-a" })
      expect(imported.originallyAssertedBy).toEqual({ agentId: "origin" })
      expect(imported.importedAt).toBeTruthy()
    }
  })

  it("an import with no learnings leaves importedLearnings unchanged", async () => {
    const missions = new MemoryMissionStore([
      mission({ importedLearnings: { x: { k: { value: "v", importedAt: NOW } } } }),
    ])
    const result = await importMissionShare(missions, {
      envelope: envelope({ scope: "outcomes", learnings: undefined, outcomes: [] }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.importedLearnings).toEqual({ x: { k: { value: "v", importedAt: NOW } } })
  })

  it("an empty learnings array does not create an importedLearnings slot", async () => {
    const missions = new MemoryMissionStore([mission({ importedLearnings: {} })])
    const result = await importMissionShare(missions, {
      envelope: envelope({ learnings: [] }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.importedLearnings).toEqual({})
  })

  it("merges a second import from a DIFFERENT agent into its own namespace slot", async () => {
    const missions = new MemoryMissionStore([
      mission({ importedLearnings: { "other-agent": { city: { value: "Seattle", importedAt: NOW } } } }),
    ])
    const result = await importMissionShare(missions, {
      envelope: envelope({ learnings: [{ key: "gotcha", value: "from-a" }] }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.importedLearnings!["other-agent"].city.value).toBe("Seattle")
      expect(result.record.importedLearnings!["agent-a"].gotcha.value).toBe("from-a")
    }
  })

  it("status / participants are NEVER recomputed from an import (non-transitive)", async () => {
    const missions = new MemoryMissionStore([
      mission({ status: "active", participants: [{ agentId: "agent-self" }] }),
    ])
    const result = await importMissionShare(missions, {
      // The peer envelope can't even carry status/participants — assert the local stays put.
      envelope: envelope(),
      fromAgentId: "agent-a",
      trustOfSource: "family",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.status).toBe("active")
      expect(result.record.participants).toEqual([{ agentId: "agent-self" }])
    }
  })

  // ── Outcome merge (the genuinely-new logic) ──

  it("appends + stamps imported outcomes with origin:imported + assertedBy + importedAt", async () => {
    const missions = new MemoryMissionStore([mission({ outcomes: [] })])
    const result = await importMissionShare(missions, {
      envelope: envelope({
        scope: "outcomes",
        learnings: undefined,
        outcomes: [{ missionId: "ext-1", result: "success", timestamp: "2026-05-01T00:00:00.000Z" }],
      }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.outcomes).toHaveLength(1)
      const o = result.record.outcomes[0]
      expect(o.missionId).toBe("ext-1")
      expect(o.provenance?.origin).toBe("imported")
      expect(o.provenance?.assertedBy).toEqual({ agentId: "agent-a" })
      expect(o.provenance?.importedAt).toBeTruthy()
    }
  })

  it("dedupe: a SAME-peer duplicate outcome row (missionId,timestamp,assertedBy.agentId) is idempotent", async () => {
    const missions = new MemoryMissionStore([
      mission({
        outcomes: [
          {
            missionId: "ext-1",
            result: "success",
            timestamp: "2026-05-01T00:00:00.000Z",
            provenance: { origin: "imported", assertedBy: { agentId: "agent-a" }, importedAt: NOW },
          },
        ],
      }),
    ])
    const result = await importMissionShare(missions, {
      envelope: envelope({
        scope: "outcomes",
        learnings: undefined,
        outcomes: [{ missionId: "ext-1", result: "success", timestamp: "2026-05-01T00:00:00.000Z" }],
      }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.outcomes).toHaveLength(1) // NOT re-appended
  })

  it("dedupe: a DIFFERENT-peer row with the same (missionId,timestamp) COEXISTS", async () => {
    const missions = new MemoryMissionStore([
      mission({
        outcomes: [
          {
            missionId: "ext-1",
            result: "success",
            timestamp: "2026-05-01T00:00:00.000Z",
            provenance: { origin: "imported", assertedBy: { agentId: "agent-other" }, importedAt: NOW },
          },
        ],
      }),
    ])
    const result = await importMissionShare(missions, {
      envelope: envelope({
        scope: "outcomes",
        learnings: undefined,
        outcomes: [{ missionId: "ext-1", result: "success", timestamp: "2026-05-01T00:00:00.000Z" }],
      }),
      fromAgentId: "agent-a", // a different peer than agent-other
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.outcomes).toHaveLength(2)
      expect(result.record.outcomes.map((o) => o.provenance?.assertedBy?.agentId).sort()).toEqual(["agent-a", "agent-other"])
    }
  })

  it("dedupe: an existing FIRST-PARTY outcome with NO provenance is never spuriously matched/dropped", async () => {
    const missions = new MemoryMissionStore([
      mission({
        // A first-party outcome lacking provenance entirely — assertedBy?.agentId is undefined.
        outcomes: [{ missionId: "ext-1", result: "partial", timestamp: "2026-05-01T00:00:00.000Z" }],
      }),
    ])
    const result = await importMissionShare(missions, {
      envelope: envelope({
        scope: "outcomes",
        learnings: undefined,
        outcomes: [{ missionId: "ext-1", result: "success", timestamp: "2026-05-01T00:00:00.000Z" }],
      }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // The first-party row survives; the imported row is appended (different assertedBy).
      expect(result.record.outcomes).toHaveLength(2)
      const firstParty = result.record.outcomes.find((o) => o.provenance === undefined)
      expect(firstParty?.result).toBe("partial")
      const imported = result.record.outcomes.find((o) => o.provenance?.assertedBy?.agentId === "agent-a")
      expect(imported?.result).toBe("success")
    }
  })

  // ── Seeding gate (unknown mission) ──

  it("seeds an unknown mission when a FRIEND peer introduces it (status active, empty first-party learnings)", async () => {
    const missions = new MemoryMissionStore() // unknown mission
    const result = await importMissionShare(missions, {
      envelope: envelope({ learnings: [{ key: "gotcha", value: "from-a", originallyAssertedBy: { agentId: "origin" } }] }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("seeded")
      expect(result.record.missionKey).toBe("PROJ-1234")
      expect(result.record.title).toBe("Ship the ledger")
      expect(result.record.status).toBe("active")
      // First-party learnings start empty; the imported fact lands in the namespace.
      expect(result.record.learnings).toEqual({})
      expect(result.record.importedLearnings!["agent-a"].gotcha.value).toBe("from-a")
    }
    expect(missions.putCalls).toBe(1)
  })

  it("seeds an unknown mission when a FAMILY peer introduces it", async () => {
    const missions = new MemoryMissionStore()
    const result = await importMissionShare(missions, {
      envelope: envelope({ scope: "outcomes", learnings: undefined, outcomes: [] }),
      fromAgentId: "agent-a",
      trustOfSource: "family",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("seeded")
      expect(result.record.importedLearnings).toEqual({})
    }
  })

  it("seeds an unknown mission carrying imported outcomes (stamped imported)", async () => {
    const missions = new MemoryMissionStore()
    const result = await importMissionShare(missions, {
      envelope: envelope({
        scope: "outcomes",
        learnings: undefined,
        outcomes: [{ missionId: "ext-1", result: "success", timestamp: "2026-05-01T00:00:00.000Z" }],
      }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("seeded")
      expect(result.record.outcomes).toHaveLength(1)
      expect(result.record.outcomes[0].provenance?.origin).toBe("imported")
      expect(result.record.outcomes[0].provenance?.assertedBy).toEqual({ agentId: "agent-a" })
    }
  })

  it("untrusted_introduction for an ACQUAINTANCE source introducing an unknown mission", async () => {
    const missions = new MemoryMissionStore()
    const result = await importMissionShare(missions, {
      envelope: envelope(),
      fromAgentId: "agent-a",
      trustOfSource: "acquaintance",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_introduction")
    expect(missions.putCalls).toBe(0)
  })

  it("untrusted_source for a STRANGER source introducing an unknown mission (refused at the accept cap)", async () => {
    const missions = new MemoryMissionStore()
    const result = await importMissionShare(missions, {
      envelope: envelope(),
      fromAgentId: "agent-a",
      trustOfSource: "stranger",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
    expect(missions.putCalls).toBe(0)
  })

  it("honors a custom minTrustToAccept (raising the floor to friend)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await importMissionShare(
      missions,
      { envelope: envelope(), fromAgentId: "agent-a", trustOfSource: "acquaintance" },
      { minTrustToAccept: "friend" },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
  })

  it("accepts a verified source carrying a proof via a custom verifier (TOFU seam)", async () => {
    const proofVerifier: AgentVerifier = { verify: (_id, proof) => proof === "ok" }
    const missions = new MemoryMissionStore([mission()])
    const result = await importMissionShare(
      missions,
      { envelope: envelope({ proof: "ok" }), fromAgentId: "agent-a", trustOfSource: "friend" },
      { verifier: proofVerifier },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.status).toBe("imported")
  })
})
