import { describe, it, expect } from "vitest"

import { resolveRoom, FileFriendStore } from "../index"
import type { FriendStore, FriendRecord, IdentityProvider } from "../index"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const NOW = "2026-03-14T18:00:00.000Z"
const GROUP = "group:project;+;g1"

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
      if (r.externalIds.find((e) => e.provider === provider && e.externalId === externalId && e.tenantId === tenantId)) return r
    }
    return null
  }
  async listAll() {
    return Array.from(this.records.values())
  }
}

function member(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "m-1",
    name: "Member",
    role: "acquaintance",
    trustLevel: "acquaintance",
    connections: [],
    externalIds: [
      { provider: "aad" as IdentityProvider, externalId: "person-1", linkedAt: NOW },
      { provider: "aad" as IdentityProvider, externalId: GROUP, linkedAt: NOW },
    ],
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

describe("resolveRoom", () => {
  it("returns members carrying the group id, each with a trust explanation", async () => {
    const inRoom = member({ id: "m-1", name: "Alice" })
    const alsoInRoom = member({ id: "m-2", name: "Bob", trustLevel: "friend" })
    const notInRoom = member({
      id: "m-3",
      name: "Carol",
      externalIds: [{ provider: "aad", externalId: "person-3", linkedAt: NOW }],
    })
    const store = new MemoryStore([inRoom, alsoInRoom, notInRoom])

    const view = await resolveRoom(store, GROUP)
    expect(view.groupExternalId).toBe(GROUP)
    expect(view.members.map((m) => m.friend.name).sort()).toEqual(["Alice", "Bob"])
    const alice = view.members.find((m) => m.friend.name === "Alice")!
    expect(alice.trust.level).toBe("acquaintance")
    expect(alice.trust.basis).toBe("shared_group")
    const bob = view.members.find((m) => m.friend.name === "Bob")!
    expect(bob.trust.level).toBe("friend")
    expect(bob.trust.basis).toBe("direct")
  })

  it("tags knownVia direct when the member carries a non-group identity", async () => {
    const store = new MemoryStore([member({ id: "m-1" })])
    const view = await resolveRoom(store, GROUP)
    expect(view.members[0].knownVia).toBe("direct")
  })

  it("tags knownVia group_only when the member carries only group identities", async () => {
    const groupOnly = member({
      id: "g-only",
      externalIds: [{ provider: "aad", externalId: GROUP, linkedAt: NOW }],
    })
    const store = new MemoryStore([groupOnly])
    const view = await resolveRoom(store, GROUP)
    expect(view.members[0].knownVia).toBe("group_only")
  })

  it("returns an empty member list for an unknown room", async () => {
    const store = new MemoryStore([member()])
    const view = await resolveRoom(store, "group:nonexistent;+;zzz")
    expect(view.members).toEqual([])
  })

  it("returns an empty member list when the store has no listAll", async () => {
    const noListAll: FriendStore = {
      async get() {
        return null
      },
      async put() {},
      async delete() {},
      async findByExternalId() {
        return null
      },
    }
    const view = await resolveRoom(noListAll, GROUP)
    expect(view.members).toEqual([])
  })

  it("honors an explicit channel lens for the trust explanation", async () => {
    const store = new MemoryStore([member({ trustLevel: "stranger" })])
    const view = await resolveRoom(store, GROUP, "teams")
    expect(view.members[0].trust.level).toBe("stranger")
    expect(view.members[0].trust.basis).toBe("unknown")
  })

  it("round-trips through a real FileFriendStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-room-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      await store.put("m-1", member({ id: "m-1", name: "Disk Member" }))
      const view = await resolveRoom(store, GROUP)
      expect(view.members.map((m) => m.friend.name)).toEqual(["Disk Member"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
