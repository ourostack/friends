// connectAgents — the `connect_to` library fn (brick 8, greenfield).
//
// The owner introducing a target peer INTO the calling agent's store (own-fleet
// linking). A↔B live in SEPARATE stores; a single connectAgents call operates on ONE
// store (upserts the peer as an agent-peer at the linked trust + audits action:"connect").
// The bidirectional A↔B link is the owner running the introduction on each side (the
// LOCAL proof drives both). The fn does NOT reach across stores.
//
// Contract under test (every branch):
//  - authority FIRST: a downgrade authorization → { ok:false, status:"downgraded", downgrade }, NO audit, NO link;
//  - disambiguation honesty: a bare name with no record hit (and no agentId/did) → { ok:false, status:"needs_handle_or_introduction" }, NO audit, NEVER fabricates;
//  - the introduce effect: a resolvable peer + commit → upsertAgentPeer at the linked trust (default family) + ONE action:"connect" audit;
//  - audit absent (no sink) → connected, no audit appended;
//  - store.put failure surfaced.
import { describe, it, expect, afterEach } from "vitest"

import { connectAgents } from "../connect"
import type { ConnectResult } from "../connect"
import { MemoryAuditSink } from "../audit"
import type { ControlPlaneAuditRecord } from "../audit"
import { setNervesEmitter } from "../observability"
import type { FriendStore, FriendRecord, AgentMeta } from "../types"
import type { AccountMembershipResult } from "../account-roster"

const NOW = "2026-03-14T18:00:00.000Z"

class MemoryStore implements FriendStore {
  readonly records = new Map<string, FriendRecord>()
  putCalls = 0
  failPut = false
  constructor(initial: FriendRecord[] = []) {
    for (const f of initial) this.records.set(f.id, f)
  }
  async get(id: string) {
    return this.records.get(id) ?? null
  }
  async put(id: string, record: FriendRecord) {
    if (this.failPut) throw new Error("store.put boom")
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

function agentRecord(overrides: Partial<FriendRecord> = {}, meta: Partial<AgentMeta> = {}): FriendRecord {
  return {
    id: "rec-existing",
    name: "Existing Peer",
    role: "agent-peer",
    trustLevel: "acquaintance",
    externalIds: [{ provider: "a2a-agent", externalId: "peer-existing", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "agent",
    agentMeta: {
      bundleName: "Existing Peer",
      familiarity: 0,
      sharedMissions: [],
      outcomes: [],
      a2a: { agentId: "peer-existing" },
      ...meta,
    },
    ...overrides,
  }
}

const family = (): AccountMembershipResult => ({ decision: "family_same_account" })

describe("connectAgents — authority gate FIRST", () => {
  afterEach(() => setNervesEmitter(null))

  it("an open-sense request DOWNGRADES — no link, no audit", async () => {
    const store = new MemoryStore()
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: { agentId: "peer-1" }, senseType: "open" },
      { audit, actor: "owner:stdio", originSense: "a2a" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.status).toBe("downgraded")
    expect(result.downgrade).toEqual({ decision: "downgrade", reason: "open_sense_needs_confirmation" })
    expect(audit.list()).toHaveLength(0)
    expect(store.putCalls).toBe(0)
  })

  it("a closed-sense request from a NON-member DOWNGRADES — no link, no audit", async () => {
    const store = new MemoryStore()
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: { agentId: "peer-1" }, senseType: "closed", membership: { decision: "not_member" } },
      { audit, actor: "owner:stdio", originSense: "teams" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.status).toBe("downgraded")
    expect(result.downgrade).toEqual({ decision: "downgrade", reason: "closed_sense_not_member" })
    expect(audit.list()).toHaveLength(0)
    expect(store.putCalls).toBe(0)
  })

  it("a closed-sense request from a same-account FAMILY member COMMITS (links + audits)", async () => {
    const store = new MemoryStore()
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: { agentId: "peer-1", name: "Peer One" }, senseType: "closed", membership: family() },
      { audit, actor: "owner:stdio", originSense: "teams" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.status).toBe("connected")
    expect(audit.list()).toHaveLength(1)
  })
})

describe("connectAgents — disambiguation honesty (NEVER fabricates a target)", () => {
  afterEach(() => setNervesEmitter(null))

  it("a bare NAME with no record hit (and no agentId/did) → needs_handle_or_introduction, NO audit", async () => {
    const store = new MemoryStore()
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: { name: "Dana from Acme" }, senseType: "local" },
      { audit, actor: "owner:stdio", originSense: "stdio" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.status).toBe("needs_handle_or_introduction")
    expect(audit.list()).toHaveLength(0)
    expect(store.putCalls).toBe(0)
  })

  it("an EMPTY peer (no agentId/did/name) → needs_handle_or_introduction, NO audit", async () => {
    const store = new MemoryStore()
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: {}, senseType: "local" },
      { audit, actor: "owner:stdio", originSense: "stdio" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.status).toBe("needs_handle_or_introduction")
    expect(audit.list()).toHaveLength(0)
  })

  it("a bare NAME that DOES match an existing record by name → resolves + connects (the §3.3 name-fallback hit)", async () => {
    const store = new MemoryStore([agentRecord({ name: "Dana" })])
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: { name: "dana" }, senseType: "local" }, // case-insensitive
      { audit, actor: "owner:stdio", originSense: "stdio" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.status).toBe("connected")
    // the resolved agentId is the matched record's a2a agentId
    expect(result.record.externalIds.some((e) => e.provider === "a2a-agent" && e.externalId === "peer-existing")).toBe(true)
    expect(audit.list()).toHaveLength(1)
  })
})

describe("connectAgents — the introduce effect + the action:'connect' audit", () => {
  afterEach(() => setNervesEmitter(null))

  it("commit + resolvable agentId (new peer) → upserts at family (default) + writes ONE action:'connect' audit", async () => {
    const store = new MemoryStore()
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: { agentId: "peer-new", name: "New Peer" }, senseType: "local" },
      { audit, actor: "owner:stdio", originSense: "stdio" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.status).toBe("connected")
    // own-fleet linked agents default to family
    expect(result.record.trustLevel).toBe("family")
    expect(result.record.kind).toBe("agent")
    expect(result.record.name).toBe("New Peer")
    expect(result.record.externalIds.some((e) => e.provider === "a2a-agent" && e.externalId === "peer-new")).toBe(true)
    expect(store.putCalls).toBe(1)

    const records = audit.list()
    expect(records).toHaveLength(1)
    const rec = records[0] as ControlPlaneAuditRecord
    expect(rec.action).toBe("connect")
    expect(rec.targetId).toBe(result.record.id)
    expect(rec.level).toBe("family")
    expect(rec.actor).toBe("owner:stdio")
    expect(rec.originSense).toBe("stdio")
    expect(rec.ts).toBe(result.record.updatedAt)
  })

  it("honors an explicit trustLevel override (e.g. friend) on the link + the audit level", async () => {
    const store = new MemoryStore()
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: { agentId: "peer-new" }, senseType: "local", trustLevel: "friend" },
      { audit, actor: "owner:stdio", originSense: "stdio" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.record.trustLevel).toBe("friend")
    expect((audit.list()[0] as ControlPlaneAuditRecord).level).toBe("friend")
  })

  it("uses the agentId as the name when no peer.name is given", async () => {
    const store = new MemoryStore()
    const result = await connectAgents(
      store,
      { peer: { agentId: "peer-anon" }, senseType: "local" },
      { actor: "owner:stdio", originSense: "stdio" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.record.name).toBe("peer-anon")
  })

  it("carries the resolved DID as targetDid on the audit when the peer record has one", async () => {
    // Seed an existing peer WITH a durable identity DID, resolved by did.
    const store = new MemoryStore([agentRecord({ id: "rec-did" }, { identity: { did: "did:key:zPeerDID" }, a2a: { agentId: "peer-existing", did: "did:key:zPeerDID" } })])
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: { did: "did:key:zPeerDID" }, senseType: "local" },
      { audit, actor: "owner:stdio", originSense: "stdio" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect((audit.list()[0] as ControlPlaneAuditRecord).targetDid).toBe("did:key:zPeerDID")
  })

  it("a did with NO matching record → needs_handle_or_introduction (did is a handle, but it must resolve)", async () => {
    const store = new MemoryStore()
    const audit = new MemoryAuditSink()
    const result = await connectAgents(
      store,
      { peer: { did: "did:key:zUnknown" }, senseType: "local" },
      { audit, actor: "owner:stdio", originSense: "stdio" },
    )
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.status).toBe("needs_handle_or_introduction")
    expect(audit.list()).toHaveLength(0)
  })

  it("commit + resolvable peer but NO sink wired → connected, no audit appended (no-sink no-op)", async () => {
    const store = new MemoryStore()
    const result = await connectAgents(
      store,
      { peer: { agentId: "peer-new" }, senseType: "local" },
      { actor: "owner:stdio", originSense: "stdio" },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.status).toBe("connected")
    expect(store.putCalls).toBe(1)
  })

  it("surfaces a store.put failure (does not swallow it)", async () => {
    const store = new MemoryStore()
    store.failPut = true
    await expect(
      connectAgents(store, { peer: { agentId: "peer-new" }, senseType: "local" }, { actor: "owner:stdio", originSense: "stdio" }),
    ).rejects.toThrow("store.put boom")
  })

  it("emits a nerves event on a connected outcome", async () => {
    const store = new MemoryStore()
    const seen: { event: string }[] = []
    setNervesEmitter((e) => seen.push(e))
    await connectAgents(store, { peer: { agentId: "peer-new" }, senseType: "local" }, { actor: "owner:stdio", originSense: "stdio" })
    expect(seen.some((e) => e.event === "friends.connect_linked")).toBe(true)
  })
})

// Type-level: the result shape is the PINNED discriminated union.
const _typecheck: ConnectResult = { ok: true, status: "connected", record: {} as FriendRecord }
void _typecheck
