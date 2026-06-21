import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { linkExternalId, unlinkExternalId, FileFriendStore } from "../index"
import type { FriendStore, FriendRecord, IdentityProvider } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

class MemoryStore implements FriendStore {
  readonly records = new Map<string, FriendRecord>()
  putCalls = 0
  deleteCalls: string[] = []
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
    this.deleteCalls.push(id)
    this.records.delete(id)
  }
  async findByExternalId(provider: string, externalId: string, tenantId?: string) {
    for (const r of this.records.values()) {
      if (
        r.externalIds.find(
          (e) =>
            e.provider === provider &&
            e.externalId === externalId &&
            (tenantId === undefined || e.tenantId === tenantId),
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

function friend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "f-1",
    name: "Person",
    role: "friend",
    trustLevel: "friend",
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

describe("linkExternalId", () => {
  it("returns not_found (no throw) when the friend is missing", async () => {
    const store = new MemoryStore()
    const result = await linkExternalId(store, "missing", { provider: "teams-conversation", externalId: "c1" })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("not_found")
    expect(store.putCalls).toBe(0)
  })

  it("is a noop when the identity is already linked, leaving the record unchanged", async () => {
    const store = new MemoryStore([friend()])
    const result = await linkExternalId(store, "f-1", { provider: "aad", externalId: "x1" })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("noop")
    expect(store.putCalls).toBe(0)
    expect((await store.get("f-1"))?.externalIds).toHaveLength(1)
  })

  it("appends a new external id with no orphan present", async () => {
    const store = new MemoryStore([friend()])
    const result = await linkExternalId(store, "f-1", { provider: "teams-conversation", externalId: "c1" })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("linked")
    const stored = await store.get("f-1")
    expect(stored?.externalIds.map((e) => e.externalId).sort()).toEqual(["c1", "x1"])
    const added = stored?.externalIds.find((e) => e.externalId === "c1")
    expect(added?.provider).toBe("teams-conversation")
    expect(added?.linkedAt).toBeTruthy()
    expect(added?.tenantId).toBeUndefined()
  })

  it("carries tenantId onto the appended external id when provided", async () => {
    const store = new MemoryStore([friend()])
    await linkExternalId(store, "f-1", { provider: "aad", externalId: "x2", tenantId: "t1" })
    const stored = await store.get("f-1")
    const added = stored?.externalIds.find((e) => e.externalId === "x2")
    expect(added?.tenantId).toBe("t1")
  })

  it("merges an orphan that holds the linked id: deletes orphan, keeps higher trust, target notes win, folds orphan ids", async () => {
    const target = friend({
      id: "target",
      trustLevel: "acquaintance",
      notes: { shared: { value: "target wins", savedAt: NOW } },
      externalIds: [{ provider: "aad", externalId: "x1", linkedAt: NOW }],
    })
    const orphan = friend({
      id: "orphan",
      trustLevel: "family",
      notes: {
        shared: { value: "orphan loses", savedAt: NOW },
        orphanOnly: { value: "kept", savedAt: NOW },
      },
      externalIds: [
        { provider: "teams-conversation", externalId: "c1", linkedAt: NOW },
        { provider: "imessage-handle", externalId: "im1", linkedAt: NOW },
      ],
    })
    const store = new MemoryStore([target, orphan])

    const result = await linkExternalId(store, "target", { provider: "teams-conversation", externalId: "c1" })
    expect(result.status).toBe("merged")
    expect(store.deleteCalls).toContain("orphan")
    expect(await store.get("orphan")).toBeNull()

    const merged = await store.get("target")
    // higher trust wins (family > acquaintance)
    expect(merged?.trustLevel).toBe("family")
    // target notes win on key collision; orphan-only notes are kept
    expect(merged?.notes.shared.value).toBe("target wins")
    expect(merged?.notes.orphanOnly.value).toBe("kept")
    // target keeps x1 + the freshly linked c1 + orphan's OTHER ids (im1), but not a duplicate c1
    expect(merged?.externalIds.map((e) => e.externalId).sort()).toEqual(["c1", "im1", "x1"])
    expect(merged?.externalIds.filter((e) => e.externalId === "c1")).toHaveLength(1)
  })

  it("merges a tenant-unqualified orphan even when linking WITH a tenantId (D4 parity)", async () => {
    const target = friend({ id: "target", externalIds: [{ provider: "aad", externalId: "x1", linkedAt: NOW }] })
    const orphan = friend({
      id: "orphan",
      trustLevel: "stranger",
      externalIds: [{ provider: "aad", externalId: "x2", linkedAt: NOW }], // NO tenantId
    })
    const store = new MemoryStore([target, orphan])
    const result = await linkExternalId(store, "target", { provider: "aad", externalId: "x2", tenantId: "t1" })
    expect(result.status).toBe("merged")
    expect(await store.get("orphan")).toBeNull()
    const merged = await store.get("target")
    const added = merged?.externalIds.find((e) => e.externalId === "x2")
    expect(added?.tenantId).toBe("t1")
  })
})

describe("unlinkExternalId", () => {
  it("removes a linked identity", async () => {
    const store = new MemoryStore([
      friend({
        externalIds: [
          { provider: "aad", externalId: "x1", linkedAt: NOW },
          { provider: "teams-conversation", externalId: "c1", linkedAt: NOW },
        ],
      }),
    ])
    const result = await unlinkExternalId(store, "f-1", { provider: "teams-conversation", externalId: "c1" })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("unlinked")
    expect((await store.get("f-1"))?.externalIds.map((e) => e.externalId)).toEqual(["x1"])
  })

  it("is a noop when the identity is not linked but the friend exists", async () => {
    const store = new MemoryStore([friend()])
    const result = await unlinkExternalId(store, "f-1", { provider: "teams-conversation", externalId: "nope" })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("noop")
    expect(store.putCalls).toBe(0)
  })

  it("returns not_found when the friend is missing", async () => {
    const store = new MemoryStore()
    const result = await unlinkExternalId(store, "missing", { provider: "aad", externalId: "x1" })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("not_found")
  })
})

describe("link/unlink — FileFriendStore end-to-end", () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("links with an orphan merge and unlinks, all persisted to disk", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-link-"))
    const store = new FileFriendStore(join(dir, "friends"))
    await store.put("target", friend({ id: "target", trustLevel: "acquaintance", externalIds: [{ provider: "aad", externalId: "x1", linkedAt: NOW }] }))
    await store.put("orphan", friend({ id: "orphan", trustLevel: "family", externalIds: [{ provider: "teams-conversation", externalId: "c1", linkedAt: NOW }] }))

    const linkResult = await linkExternalId(store, "target", { provider: "teams-conversation", externalId: "c1" })
    expect(linkResult.status).toBe("merged")
    expect(await store.get("orphan")).toBeNull()
    const afterLink = await store.findByExternalId("teams-conversation", "c1")
    expect(afterLink?.id).toBe("target")
    expect(afterLink?.trustLevel).toBe("family")

    const unlinkResult = await unlinkExternalId(store, "target", { provider: "teams-conversation", externalId: "c1" })
    expect(unlinkResult.status).toBe("unlinked")
    expect(await store.findByExternalId("teams-conversation", "c1")).toBeNull()
  })
})
