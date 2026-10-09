import { describe, it, expect } from "vitest"

import {
  prepareProfileShare,
  importProfileShare,
  tieredPolicy,
  FileFriendStore,
  FriendResolver,
} from "../index"
import type {
  FriendStore,
  GrantStore,
  FriendRecord,
  ShareGrant,
  ProfileShareEnvelope,
  ConsentRecipient,
  TrustLevel,
} from "../index"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

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
  async findByExternalId(provider: string, externalId: string) {
    for (const r of this.records.values()) {
      if (r.externalIds.some((e) => e.provider === provider && e.externalId === externalId)) return r
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

function person(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "sam",
    name: "Sam",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [{ provider: "telegram-user", externalId: "555", linkedAt: NOW }],
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

function peer(trustLevel: TrustLevel): FriendRecord {
  return person({
    id: "peer",
    name: "Peer",
    role: "agent-peer",
    trustLevel,
    kind: "agent",
    externalIds: [{ provider: "a2a-agent", externalId: "agent-2", linkedAt: NOW }],
  })
}

function recipient(trustLevel: TrustLevel): ConsentRecipient {
  return { agentId: "agent-2", trustLevel }
}

describe("prepareProfileShare sends external ids only where they are warranted (audit finding 18)", () => {
  it("sends no external ids under the name scope, even to a family recipient", async () => {
    const store = new MemoryStore([person(), peer("family")])
    const result = await prepareProfileShare(store, new MemoryGrantStore(), { friendId: "sam", toAgentId: "agent-2", scope: "name", selfAgentId: "self" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.subject.externalIds).toEqual([])
      expect(result.envelope.subject.displayName).toBe("Sam")
    }
  })

  it("sends external ids under the identity scope", async () => {
    const store = new MemoryStore([person(), peer("family")])
    const result = await prepareProfileShare(store, new MemoryGrantStore(), { friendId: "sam", toAgentId: "agent-2", scope: "identity", selfAgentId: "self" })
    expect(result.ok && result.envelope.subject.externalIds.map((e) => e.externalId)).toEqual(["555"])
  })

  it("tieredPolicy needs an explicit grant for identity below family, and none at family", async () => {
    const grants = new MemoryGrantStore()
    for (const tier of ["friend", "acquaintance", "stranger"] as const) {
      expect(await tieredPolicy.consents({ subjectKey: "sam", recipient: recipient(tier), scope: "identity", grants })).toBe(false)
    }
    expect(await tieredPolicy.consents({ subjectKey: "sam", recipient: recipient("family"), scope: "identity", grants })).toBe(true)
    const granted = new MemoryGrantStore([{ id: "g", subjectKey: "sam", recipientAgentId: "agent-2", scope: "identity", grantedAt: NOW }])
    expect(await tieredPolicy.consents({ subjectKey: "sam", recipient: recipient("friend"), scope: "identity", grants: granted })).toBe(true)
  })

  it("a friend recipient with no grant cannot get Sam's account ids through the default policy", async () => {
    const store = new MemoryStore([person(), peer("friend")])
    const result = await prepareProfileShare(store, new MemoryGrantStore(), { friendId: "sam", toAgentId: "agent-2", scope: "identity", selfAgentId: "self" })
    expect(result).toEqual({ ok: false, status: "no_consent" })
  })
})

function aboutStranger(): ProfileShareEnvelope {
  return {
    subject: { externalIds: [{ provider: "telegram-user", externalId: "555", tenantId: "t9", linkedAt: NOW }], displayName: "Ari's bank" },
    fromAgentId: "peer",
    scope: "notes:safe",
    notes: [{ key: "trust", value: "very reliable" }],
    issuedAt: NOW,
  }
}

describe("importProfileShare seeds at stranger and never indexes the peer's ids (audit findings 9, V3)", () => {
  it("seeds at stranger with the ids held as unverified claims", async () => {
    const store = new MemoryStore()
    const result = await importProfileShare(store, { envelope: aboutStranger(), fromAgentId: "peer", trustOfSource: "friend" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe("seeded")
    expect(result.record.trustLevel).toBe("stranger")
    expect(result.record.externalIds).toEqual([])
    expect(result.record.importedExternalIds).toEqual([
      { provider: "telegram-user", externalId: "555", tenantId: "t9", assertedBy: { agentId: "peer" }, importedAt: expect.any(String) },
    ])
  })

  it("the real person later does not resolve to the seeded record", async () => {
    const store = new MemoryStore()
    const seeded = await importProfileShare(store, { envelope: aboutStranger(), fromAgentId: "peer", trustOfSource: "friend" })
    expect(await store.findByExternalId("telegram-user", "555")).toBeNull()
    const ctx = await new FriendResolver(store, { provider: "telegram-user", externalId: "555", displayName: "Real User", channel: "telegram" }).resolve()
    expect(seeded.ok && ctx.friend.id).not.toBe(seeded.ok && seeded.record.id)
    expect(ctx.friend.name).not.toBe("Ari's bank")
  })

  it("persists the claims in the file store without indexing or claiming them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-import-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      const result = await importProfileShare(store, { envelope: aboutStranger(), fromAgentId: "peer", trustOfSource: "friend" })
      expect(result.ok).toBe(true)
      const fresh = new FileFriendStore(join(dir, "friends"))
      expect(await fresh.findByExternalId("telegram-user", "555")).toBeNull()
      const stored = result.ok ? await fresh.get(result.record.id) : null
      expect(stored?.importedExternalIds?.[0]?.externalId).toBe("555")
      expect(stored?.externalIds).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a second share about the same unknown party from the same peer updates the seeded record instead of seeding a duplicate", async () => {
    const store = new MemoryStore()
    await importProfileShare(store, { envelope: aboutStranger(), fromAgentId: "peer", trustOfSource: "friend" })
    const again = await importProfileShare(store, { envelope: aboutStranger(), fromAgentId: "peer", trustOfSource: "friend" })
    expect(again.ok && again.status).toBe("imported")
    expect(store.records.size).toBe(1)
  })

  it("seeds a fresh record when the store cannot list records to dedupe against", async () => {
    const store = new MemoryStore()
    ;(store as { listAll?: unknown }).listAll = undefined
    const first = await importProfileShare(store, { envelope: aboutStranger(), fromAgentId: "peer", trustOfSource: "friend" })
    expect(first.ok && first.status).toBe("seeded")
  })

  it("seeds with no claims when the share carried no external ids", async () => {
    const store = new MemoryStore()
    const env = { ...aboutStranger(), subject: { externalIds: [], displayName: "Nameless" } }
    const result = await importProfileShare(store, { envelope: env, fromAgentId: "peer", trustOfSource: "friend" })
    expect(result.ok && result.record.importedExternalIds).toBeUndefined()
  })

  it("a claim from a different peer, or with a different tenant, does not match the seeded record", async () => {
    const store = new MemoryStore([person({ id: "unrelated", name: "Unrelated", externalIds: [] })])
    await importProfileShare(store, { envelope: aboutStranger(), fromAgentId: "peer", trustOfSource: "friend" })
    const other = await importProfileShare(store, { envelope: aboutStranger(), fromAgentId: "other", trustOfSource: "friend" })
    expect(other.ok && other.status).toBe("seeded")
    const env = aboutStranger()
    env.subject.externalIds[0].tenantId = "t-other"
    const tenant = await importProfileShare(store, { envelope: env, fromAgentId: "peer", trustOfSource: "friend" })
    expect(tenant.ok && tenant.status).toBe("seeded")
  })

  it("appends new ids from a repeat share by the same peer, without duplicating known ones", async () => {
    const store = new MemoryStore()
    await importProfileShare(store, { envelope: aboutStranger(), fromAgentId: "peer", trustOfSource: "friend" })
    const env = aboutStranger()
    env.subject.externalIds.push({ provider: "email-address", externalId: "bank@example.com", linkedAt: NOW })
    const again = await importProfileShare(store, { envelope: env, fromAgentId: "peer", trustOfSource: "friend" })
    expect(again.ok && again.status).toBe("imported")
    const claims = again.ok ? again.record.importedExternalIds : undefined
    expect(claims?.map((c) => c.externalId)).toEqual(["555", "bank@example.com"])
    const third = await importProfileShare(store, { envelope: env, fromAgentId: "peer", trustOfSource: "friend" })
    expect(third.ok && third.record.importedExternalIds).toHaveLength(2)
  })

  it("does not record a claim for an id the record already holds as a real identity", async () => {
    const store = new MemoryStore([person()])
    const env = aboutStranger()
    delete env.subject.externalIds[0].tenantId
    const result = await importProfileShare(store, { envelope: env, fromAgentId: "peer", trustOfSource: "friend" })
    expect(result.ok && result.status).toBe("imported")
    expect(result.ok && result.record.importedExternalIds).toBeUndefined()
  })
})
