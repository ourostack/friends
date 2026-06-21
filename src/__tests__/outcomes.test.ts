import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { recordRelationshipOutcome, FileFriendStore } from "../index"
import type { FriendStore, FriendRecord, IdentityProvider, NoteProvenance } from "../index"

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

function agentRecord(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "agent-1",
    name: "PeerBot",
    role: "agent-peer",
    trustLevel: "acquaintance",
    connections: [],
    externalIds: [{ provider: "a2a-agent" as IdentityProvider, externalId: "peer-1", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "agent",
    agentMeta: { bundleName: "PeerBot", familiarity: 2, sharedMissions: ["m0"], outcomes: [] },
    ...overrides,
  }
}

function humanRecord(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "human-1",
    name: "Human",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [{ provider: "aad" as IdentityProvider, externalId: "h1", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "human",
    ...overrides,
  }
}

const provenance: NoteProvenance = { assertedBy: { agentId: "a1", agentName: "Agent" } }

describe("recordRelationshipOutcome", () => {
  it("appends an outcome, adds the mission, bumps familiarity by default 1", async () => {
    const store = new MemoryStore([agentRecord()])
    const record = await recordRelationshipOutcome(store, "agent-1", { missionId: "m1", result: "success" })
    expect(record).not.toBeNull()
    expect(record?.agentMeta?.outcomes).toHaveLength(1)
    expect(record?.agentMeta?.outcomes[0]).toMatchObject({ missionId: "m1", result: "success" })
    expect(record?.agentMeta?.outcomes[0].timestamp).toBeTruthy()
    expect(record?.agentMeta?.sharedMissions).toEqual(["m0", "m1"])
    expect(record?.agentMeta?.familiarity).toBe(3)
  })

  it("carries a note and provenance on the outcome", async () => {
    const store = new MemoryStore([agentRecord()])
    const record = await recordRelationshipOutcome(store, "agent-1", {
      missionId: "m1",
      result: "partial",
      note: "halfway",
      provenance,
    })
    expect(record?.agentMeta?.outcomes[0].note).toBe("halfway")
    expect(record?.agentMeta?.outcomes[0].provenance?.assertedBy?.agentId).toBe("a1")
  })

  it("uses a custom familiarityDelta", async () => {
    const store = new MemoryStore([agentRecord()])
    const record = await recordRelationshipOutcome(store, "agent-1", { missionId: "m1", result: "success" }, 3)
    expect(record?.agentMeta?.familiarity).toBe(5)
  })

  it("does not duplicate a sharedMission that is already present", async () => {
    const store = new MemoryStore([agentRecord({ agentMeta: { bundleName: "P", familiarity: 0, sharedMissions: ["m1"], outcomes: [] } })])
    const record = await recordRelationshipOutcome(store, "agent-1", { missionId: "m1", result: "failed" })
    expect(record?.agentMeta?.sharedMissions).toEqual(["m1"])
    expect(record?.agentMeta?.outcomes).toHaveLength(1)
  })

  it("returns null (no throw) when the friend is missing", async () => {
    const store = new MemoryStore()
    const record = await recordRelationshipOutcome(store, "missing", { missionId: "m1", result: "success" })
    expect(record).toBeNull()
    expect(store.putCalls).toBe(0)
  })

  it("auto-initializes agentMeta on a human record (D3) and applies the outcome", async () => {
    const store = new MemoryStore([humanRecord()])
    const record = await recordRelationshipOutcome(store, "human-1", { missionId: "m1", result: "success" }, 2)
    expect(record?.agentMeta).toBeDefined()
    expect(record?.agentMeta?.bundleName).toBe("Human")
    expect(record?.agentMeta?.familiarity).toBe(2)
    expect(record?.agentMeta?.sharedMissions).toEqual(["m1"])
    expect(record?.agentMeta?.outcomes).toHaveLength(1)
    // kind is NOT flipped (D3 scope discipline)
    expect(record?.kind).toBe("human")
  })

  it("persists on an AGENT record through a real FileFriendStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-outcomes-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      await store.put("agent-1", agentRecord())
      await recordRelationshipOutcome(store, "agent-1", { missionId: "m1", result: "success" })
      const reloaded = await store.findByExternalId("a2a-agent", "peer-1")
      expect(reloaded?.agentMeta?.outcomes).toHaveLength(1)
      expect(reloaded?.agentMeta?.sharedMissions).toContain("m1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
