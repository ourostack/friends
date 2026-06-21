import { describe, it, expect } from "vitest"

import { prepareCoordination, importCoordination } from "../index"
import { strictPolicy } from "../index"
import type {
  FriendStore,
  GrantStore,
  MissionStore,
  FriendRecord,
  ShareGrant,
  MissionRecord,
  CoordinationEnvelope,
  IdentityProvider,
  AgentVerifier,
} from "../index"

const NOW = "2026-03-14T18:00:00.000Z"
const LATER = "2026-03-14T19:00:00.000Z"
const EARLIER = "2026-03-14T17:00:00.000Z"

// ── In-file fakes (the project idiom, mirrored from mission-share.test.ts) ──

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

function coordinateGrant(overrides: Partial<ShareGrant> = {}): ShareGrant {
  return {
    id: "g-1",
    subjectKey: "PROJ-1234",
    recipientAgentId: "agent-b",
    scope: "coordinate",
    grantedAt: NOW,
    ...overrides,
  }
}

function envelope(overrides: Partial<CoordinationEnvelope> = {}): CoordinationEnvelope {
  return {
    subject: { missionKey: "PROJ-1234", title: "Ship the ledger" },
    fromAgentId: "agent-a",
    intent: "request",
    issuedAt: NOW,
    ...overrides,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PRODUCER — prepareCoordination
// ════════════════════════════════════════════════════════════════════════════

describe("prepareCoordination — producer", () => {
  it("returns not_found when the missionId does not resolve", async () => {
    const result = await prepareCoordination(new MemoryMissionStore(), new MemoryStore(), new MemoryGrantStore(), {
      missionId: "ghost",
      toAgentId: "agent-b",
      intent: "request",
      selfAgentId: "agent-self",
    })
    expect(result).toEqual({ ok: false, status: "not_found" })
  })

  it("a friend recipient consents at the identity tier (coordinate is an IDENTITY_SCOPE — no grant needed)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "request",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.intent).toBe("request")
      expect(result.envelope.subject.missionKey).toBe("PROJ-1234")
    }
  })

  it("an acquaintance recipient with NO grant is refused (no_consent — below the identity-tier floor)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("acquaintance")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "request",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("no_consent")
  })

  it("defaults an unknown recipient to stranger (refused with no_consent)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(missions, new MemoryStore(), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "unknown-agent",
      intent: "request",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("no_consent")
  })

  it("under the strict policy an explicit 'coordinate' grant unblocks even an acquaintance recipient", async () => {
    // Under the tiered DEFAULT, `coordinate` is an identity-tier scope gated on
    // trust alone (a grant is irrelevant). Under the strict policy the explicit-
    // grant path is what consents — the "coordinate" grant is a real grant subject.
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(
      missions,
      new MemoryStore([recipientAgent("acquaintance")]),
      new MemoryGrantStore([coordinateGrant()]),
      { missionId: "m-local-uuid", toAgentId: "agent-b", intent: "request", selfAgentId: "agent-self" },
      strictPolicy,
    )
    expect(result.ok).toBe(true)
  })

  it("under the strict policy a friend recipient still needs an explicit grant (no_consent without one)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(
      missions,
      new MemoryStore([recipientAgent("friend")]),
      new MemoryGrantStore(),
      { missionId: "m-local-uuid", toAgentId: "agent-b", intent: "request", selfAgentId: "agent-self" },
      strictPolicy,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("no_consent")
  })

  it("a request appends a first-party log entry to the producer's own mission (no assignee change)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "request",
      note: "can you take the API side?",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    const stored = await missions.get("m-local-uuid")
    expect(stored!.coordination!.log).toHaveLength(1)
    expect(stored!.coordination!.log[0]).toMatchObject({
      intent: "request",
      fromAgentId: "agent-self",
      note: "can you take the API side?",
      provenance: { origin: "first_party" },
    })
    expect(stored!.coordination!.assignee).toBeUndefined()
  })

  it("an offer with no note omits the note field on the logged entry + the envelope", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "offer",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect("note" in result.envelope).toBe(false)
    const stored = await missions.get("m-local-uuid")
    expect("note" in stored!.coordination!.log[0]).toBe(false)
  })

  it("an accept claims the assignment for self (assignee=self, assignedAt set) and logs first-party", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "accept",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    const stored = await missions.get("m-local-uuid")
    expect(stored!.coordination!.assignee).toEqual({ agentId: "agent-self" })
    expect(stored!.coordination!.assignedAt).toBeTruthy()
    expect(stored!.coordination!.log[0].intent).toBe("accept")
  })

  it("appends onto an EXISTING coordination log (does not clobber prior entries)", async () => {
    const missions = new MemoryMissionStore([
      mission({
        coordination: {
          log: [{ intent: "request", fromAgentId: "agent-b", at: EARLIER, provenance: { origin: "imported", assertedBy: { agentId: "agent-b" } } }],
        },
      }),
    ])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "offer",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    const stored = await missions.get("m-local-uuid")
    expect(stored!.coordination!.log).toHaveLength(2)
    expect(stored!.coordination!.log.map((e) => e.intent)).toEqual(["request", "offer"])
  })

  // ── handoff guard (the one producer-side precondition) ──

  it("a NON-assignee handoff is refused (not_assignee) — you must hold it to hand it off", async () => {
    const missions = new MemoryMissionStore([mission()]) // no assignee
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend", "agent-c")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-c",
      intent: "handoff",
      proposedAssignee: { agentId: "agent-c" },
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("not_assignee")
  })

  it("a handoff by the CURRENT assignee succeeds and carries proposedAssignee on the envelope", async () => {
    const missions = new MemoryMissionStore([
      mission({ coordination: { assignee: { agentId: "agent-self" }, assignedAt: NOW, log: [] } }),
    ])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend", "agent-c")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-c",
      intent: "handoff",
      proposedAssignee: { agentId: "agent-c" },
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.intent).toBe("handoff")
      expect(result.envelope.proposedAssignee).toEqual({ agentId: "agent-c" })
    }
    // a handoff does NOT move the producer's own assignee (only an accept does).
    const stored = await missions.get("m-local-uuid")
    expect(stored!.coordination!.assignee).toEqual({ agentId: "agent-self" })
  })

  it("a handoff WITHOUT a proposedAssignee omits the field on the envelope", async () => {
    const missions = new MemoryMissionStore([
      mission({ coordination: { assignee: { agentId: "agent-self" }, assignedAt: NOW, log: [] } }),
    ])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend", "agent-c")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-c",
      intent: "handoff",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect("proposedAssignee" in result.envelope).toBe(false)
  })

  it("a NON-handoff intent never carries proposedAssignee even if one is passed (it is handoff-only)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "request",
      proposedAssignee: { agentId: "agent-c" },
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect("proposedAssignee" in result.envelope).toBe(false)
  })

  it("names the mission by missionKey + title, NEVER the local UUID; stamps fromAgentId = self", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await prepareCoordination(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "request",
      selfAgentId: "agent-self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.subject.missionKey).toBe("PROJ-1234")
      expect(result.envelope.subject.title).toBe("Ship the ledger")
      expect(JSON.stringify(result.envelope)).not.toContain("m-local-uuid")
      expect(result.envelope.fromAgentId).toBe("agent-self")
    }
  })

  it("stamps the proof slot when provided and omits it otherwise", async () => {
    const missions = new MemoryMissionStore([mission()])
    const store = new MemoryStore([recipientAgent("friend")])
    const grants = new MemoryGrantStore()
    const withProof = await prepareCoordination(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "request",
      selfAgentId: "agent-self",
      proof: "sig-xyz",
    })
    expect(withProof.ok).toBe(true)
    if (withProof.ok) expect(withProof.envelope.proof).toBe("sig-xyz")

    const withoutProof = await prepareCoordination(missions, store, grants, {
      missionId: "m-local-uuid",
      toAgentId: "agent-b",
      intent: "request",
      selfAgentId: "agent-self",
    })
    expect(withoutProof.ok).toBe(true)
    if (withoutProof.ok) expect("proof" in withoutProof.envelope).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// CONSUMER — importCoordination (the non-clobbering merge)
// ════════════════════════════════════════════════════════════════════════════

describe("importCoordination — consumer (the non-clobbering merge)", () => {
  it("refuses when the source trust is below the acceptance floor (stranger) and the mission is known", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await importCoordination(missions, { envelope: envelope(), fromAgentId: "agent-a", trustOfSource: "stranger" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
    expect(missions.putCalls).toBe(0)
  })

  it("refuses when the verifier rejects the source, even at high trust", async () => {
    const denyVerifier: AgentVerifier = { verify: () => false }
    const missions = new MemoryMissionStore([mission()])
    const result = await importCoordination(
      missions,
      { envelope: envelope(), fromAgentId: "agent-a", trustOfSource: "family" },
      { verifier: denyVerifier },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
  })

  it("honors a custom minTrustToAccept (raising the floor to friend)", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await importCoordination(
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
    const result = await importCoordination(
      missions,
      { envelope: envelope({ proof: "ok" }), fromAgentId: "agent-a", trustOfSource: "friend" },
      { verifier: proofVerifier },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.status).toBe("logged")
  })

  // ── existing mission: intent → log + assignee effect ──

  it("a request on an existing mission logs origin:imported, attributed, with importedAt (status 'logged')", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await importCoordination(missions, {
      envelope: envelope({ intent: "request", note: "will you take this?" }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("logged")
      const entry = result.record.coordination!.log[0]
      expect(entry).toMatchObject({
        intent: "request",
        fromAgentId: "agent-a",
        note: "will you take this?",
        provenance: { origin: "imported", assertedBy: { agentId: "agent-a" } },
      })
      expect(entry.at).toBe(NOW)
      expect(entry.provenance!.importedAt).toBeTruthy()
      // no assignee change
      expect(result.record.coordination!.assignee).toBeUndefined()
    }
  })

  it("an imported intent without a note omits the note field on the log entry", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await importCoordination(missions, { envelope: envelope({ intent: "decline" }), fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(result.ok).toBe(true)
    if (result.ok) expect("note" in result.record.coordination!.log[0]).toBe(false)
  })

  it("an accept sets assignee = the sender (status 'assigned'); first-party learnings + status untouched", async () => {
    const missions = new MemoryMissionStore([mission({ status: "active" })])
    const result = await importCoordination(missions, {
      envelope: envelope({ intent: "accept", issuedAt: LATER }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("assigned")
      expect(result.record.coordination!.assignee).toEqual({ agentId: "agent-a" })
      expect(result.record.coordination!.assignedAt).toBe(LATER)
      // INVARIANT non-transitive: status + first-party learnings untouched.
      expect(result.record.status).toBe("active")
      expect(result.record.learnings.gotcha.value).toBe("rebase not merge")
    }
  })

  it("a handoff does NOT set assignee on receipt (non-transitive) — proposal logged only ('logged')", async () => {
    const missions = new MemoryMissionStore([mission()])
    const result = await importCoordination(missions, {
      envelope: envelope({ intent: "handoff", proposedAssignee: { agentId: "agent-c" } }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("logged")
      expect(result.record.coordination!.assignee).toBeUndefined()
      expect(result.record.coordination!.log[0].intent).toBe("handoff")
    }
  })

  it("an existing mission with NO prior coordination gains a coordination sub-object on first import", async () => {
    const missions = new MemoryMissionStore([mission()]) // coordination undefined
    const result = await importCoordination(missions, { envelope: envelope({ intent: "offer" }), fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.coordination!.log).toHaveLength(1)
      expect(result.record.coordination!.assignee).toBeUndefined()
    }
  })

  // ── last-writer-wins by issuedAt ──

  it("LWW: a later-issuedAt accept overrides an earlier holder", async () => {
    const missions = new MemoryMissionStore([
      mission({ coordination: { assignee: { agentId: "agent-x" }, assignedAt: EARLIER, log: [{ intent: "accept", fromAgentId: "agent-x", at: EARLIER }] } }),
    ])
    const result = await importCoordination(missions, {
      envelope: envelope({ intent: "accept", fromAgentId: "agent-a", issuedAt: LATER }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("assigned")
      expect(result.record.coordination!.assignee).toEqual({ agentId: "agent-a" })
      expect(result.record.coordination!.assignedAt).toBe(LATER)
      // both accepts remain in the append-only log (the race is audited).
      expect(result.record.coordination!.log.map((e) => e.fromAgentId)).toEqual(["agent-x", "agent-a"])
    }
  })

  it("LWW: an EARLIER-issuedAt accept arriving after a later holder does NOT clobber it (logged, not assigned)", async () => {
    const missions = new MemoryMissionStore([
      mission({ coordination: { assignee: { agentId: "agent-x" }, assignedAt: LATER, log: [{ intent: "accept", fromAgentId: "agent-x", at: LATER }] } }),
    ])
    const result = await importCoordination(missions, {
      envelope: envelope({ intent: "accept", fromAgentId: "agent-a", issuedAt: EARLIER }),
      fromAgentId: "agent-a",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // the later holder stays; the earlier accept is logged but NOT effective.
      expect(result.status).toBe("logged")
      expect(result.record.coordination!.assignee).toEqual({ agentId: "agent-x" })
      expect(result.record.coordination!.assignedAt).toBe(LATER)
      expect(result.record.coordination!.log).toHaveLength(2)
    }
  })

  // ── replay / idempotency ──

  it("replay: re-importing the SAME (intent, fromAgentId, issuedAt) is a no-op on the log", async () => {
    const missions = new MemoryMissionStore([mission()])
    const first = await importCoordination(missions, { envelope: envelope({ intent: "request" }), fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(first.ok).toBe(true)
    const putsAfterFirst = missions.putCalls
    const second = await importCoordination(missions, { envelope: envelope({ intent: "request" }), fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.record.coordination!.log).toHaveLength(1) // not duplicated
    // a second put still happens (idempotent write of the unchanged record), but the log did not grow.
    expect(missions.putCalls).toBe(putsAfterFirst + 1)
  })

  it("replay of an accept does not move the assignee a second time (idempotent, status 'logged')", async () => {
    const missions = new MemoryMissionStore([mission()])
    const first = await importCoordination(missions, { envelope: envelope({ intent: "accept", issuedAt: LATER }), fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(first.ok).toBe(true)
    const replay = await importCoordination(missions, { envelope: envelope({ intent: "accept", issuedAt: LATER }), fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(replay.ok).toBe(true)
    if (replay.ok) {
      expect(replay.status).toBe("logged") // not re-assigned
      expect(replay.record.coordination!.log).toHaveLength(1)
      expect(replay.record.coordination!.assignee).toEqual({ agentId: "agent-a" })
    }
  })

  // ── seeding gate (unknown mission) ──

  it("seeds an unknown mission when a FRIEND peer introduces it (status active, empty learnings, intent logged)", async () => {
    const missions = new MemoryMissionStore()
    const result = await importCoordination(missions, { envelope: envelope({ intent: "request" }), fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("seeded")
      expect(result.record.missionKey).toBe("PROJ-1234")
      expect(result.record.title).toBe("Ship the ledger")
      expect(result.record.status).toBe("active")
      expect(result.record.learnings).toEqual({})
      expect(result.record.coordination!.log[0].intent).toBe("request")
      expect(result.record.coordination!.log[0].provenance!.origin).toBe("imported")
    }
    expect(missions.putCalls).toBe(1)
  })

  it("seeds an unknown mission when a FAMILY peer introduces an accept (assignee set on the seeded record)", async () => {
    const missions = new MemoryMissionStore()
    const result = await importCoordination(missions, { envelope: envelope({ intent: "accept", issuedAt: LATER }), fromAgentId: "agent-a", trustOfSource: "family" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("seeded")
      // the accept still applies its assignee effect on the seeded record.
      expect(result.record.coordination!.assignee).toEqual({ agentId: "agent-a" })
      expect(result.record.coordination!.assignedAt).toBe(LATER)
    }
  })

  it("untrusted_introduction for an ACQUAINTANCE source introducing an unknown mission", async () => {
    const missions = new MemoryMissionStore()
    const result = await importCoordination(missions, { envelope: envelope(), fromAgentId: "agent-a", trustOfSource: "acquaintance" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_introduction")
    expect(missions.putCalls).toBe(0)
  })

  it("untrusted_source for a STRANGER source introducing an unknown mission (refused at the accept cap)", async () => {
    const missions = new MemoryMissionStore()
    const result = await importCoordination(missions, { envelope: envelope(), fromAgentId: "agent-a", trustOfSource: "stranger" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
    expect(missions.putCalls).toBe(0)
  })
})
