import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { upsertGroupContextParticipants, FileFriendStore } from "../index"
import type { FriendStore, FriendRecord, GroupContextParticipant, IdentityProvider } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

function participant(
  externalId: string,
  displayName = externalId,
  provider: GroupContextParticipant["provider"] = "imessage-handle",
): GroupContextParticipant {
  return { provider, externalId, displayName }
}

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
      if (
        r.externalIds.find(
          (e) => e.provider === provider && e.externalId === externalId && e.tenantId === tenantId,
        )
      ) {
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

function stranger(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "s-1",
    name: "Person",
    role: "stranger",
    trustLevel: "stranger",
    connections: [],
    externalIds: [{ provider: "imessage-handle" as IdentityProvider, externalId: "p@example.com", linkedAt: NOW }],
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

describe("upsertGroupContextParticipants", () => {
  it("creates unknown participants as acquaintances linked to the group", async () => {
    const store = new MemoryStore()
    const results = await upsertGroupContextParticipants({
      store,
      participants: [participant("new-a@example.com", "A"), participant("new-b@example.com", "B")],
      groupExternalId: "group:any;+;g1",
      now: () => NOW,
    })

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.created && r.trustLevel === "acquaintance")).toBe(true)
    expect(
      Array.from(store.records.values()).map((f) => ({
        name: f.name,
        trust: f.trustLevel,
        ids: f.externalIds.map((e) => e.externalId).sort(),
      })),
    ).toEqual([
      { name: "A", trust: "acquaintance", ids: ["group:any;+;g1", "new-a@example.com"] },
      { name: "B", trust: "acquaintance", ids: ["group:any;+;g1", "new-b@example.com"] },
    ])
  })

  it("promotes an existing stranger to acquaintance and links the group", async () => {
    const store = new MemoryStore([stranger()])
    const [result] = await upsertGroupContextParticipants({
      store,
      participants: [participant("p@example.com", "Person")],
      groupExternalId: "group:any;+;g1",
      now: () => NOW,
    })
    const updated = await store.get("s-1")
    expect(result.updated).toBe(true)
    expect(updated?.trustLevel).toBe("acquaintance")
    expect(updated?.role).toBe("acquaintance")
    expect(updated?.externalIds.map((e) => e.externalId).sort()).toEqual([
      "group:any;+;g1",
      "p@example.com",
    ])
  })

  it("preserves higher trust and only adds the group link", async () => {
    const store = new MemoryStore([
      stranger({ id: "f-1", trustLevel: "family", role: "partner" }),
    ])
    const [result] = await upsertGroupContextParticipants({
      store,
      participants: [participant("p@example.com", "Person")],
      groupExternalId: "group:any;+;g1",
      now: () => NOW,
    })
    const updated = await store.get("f-1")
    expect(result.updated).toBe(true)
    expect(updated?.trustLevel).toBe("family")
    expect(updated?.role).toBe("partner")
    expect(updated?.externalIds.map((e) => e.externalId).sort()).toEqual([
      "group:any;+;g1",
      "p@example.com",
    ])
  })

  it("dedupes repeated handles into a single record", async () => {
    const store = new MemoryStore()
    const results = await upsertGroupContextParticipants({
      store,
      participants: [participant("dup@example.com", "Dup"), participant("dup@example.com", "Dup")],
      groupExternalId: "group:any;+;g1",
      now: () => NOW,
    })
    expect(results).toHaveLength(1)
    expect(Array.from(store.records.values())).toHaveLength(1)
  })

  it("returns no results when the group id is blank", async () => {
    const store = new MemoryStore()
    const results = await upsertGroupContextParticipants({
      store,
      participants: [participant("x@example.com")],
      groupExternalId: "   ",
      now: () => NOW,
    })
    expect(results).toEqual([])
    expect(Array.from(store.records.values())).toEqual([])
  })

  it("ignores blank handles and is a no-op for a known acquaintance already in the group", async () => {
    const store = new MemoryStore([
      stranger({
        id: "acq-1",
        name: "Known",
        role: "acquaintance",
        trustLevel: "acquaintance",
        externalIds: [
          { provider: "imessage-handle", externalId: "known@example.com", linkedAt: NOW },
          { provider: "imessage-handle", externalId: "group:any;+;g1", linkedAt: NOW },
        ],
      }),
    ])
    const results = await upsertGroupContextParticipants({
      store,
      participants: [participant("   ", "Ignored"), participant("known@example.com", "Known")],
      groupExternalId: "group:any;+;g1",
      now: () => NOW,
    })
    expect(results).toEqual([
      {
        friendId: "acq-1",
        name: "Known",
        trustLevel: "acquaintance",
        created: false,
        updated: false,
        addedGroupExternalId: false,
      },
    ])
    expect(store.putCalls).toBe(0)
  })

  it("falls back to the external id when display name is blank, and skips Unknown name notes", async () => {
    const store = new MemoryStore()
    const empty = await upsertGroupContextParticipants({
      store,
      participants: [],
      groupExternalId: "group:any;+;g1",
      now: () => NOW,
    })
    expect(empty).toEqual([])

    const [result] = await upsertGroupContextParticipants({
      store,
      participants: [participant("no-name@example.com", "   ")],
      groupExternalId: "group:any;+;g1",
      now: () => NOW,
    })
    expect(result.name).toBe("no-name@example.com")

    const unknownStore = new MemoryStore()
    await upsertGroupContextParticipants({
      store: unknownStore,
      participants: [participant("u@example.com", "Unknown")],
      groupExternalId: "group:any;+;g2",
      now: () => NOW,
    })
    expect(Array.from(unknownStore.records.values())[0]?.notes).toEqual({})
  })

  it("treats a legacy record with no trust level as stranger-grade context", async () => {
    const store = new MemoryStore([
      stranger({ id: "legacy", trustLevel: undefined, externalIds: [{ provider: "imessage-handle", externalId: "legacy@example.com", linkedAt: NOW }] }),
    ])
    const [promoted] = await upsertGroupContextParticipants({
      store,
      participants: [participant("legacy@example.com", "Legacy")],
      groupExternalId: "group:any;+;g1",
      now: () => NOW,
    })
    expect(promoted.trustLevel).toBe("acquaintance")
  })

  it("uses the default clock when `now` is omitted", async () => {
    const store = new MemoryStore()
    const before = Date.now()
    const [result] = await upsertGroupContextParticipants({
      store,
      participants: [participant("clock@example.com", "Clock")],
      groupExternalId: "group:any;+;g1",
    })
    const created = store.records.get(result.friendId)
    expect(Date.parse(created!.createdAt)).toBeGreaterThanOrEqual(before)
  })

  it("works end-to-end against a real FileFriendStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-group-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      const results = await upsertGroupContextParticipants({
        store,
        participants: [participant("disk@example.com", "Disk Person")],
        groupExternalId: "group:any;+;g1",
        now: () => NOW,
      })
      expect(results[0].created).toBe(true)
      const persisted = await store.findByExternalId("imessage-handle", "disk@example.com")
      expect(persisted?.trustLevel).toBe("acquaintance")
      expect(persisted?.externalIds.map((e) => e.externalId).sort()).toEqual([
        "disk@example.com",
        "group:any;+;g1",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
