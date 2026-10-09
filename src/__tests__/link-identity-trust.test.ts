import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { linkExternalId, unlinkExternalId, FileFriendStore } from "../index"
import type { FriendStore, FriendRecord } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

class MemoryStore implements FriendStore {
  readonly records = new Map<string, FriendRecord>()
  failPutFor?: string
  failDeleteFor?: string
  failDeleteOnce?: string
  constructor(initial: FriendRecord[] = []) {
    for (const f of initial) this.records.set(f.id, f)
  }
  async get(id: string) {
    return this.records.get(id) ?? null
  }
  async put(id: string, record: FriendRecord) {
    if (id === this.failPutFor) throw new Error("disk full")
    this.records.set(id, record)
  }
  async delete(id: string) {
    if (id === this.failDeleteFor) throw new Error("disk gone")
    if (id === this.failDeleteOnce) {
      this.failDeleteOnce = undefined
      throw new Error("disk hiccup")
    }
    this.records.delete(id)
  }
  async listAll() {
    return Array.from(this.records.values())
  }
  async findByExternalId(provider: string, externalId: string) {
    for (const r of this.records.values()) {
      if (r.externalIds.some((e) => e.provider === provider && e.externalId === externalId)) return r
    }
    return null
  }
}

function person(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "p",
    name: "Person",
    role: "friend",
    trustLevel: "stranger",
    connections: [],
    externalIds: [],
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

const ariTelegram = { provider: "telegram-user" as const, externalId: "42", linkedAt: NOW }

function owner(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return person({ id: "ari", name: "Ari", trustLevel: "family", externalIds: [ariTelegram], ...overrides })
}

describe("linkExternalId never raises trust (audit finding 7)", () => {
  it("refuses with conflict_requires_operator when the owner record holds a capability profile, and changes nothing", async () => {
    const store = new MemoryStore([
      owner({ capabilityProfileId: "sanctuary-owner" }),
      person({ id: "mallory", name: "Mallory" }),
    ])
    const result = await linkExternalId(store, "mallory", { provider: "telegram-user", externalId: "42" })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("conflict_requires_operator")
    expect(result.message).toContain("ari")
    expect(result.message).toContain("Ari")
    expect(result.message).toContain("mallory")
    expect(result.message).toContain("Mallory")
    expect(store.records.get("ari")?.capabilityProfileId).toBe("sanctuary-owner")
    expect(store.records.get("mallory")?.trustLevel).toBe("stranger")
    expect(store.records.get("mallory")?.externalIds).toEqual([])
  })

  it("refuses when the owner record holds a legacy delegation grant", async () => {
    const store = new MemoryStore([
      owner({ delegationGrant: { scope: "principal_commands", grantedAt: NOW, source: "operator" } }),
      person({ id: "mallory", name: "Mallory" }),
    ])
    const result = await linkExternalId(store, "mallory", { provider: "telegram-user", externalId: "42" })
    expect(result.status).toBe("conflict_requires_operator")
    expect(store.records.has("ari")).toBe(true)
  })

  it("refuses when the owner record has active admission", async () => {
    const store = new MemoryStore([owner({ admissionState: "active" }), person({ id: "mallory", name: "Mallory" })])
    const result = await linkExternalId(store, "mallory", { provider: "telegram-user", externalId: "42" })
    expect(result.status).toBe("conflict_requires_operator")
    expect(store.records.has("ari")).toBe(true)
  })

  it("merges a plain orphan but keeps the target's own trust, never the orphan's", async () => {
    const store = new MemoryStore([owner({ trustLevel: "stranger" }), person({ id: "t", name: "Target", trustLevel: "stranger" })])
    const result = await linkExternalId(store, "t", { provider: "telegram-user", externalId: "42" })
    expect(result.status).toBe("merged")
    expect(result.record?.trustLevel).toBe("stranger")
    expect(store.records.get("t")?.trustLevel).toBe("stranger")
    expect(store.records.has("ari")).toBe(false)
  })

  it("loses nothing when the write of the merged target fails: the orphan is still there", async () => {
    const store = new MemoryStore([owner({ trustLevel: "stranger" }), person({ id: "t", name: "Target" })])
    store.failPutFor = "t"
    await expect(linkExternalId(store, "t", { provider: "telegram-user", externalId: "42" })).rejects.toThrow("disk full")
    expect(store.records.get("ari")?.externalIds).toEqual([ariTelegram])
  })

  it("loses nothing when the orphan delete fails: the merged target is already written", async () => {
    const store = new MemoryStore([owner({ trustLevel: "stranger", notes: { n: { value: "v", savedAt: NOW } } }), person({ id: "t", name: "Target" })])
    store.failDeleteFor = "ari"
    await expect(linkExternalId(store, "t", { provider: "telegram-user", externalId: "42" })).rejects.toThrow("disk gone")
    expect(store.records.get("t")?.externalIds.map((e) => e.externalId)).toEqual(["42"])
    expect(store.records.get("t")?.notes.n?.value).toBe("v")
    expect(store.records.has("ari")).toBe(true)
  })
})

describe("linkExternalId refuses to move a different-trust or revoked identity", () => {
  it("refuses when the orphan's trust differs from the target's, in either direction", async () => {
    const trusted = new MemoryStore([owner(), person({ id: "t", name: "Target" })])
    const up = await linkExternalId(trusted, "t", { provider: "telegram-user", externalId: "42" })
    expect(up.status).toBe("conflict_requires_operator")
    expect(trusted.records.has("ari")).toBe(true)
    expect(trusted.records.get("t")?.externalIds).toEqual([])

    const lower = new MemoryStore([owner({ trustLevel: "stranger" }), person({ id: "t", name: "Target", trustLevel: "family" })])
    const down = await linkExternalId(lower, "t", { provider: "telegram-user", externalId: "42" })
    expect(down.status).toBe("conflict_requires_operator")
  })

  it("refuses when the orphan is revoked", async () => {
    const store = new MemoryStore([owner({ trustLevel: "stranger", admissionState: "revoked" }), person({ id: "t", name: "Target" })])
    const result = await linkExternalId(store, "t", { provider: "telegram-user", externalId: "42" })
    expect(result.status).toBe("conflict_requires_operator")
    expect(store.records.has("ari")).toBe(true)
  })

  it("finishes an interrupted merge on retry instead of returning noop", async () => {
    const store = new MemoryStore([owner({ trustLevel: "stranger", notes: { n: { value: "v", savedAt: NOW } } }), person({ id: "t", name: "Target" })])
    store.failDeleteOnce = "ari"
    await expect(linkExternalId(store, "t", { provider: "telegram-user", externalId: "42" })).rejects.toThrow("disk hiccup")
    expect(store.records.has("ari")).toBe(true)
    const retry = await linkExternalId(store, "t", { provider: "telegram-user", externalId: "42" })
    expect(retry.status).toBe("merged")
    expect(store.records.has("ari")).toBe(false)
    expect(store.records.get("t")?.externalIds.map((e) => e.externalId)).toEqual(["42"])
    const again = await linkExternalId(store, "t", { provider: "telegram-user", externalId: "42" })
    expect(again.status).toBe("noop")
  })

  it("the retry applies the same refusal rules", async () => {
    const store = new MemoryStore([
      owner({ capabilityProfileId: "p" }),
      person({ id: "t", name: "Target", externalIds: [ariTelegram] }),
    ])
    const result = await linkExternalId(store, "t", { provider: "telegram-user", externalId: "42" })
    expect(result.status).toBe("conflict_requires_operator")
    expect(store.records.has("ari")).toBe(true)
  })
})

describe("unlinkExternalId clears the claim journal (audit finding 14)", () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("an unlinked id stays unlinked for a fresh store instance and findByExternalId", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-unlink-"))
    const path = join(dir, "friends")
    const store = new FileFriendStore(path)
    await store.put("t", person({ id: "t", name: "Target" }))
    const claim = await store.claimExternalId({ externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW }, target: { kind: "link", friendId: "t" } })
    expect(claim.ok).toBe(true)
    expect((await store.get("t"))?.externalIds.map((e) => e.externalId)).toEqual(["42"])

    const result = await unlinkExternalId(store, "t", { provider: "telegram-user", externalId: "42" })
    expect(result.status).toBe("unlinked")

    const fresh = new FileFriendStore(path)
    expect((await fresh.get("t"))?.externalIds).toEqual([])
    expect(await fresh.findByExternalId("telegram-user", "42")).toBeNull()
  })
})
