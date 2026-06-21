import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { accumulateFriendTokens, FileFriendStore } from "../index"
import type { FriendStore, FriendRecord } from "../index"

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "uuid-1",
    name: "Jordan",
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

class TrackingStore implements FriendStore {
  getCalls = 0
  putCalls: Array<[string, FriendRecord]> = []
  constructor(private existing: FriendRecord | null) {}
  async get(_id: string) {
    this.getCalls += 1
    return this.existing
  }
  async put(id: string, record: FriendRecord) {
    this.putCalls.push([id, record])
    this.existing = record
  }
  async delete() {}
  async findByExternalId() {
    return null
  }
}

const usage = { input_tokens: 500, output_tokens: 800, reasoning_tokens: 200, total_tokens: 1500 }

describe("accumulateFriendTokens", () => {
  it("adds only output_tokens onto a zeroed record", async () => {
    const store = new TrackingStore(makeFriend({ totalTokens: 0 }))
    await accumulateFriendTokens(store, "uuid-1", usage)
    expect(store.putCalls[0][1].totalTokens).toBe(800)
    expect(store.putCalls[0][1].updatedAt).not.toBe("2026-01-01T00:00:00.000Z")
  })

  it("accumulates onto an existing total", async () => {
    const store = new TrackingStore(makeFriend({ totalTokens: 3000 }))
    await accumulateFriendTokens(store, "uuid-1", usage)
    expect(store.putCalls[0][1].totalTokens).toBe(3800)
  })

  it("is a no-op when usage is undefined", async () => {
    const store = new TrackingStore(makeFriend())
    await accumulateFriendTokens(store, "uuid-1", undefined)
    expect(store.getCalls).toBe(0)
    expect(store.putCalls).toHaveLength(0)
  })

  it("is a no-op when output_tokens is 0", async () => {
    const store = new TrackingStore(makeFriend())
    await accumulateFriendTokens(store, "uuid-1", { ...usage, output_tokens: 0 })
    expect(store.getCalls).toBe(0)
    expect(store.putCalls).toHaveLength(0)
  })

  it("does not crash when the record is missing", async () => {
    const store = new TrackingStore(null)
    await accumulateFriendTokens(store, "missing", usage)
    expect(store.getCalls).toBe(1)
    expect(store.putCalls).toHaveLength(0)
  })

  it("treats a legacy record with undefined totalTokens as 0", async () => {
    const legacy = makeFriend()
    ;(legacy as { totalTokens?: number }).totalTokens = undefined
    const store = new TrackingStore(legacy)
    await accumulateFriendTokens(store, "uuid-1", usage)
    expect(store.putCalls[0][1].totalTokens).toBe(800)
  })

  it("persists the running total through a real FileFriendStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-tokens-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      await store.put("uuid-1", makeFriend({ totalTokens: 100 }))
      await accumulateFriendTokens(store, "uuid-1", usage)
      expect((await store.get("uuid-1"))?.totalTokens).toBe(900)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
