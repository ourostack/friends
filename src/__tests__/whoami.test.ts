import { describe, it, expect, afterEach } from "vitest"

import { whoami, _setMachineOwnerUsernameForTest } from "../index"
import type { FriendStore, FriendRecord, IdentityProvider } from "../index"

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
    name: "Self",
    role: "family",
    trustLevel: "family",
    connections: [],
    externalIds: [{ provider: "local" as IdentityProvider, externalId: "operator", linkedAt: NOW }],
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

describe("whoami", () => {
  afterEach(() => {
    _setMachineOwnerUsernameForTest(undefined)
  })

  it("resolves the self friend by a local external id matching the owner username", async () => {
    _setMachineOwnerUsernameForTest("operator")
    const store = new MemoryStore([friend()])
    const result = await whoami(store)
    expect(result.machineOwner).toBe("operator")
    expect(result.selfFriendId).toBe("f-1")
    expect(result.selfAgentName).toBe("Self")
  })

  it("matches a user@host local external id via the startsWith rule", async () => {
    _setMachineOwnerUsernameForTest("operator")
    const store = new MemoryStore([
      friend({ externalIds: [{ provider: "local", externalId: "operator@box", linkedAt: NOW }] }),
    ])
    const result = await whoami(store)
    expect(result.selfFriendId).toBe("f-1")
  })

  it("falls back to the first family friend when no local id matches", async () => {
    _setMachineOwnerUsernameForTest("operator")
    const store = new MemoryStore([
      friend({
        id: "fam",
        name: "Family Member",
        externalIds: [{ provider: "aad", externalId: "someone", linkedAt: NOW }],
      }),
    ])
    const result = await whoami(store)
    expect(result.selfFriendId).toBe("fam")
    expect(result.selfAgentName).toBe("Family Member")
  })

  it("returns only the owner when the owner is null", async () => {
    _setMachineOwnerUsernameForTest(null)
    const store = new MemoryStore([friend()])
    const result = await whoami(store)
    expect(result.machineOwner).toBeNull()
    expect(result.selfFriendId).toBeUndefined()
    expect(result.selfAgentName).toBeUndefined()
  })

  it("returns only the owner when the store has no listAll", async () => {
    _setMachineOwnerUsernameForTest("operator")
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
    const result = await whoami(noListAll)
    expect(result.machineOwner).toBe("operator")
    expect(result.selfFriendId).toBeUndefined()
  })

  it("returns only the owner when no friend matches at all", async () => {
    _setMachineOwnerUsernameForTest("operator")
    const store = new MemoryStore([
      friend({
        id: "stranger",
        trustLevel: "stranger",
        role: "stranger",
        externalIds: [{ provider: "aad", externalId: "x", linkedAt: NOW }],
      }),
    ])
    const result = await whoami(store)
    expect(result.machineOwner).toBe("operator")
    expect(result.selfFriendId).toBeUndefined()
    expect(result.selfAgentName).toBeUndefined()
  })
})
