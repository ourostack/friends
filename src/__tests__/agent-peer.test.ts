import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { upsertAgentPeer, FileFriendStore, setNervesEmitter } from "../index"
import type { FriendStore, FriendRecord } from "../index"
import type { NervesEvent } from "../index"

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
    name: "OldName",
    role: "agent-peer",
    trustLevel: "acquaintance",
    connections: [],
    externalIds: [{ provider: "a2a-agent", externalId: "peer-1", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "agent",
    agentMeta: {
      bundleName: "ExistingBundle",
      familiarity: 5,
      sharedMissions: ["m1"],
      outcomes: [],
      a2a: { agentId: "peer-1", cardUrl: "https://card" },
    },
    ...overrides,
  }
}

describe("upsertAgentPeer — new peer", () => {
  it("mints a new agent record with sensible defaults", async () => {
    const store = new MemoryStore()
    const record = await upsertAgentPeer(store, { name: "PeerBot", agentId: "peer-1" })
    expect(record.name).toBe("PeerBot")
    expect(record.role).toBe("agent-peer")
    expect(record.kind).toBe("agent")
    expect(record.trustLevel).toBe("acquaintance")
    expect(record.agentMeta?.bundleName).toBe("PeerBot")
    expect(record.agentMeta?.familiarity).toBe(0)
    expect(record.agentMeta?.sharedMissions).toEqual([])
    expect(record.agentMeta?.outcomes).toEqual([])
    expect(record.agentMeta?.a2a?.agentId).toBe("peer-1")
    expect(record.externalIds).toEqual([
      { provider: "a2a-agent", externalId: "peer-1", linkedAt: expect.any(String) },
    ])
    expect(record.id).toBeTruthy()
    expect(record.createdAt).toBeTruthy()
    expect(store.putCalls).toBe(1)
  })

  it("uses an explicit trustLevel and bundleName when minting", async () => {
    const store = new MemoryStore()
    const record = await upsertAgentPeer(store, {
      name: "PeerBot",
      agentId: "peer-1",
      trustLevel: "friend",
      bundleName: "MyBundle",
    })
    expect(record.trustLevel).toBe("friend")
    expect(record.agentMeta?.bundleName).toBe("MyBundle")
  })

  it("spreads the passed a2a coords (with agentId injected) into agentMeta.a2a", async () => {
    const store = new MemoryStore()
    const record = await upsertAgentPeer(store, {
      name: "PeerBot",
      agentId: "peer-1",
      a2a: { cardUrl: "https://card", endpointUrl: "https://ep", protocolVersion: "1.0" },
    })
    expect(record.agentMeta?.a2a).toEqual({
      cardUrl: "https://card",
      endpointUrl: "https://ep",
      protocolVersion: "1.0",
      agentId: "peer-1",
    })
  })

  it("falls back bundleName to name when neither bundleName is given", async () => {
    const store = new MemoryStore()
    const record = await upsertAgentPeer(store, { name: "OnlyName", agentId: "peer-9" })
    expect(record.agentMeta?.bundleName).toBe("OnlyName")
  })

  it("threads an explicit top-level mailbox onto agentMeta.mailbox (top-level since the demote), NOT into a2a", async () => {
    const store = new MemoryStore()
    const record = await upsertAgentPeer(store, {
      name: "PeerBot",
      agentId: "peer-1",
      mailbox: { repo: "/m/mailbox", selfOutboxAgentId: "agent-a" },
    })
    // mailbox lands top-level …
    expect(record.agentMeta?.mailbox).toEqual({ repo: "/m/mailbox", selfOutboxAgentId: "agent-a" })
    // … and a2a carries only its own coords + the folded agentId (no mailbox key).
    expect(record.agentMeta?.a2a).toEqual({ agentId: "peer-1" })
    expect(record.agentMeta?.a2a && "mailbox" in record.agentMeta.a2a).toBe(false)
  })

  it("omits the mailbox key entirely when no mailbox is passed (schemaVersion-1 unchanged)", async () => {
    const store = new MemoryStore()
    const record = await upsertAgentPeer(store, { name: "PeerBot", agentId: "peer-1" })
    expect(record.agentMeta?.a2a).toEqual({ agentId: "peer-1" })
    expect(record.agentMeta && "mailbox" in record.agentMeta).toBe(false)
  })

  it("lets an explicit top-level mailbox override the existing record's top-level mailbox", async () => {
    const store = new MemoryStore([
      agentRecord({
        agentMeta: {
          bundleName: "ExistingBundle",
          familiarity: 5,
          sharedMissions: ["m1"],
          outcomes: [],
          a2a: { agentId: "peer-1" },
          mailbox: { repo: "/existing", selfOutboxAgentId: "existing-out" },
        },
      }),
    ])
    const record = await upsertAgentPeer(store, {
      name: "PeerBot",
      agentId: "peer-1",
      mailbox: { repo: "/explicit", selfOutboxAgentId: "agent-a" },
    })
    expect(record.agentMeta?.mailbox).toEqual({ repo: "/explicit", selfOutboxAgentId: "agent-a" })
  })

  it("carries the existing record's top-level mailbox forward when no mailbox is passed", async () => {
    const store = new MemoryStore([
      agentRecord({
        agentMeta: {
          bundleName: "ExistingBundle",
          familiarity: 5,
          sharedMissions: ["m1"],
          outcomes: [],
          a2a: { agentId: "peer-1" },
          mailbox: { repo: "/existing", selfOutboxAgentId: "existing-out" },
        },
      }),
    ])
    const record = await upsertAgentPeer(store, { name: "PeerBot", agentId: "peer-1" })
    // baseMeta spread carries the existing top-level mailbox; no input override.
    expect(record.agentMeta?.mailbox).toEqual({ repo: "/existing", selfOutboxAgentId: "existing-out" })
  })
})

describe("upsertAgentPeer — existing peer", () => {
  it("preserves id/createdAt, updates name, replaces a2a wholesale, replaces the a2a externalId", async () => {
    const store = new MemoryStore([agentRecord()])
    const record = await upsertAgentPeer(store, {
      name: "NewName",
      agentId: "peer-1",
      a2a: { endpointUrl: "https://new-ep" },
    })
    expect(record.id).toBe("agent-1")
    expect(record.createdAt).toBe(NOW)
    expect(record.name).toBe("NewName")
    // a2a is REPLACED wholesale from the passed coords (mirrors the harness,
    // which rebuilds a2a from the freshly-fetched card each time), with agentId
    // injected — the prior cardUrl is intentionally NOT carried forward.
    expect(record.agentMeta?.a2a).toEqual({
      agentId: "peer-1",
      endpointUrl: "https://new-ep",
    })
    // existing bundleName (truthy) wins over name
    expect(record.agentMeta?.bundleName).toBe("ExistingBundle")
    // preserved familiarity / sharedMissions
    expect(record.agentMeta?.familiarity).toBe(5)
    expect(record.agentMeta?.sharedMissions).toEqual(["m1"])
    // exactly one a2a-agent externalId for peer-1 (no dup)
    expect(record.externalIds.filter((e) => e.provider === "a2a-agent" && e.externalId === "peer-1")).toHaveLength(1)
  })

  it("lands a new mailbox top-level on update; a2a is rebuilt wholesale without it", async () => {
    const store = new MemoryStore([agentRecord()])
    const record = await upsertAgentPeer(store, {
      name: "NewName",
      agentId: "peer-1",
      mailbox: { repo: "/m/mailbox", selfOutboxAgentId: "agent-b" },
    })
    // mailbox is top-level (since the demote) …
    expect(record.agentMeta?.mailbox).toEqual({ repo: "/m/mailbox", selfOutboxAgentId: "agent-b" })
    // … a2a is rebuilt wholesale (prior cardUrl dropped), no mailbox key inside it.
    expect(record.agentMeta?.a2a).toEqual({ agentId: "peer-1" })
  })

  it("keeps the existing trustLevel when none is passed", async () => {
    const store = new MemoryStore([agentRecord({ trustLevel: "family" })])
    const record = await upsertAgentPeer(store, { name: "X", agentId: "peer-1" })
    expect(record.trustLevel).toBe("family")
  })

  it("lets an explicit trustLevel override the existing one", async () => {
    const store = new MemoryStore([agentRecord({ trustLevel: "acquaintance" })])
    const record = await upsertAgentPeer(store, { name: "X", agentId: "peer-1", trustLevel: "friend" })
    expect(record.trustLevel).toBe("friend")
  })

  it("falls back bundleName to the passed bundleName when existing meta has an empty one", async () => {
    const store = new MemoryStore([
      agentRecord({
        agentMeta: { bundleName: "", familiarity: 0, sharedMissions: [], outcomes: [] },
      }),
    ])
    const record = await upsertAgentPeer(store, { name: "X", agentId: "peer-1", bundleName: "Fallback" })
    expect(record.agentMeta?.bundleName).toBe("Fallback")
  })

  it("falls back bundleName all the way to name when existing meta is empty and no bundleName is passed", async () => {
    const store = new MemoryStore([
      agentRecord({
        agentMeta: { bundleName: "", familiarity: 0, sharedMissions: [], outcomes: [] },
      }),
    ])
    const record = await upsertAgentPeer(store, { name: "NameFallback", agentId: "peer-1" })
    expect(record.agentMeta?.bundleName).toBe("NameFallback")
  })
})

describe("upsertAgentPeer — FileFriendStore end-to-end", () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("persists a full agent record that reloads with kind:agent + agentMeta", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-agent-"))
    const store = new FileFriendStore(join(dir, "friends"))
    await upsertAgentPeer(store, {
      name: "DiskPeer",
      agentId: "disk-peer",
      trustLevel: "friend",
      a2a: { cardUrl: "https://card" },
    })
    const reloaded = await store.findByExternalId("a2a-agent", "disk-peer")
    expect(reloaded?.kind).toBe("agent")
    expect(reloaded?.trustLevel).toBe("friend")
    expect(reloaded?.agentMeta?.bundleName).toBe("DiskPeer")
    expect(reloaded?.agentMeta?.a2a?.agentId).toBe("disk-peer")
  })
})

// Bug A — cold A2A contact must be SAFE-BY-DEFAULT (stranger), but every
// explicit-trust path (an owner-initiated onboard, or an existing record's level)
// must still win. The fallback was `acquaintance` (too trusting for a cold peer).
describe("upsertAgentPeer — Bug A: safe-default cold contact", () => {
  it("defaults a brand-new cold peer (no trustLevel, no existing record) to stranger", async () => {
    const store = new MemoryStore()
    const record = await upsertAgentPeer(store, { name: "ColdPeer", agentId: "cold-1" })
    expect(record.trustLevel).toBe("stranger")
  })

  it("an explicit trustLevel still wins over the stranger fallback (acquaintance)", async () => {
    const store = new MemoryStore()
    const record = await upsertAgentPeer(store, { name: "P", agentId: "p-1", trustLevel: "acquaintance" })
    expect(record.trustLevel).toBe("acquaintance")
  })

  it("an explicit family trustLevel survives (owner-initiated onboard path)", async () => {
    const store = new MemoryStore()
    const record = await upsertAgentPeer(store, { name: "P", agentId: "p-2", trustLevel: "family" })
    expect(record.trustLevel).toBe("family")
  })

  it("an existing record's trustLevel is preserved over the stranger fallback", async () => {
    const store = new MemoryStore([agentRecord({ trustLevel: "friend" })])
    const record = await upsertAgentPeer(store, { name: "X", agentId: "peer-1" })
    expect(record.trustLevel).toBe("friend")
  })

  it("emits friends.agent_peer_upserted with meta.trustLevel reflecting the resolved (stranger) default", async () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    try {
      const store = new MemoryStore()
      await upsertAgentPeer(store, { name: "ColdPeer", agentId: "cold-3" })
      const upserted = seen.find((e) => e.event === "friends.agent_peer_upserted")
      expect(upserted?.meta?.trustLevel).toBe("stranger")
    } finally {
      setNervesEmitter(null)
    }
  })
})
