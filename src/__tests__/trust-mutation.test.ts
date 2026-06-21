import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { setFriendTrust, FileFriendStore } from "../index"
import type { FriendStore, FriendRecord, IdentityProvider, TrustLevel } from "../index"

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

function friend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "f-1",
    name: "Person",
    role: "stranger",
    trustLevel: "stranger",
    connections: [],
    externalIds: [{ provider: "aad" as IdentityProvider, externalId: "x1", linkedAt: NOW }],
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

describe("setFriendTrust", () => {
  it("sets both trustLevel and role to the given level and bumps updatedAt", async () => {
    const store = new MemoryStore([friend()])
    const result = await setFriendTrust(store, "f-1", "friend")
    expect(result.ok).toBe(true)
    expect(result.status).toBe("updated")
    expect(result.record?.trustLevel).toBe("friend")
    expect(result.record?.role).toBe("friend")
    const stored = await store.get("f-1")
    expect(stored?.trustLevel).toBe("friend")
    expect(stored?.role).toBe("friend")
    expect(stored?.updatedAt).not.toBe(NOW)
  })

  it("maps each of the four trust levels correctly", async () => {
    const levels: TrustLevel[] = ["family", "friend", "acquaintance", "stranger"]
    for (const level of levels) {
      const store = new MemoryStore([friend()])
      const result = await setFriendTrust(store, "f-1", level)
      expect(result.record?.trustLevel).toBe(level)
      expect(result.record?.role).toBe(level)
    }
  })

  it("returns not_found (no throw) when the friend is missing", async () => {
    const store = new MemoryStore()
    const result = await setFriendTrust(store, "missing", "friend")
    expect(result.ok).toBe(false)
    expect(result.status).toBe("not_found")
    expect(store.putCalls).toBe(0)
  })

  it("persists trust and role through a real FileFriendStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-trust-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      await store.put("f-1", friend())
      await setFriendTrust(store, "f-1", "family")
      const reloaded = await store.findByExternalId("aad", "x1")
      expect(reloaded?.trustLevel).toBe("family")
      expect(reloaded?.role).toBe("family")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
