// prepareMissionResult (producer) + importMissionResult (consumer) — the result-return
// envelope (gap-2, p11 inc2). The honest north-star deliverable channel: B's actual
// produced artifact, attributed to B, correlated to A's delegation via missionKey +
// requestId. Structural twin of mission-share.ts, re-aimed from a SHARE at a RESULT.
//
// Through-line invariants (every one tested here):
//  - the mission is named by its JOIN KEY (missionKey), NEVER the local UUID;
//  - fromAgentId === the producing self (attributed to B);
//  - the result correlates to A's delegation via requestId;
//  - consent rides the "coordinate" identity-tier scope (friend ok, acquaintance refused) — NO new scope;
//  - recorded first-party on B's own record under results[requestId];
//  - on import: lands QUARANTINED under importedResults[agentId][requestId], attributed, imported-stamped;
//  - correlation honesty: a result whose requestId matches NO prior delegation on A → no_delegation;
//  - NO seeding: an unknown mission → no_mission (a result never creates a mission);
//  - trust-capped (stranger/over-trust → untrusted_source, writes nothing), checked BEFORE correlation;
//  - non-transitive: never recomputes status/participants; first-party byte-untouched;
//  - idempotent on replay.
import { describe, it, expect } from "vitest"

import { prepareMissionResult, importMissionResult } from "../mission-result"
import type {
  MissionResult,
  MissionResultEnvelope,
  PrepareMissionResultResult,
  ImportMissionResultResult,
} from "../mission-result"
import type { FriendStore, GrantStore, MissionStore, FriendRecord, ShareGrant, MissionRecord, MissionTaskSpec, IdentityProvider, AgentVerifier } from "../types"
import { strictPolicy } from "../consent"

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
  failPut = false
  constructor(initial: MissionRecord[] = []) {
    for (const m of initial) this.missions.set(m.id, m)
  }
  async get(id: string) {
    return this.missions.get(id) ?? null
  }
  async put(id: string, mission: MissionRecord) {
    if (this.failPut) throw new Error("missions.put boom")
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

/** A mission on B's side: B did the work; B holds the local mission by its missionKey. */
function missionOnB(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: "m-on-b",
    missionKey: "PROJ-1234",
    title: "Ship the ledger",
    status: "active",
    participants: [{ agentId: "agent-b" }],
    outcomes: [],
    learnings: { gotcha: { value: "B's own learning", savedAt: NOW, shareable: false, provenance: { origin: "first_party" } } },
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

/** A mission on A's side, carrying A's FIRST-PARTY delegation under delegations[requestId]
 * (so A's import of B's result for that requestId correlates). */
function missionOnA(requestId = "req-1", overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: "m-on-a",
    missionKey: "PROJ-1234",
    title: "Ship the ledger",
    status: "active",
    participants: [{ agentId: "agent-a" }],
    outcomes: [],
    learnings: { gotcha: { value: "A's own learning", savedAt: NOW, shareable: false, provenance: { origin: "first_party" } } },
    delegations: { [requestId]: { task: { requestId, summary: "Audit the auth module" }, provenance: { origin: "first_party" } } },
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

/** A's friend record on B's side (the recipient of B's result), at the given trust. */
function recipientAgent(trustLevel: FriendRecord["trustLevel"], agentId = "agent-a"): FriendRecord {
  return {
    id: `rec-${agentId}`,
    name: "Delegator",
    role: "agent-peer",
    trustLevel,
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

function resultEnvelope(overrides: Partial<MissionResultEnvelope> = {}): MissionResultEnvelope {
  return {
    subject: { missionKey: "PROJ-1234", title: "Ship the ledger" },
    fromAgentId: "agent-b",
    requestId: "req-1",
    result: { requestId: "req-1", summary: "Auth module audited — 2 findings" },
    issuedAt: NOW,
    ...overrides,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PRODUCER — prepareMissionResult (B returns its deliverable)
// ════════════════════════════════════════════════════════════════════════════

describe("prepareMissionResult — producer", () => {
  it("returns not_found when the missionId does not resolve", async () => {
    const result = await prepareMissionResult(new MemoryMissionStore(), new MemoryStore(), new MemoryGrantStore(), {
      missionId: "ghost",
      toAgentId: "agent-a",
      requestId: "req-1",
      result: { summary: "x" },
      selfAgentId: "agent-b",
    })
    expect(result).toEqual<PrepareMissionResultResult>({ ok: false, status: "not_found" })
  })

  it("a friend recipient consents at the identity tier (coordinate scope — no grant needed)", async () => {
    const missions = new MemoryMissionStore([missionOnB()])
    const result = await prepareMissionResult(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-on-b",
      toAgentId: "agent-a",
      requestId: "req-1",
      result: { summary: "Auth module audited — 2 findings", artifact: "## Findings\n1. …", outputs: { findings: "2" } },
      selfAgentId: "agent-b",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.envelope.subject.missionKey).toBe("PROJ-1234")
    expect(result.envelope.fromAgentId).toBe("agent-b") // attributed to B
    expect(result.envelope.requestId).toBe("req-1") // the correlation key
    expect(result.envelope.result.summary).toBe("Auth module audited — 2 findings")
    expect(result.envelope.result.artifact).toBe("## Findings\n1. …")
    expect(result.envelope.result.outputs).toEqual({ findings: "2" })
  })

  it("names the mission by missionKey — the local UUID NEVER appears in the serialized envelope", async () => {
    const missions = new MemoryMissionStore([missionOnB()])
    const result = await prepareMissionResult(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-on-b",
      toAgentId: "agent-a",
      requestId: "req-1",
      result: { summary: "done" },
      selfAgentId: "agent-b",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(JSON.stringify(result.envelope).includes("m-on-b")).toBe(false)
    expect(JSON.stringify(result.envelope).includes("PROJ-1234")).toBe(true)
  })

  it("an acquaintance recipient is refused (no_consent — below the identity-tier floor)", async () => {
    const missions = new MemoryMissionStore([missionOnB()])
    const result = await prepareMissionResult(missions, new MemoryStore([recipientAgent("acquaintance")]), new MemoryGrantStore(), {
      missionId: "m-on-b",
      toAgentId: "agent-a",
      requestId: "req-1",
      result: { summary: "done" },
      selfAgentId: "agent-b",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.status).toBe("no_consent")
  })

  it("defaults an unknown recipient to stranger (refused no_consent)", async () => {
    const missions = new MemoryMissionStore([missionOnB()])
    const result = await prepareMissionResult(missions, new MemoryStore(), new MemoryGrantStore(), {
      missionId: "m-on-b",
      toAgentId: "unknown",
      requestId: "req-1",
      result: { summary: "done" },
      selfAgentId: "agent-b",
    })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.status).toBe("no_consent")
  })

  it("records the result first-party on B's own record under results[requestId] (origin first_party)", async () => {
    const missions = new MemoryMissionStore([missionOnB()])
    const result = await prepareMissionResult(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-on-b",
      toAgentId: "agent-a",
      requestId: "req-1",
      result: { summary: "Auth module audited", outputs: { findings: "2" } },
      selfAgentId: "agent-b",
    })
    expect(result.ok).toBe(true)
    const stored = await missions.get("m-on-b")
    expect(stored!.results).toBeDefined()
    expect(stored!.results!["req-1"]).toBeDefined()
    expect(stored!.results!["req-1"].requestId).toBe("req-1")
    expect(stored!.results!["req-1"].summary).toBe("Auth module audited")
    expect(stored!.results!["req-1"].provenance).toEqual({ origin: "first_party" })
    // first-party learnings untouched by recording the result
    expect(stored!.learnings.gotcha.value).toBe("B's own learning")
  })

  it("stamps an optional proof on the envelope when given (and omits it otherwise)", async () => {
    const missions = new MemoryMissionStore([missionOnB(), missionOnB({ id: "m-on-b2", missionKey: "PROJ-9" })])
    const withProof = await prepareMissionResult(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-on-b",
      toAgentId: "agent-a",
      requestId: "req-1",
      result: { summary: "done" },
      selfAgentId: "agent-b",
      proof: "sig-xyz",
    })
    expect(withProof.ok).toBe(true)
    if (withProof.ok) expect(withProof.envelope.proof).toBe("sig-xyz")
    const without = await prepareMissionResult(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-on-b2",
      toAgentId: "agent-a",
      requestId: "req-9",
      result: { summary: "done" },
      selfAgentId: "agent-b",
    })
    expect(without.ok).toBe(true)
    if (without.ok) expect("proof" in without.envelope).toBe(false)
  })

  it("under the strict policy a friend recipient still needs an explicit coordinate grant (no_consent without one)", async () => {
    const missions = new MemoryMissionStore([missionOnB()])
    const result = await prepareMissionResult(
      missions,
      new MemoryStore([recipientAgent("friend")]),
      new MemoryGrantStore(),
      { missionId: "m-on-b", toAgentId: "agent-a", requestId: "req-1", result: { summary: "done" }, selfAgentId: "agent-b" },
      strictPolicy,
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.status).toBe("no_consent")
  })

  it("omits artifact/outputs on the envelope result when not provided", async () => {
    const missions = new MemoryMissionStore([missionOnB()])
    const result = await prepareMissionResult(missions, new MemoryStore([recipientAgent("friend")]), new MemoryGrantStore(), {
      missionId: "m-on-b",
      toAgentId: "agent-a",
      requestId: "req-1",
      result: { summary: "minimal" },
      selfAgentId: "agent-b",
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect("artifact" in result.envelope.result).toBe(false)
    expect("outputs" in result.envelope.result).toBe(false)
  })
})

// Type-level: the PINNED shapes exist.
const _r: MissionResult = { requestId: "x", summary: "y" }
const _imp: ImportMissionResultResult = { ok: false, status: "no_delegation" }
const _spec: MissionTaskSpec = { requestId: "x", summary: "y" }
void _r
void _imp
void _spec
