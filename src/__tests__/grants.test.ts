import { describe, it, expect } from "vitest"

import { grantShare, revokeShare, listShares, isGrantEffective } from "../index"
import type { GrantStore, ShareGrant } from "../index"

const NOW = new Date("2026-03-14T18:00:00.000Z")

class MemoryGrantStore implements GrantStore {
  readonly grants = new Map<string, ShareGrant>()
  putCalls = 0
  constructor(initial: ShareGrant[] = []) {
    for (const g of initial) this.grants.set(g.id, g)
  }
  async get(id: string) {
    return this.grants.get(id) ?? null
  }
  async put(id: string, grant: ShareGrant) {
    this.putCalls += 1
    this.grants.set(id, grant)
  }
  async delete(id: string) {
    this.grants.delete(id)
  }
  async listAll() {
    return Array.from(this.grants.values())
  }
}

function grant(overrides: Partial<ShareGrant> = {}): ShareGrant {
  return {
    id: "g-1",
    subjectKey: "f-1",
    recipientAgentId: "agent-2",
    scope: "notes:safe",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("isGrantEffective", () => {
  it("is effective when neither revoked nor expired", () => {
    expect(isGrantEffective(grant(), NOW)).toBe(true)
  })
  it("is not effective when revoked", () => {
    expect(isGrantEffective(grant({ revokedAt: "2026-02-01T00:00:00.000Z" }), NOW)).toBe(false)
  })
  it("is not effective at or past the expiry", () => {
    expect(isGrantEffective(grant({ expiresAt: "2026-02-01T00:00:00.000Z" }), NOW)).toBe(false)
    expect(isGrantEffective(grant({ expiresAt: NOW.toISOString() }), NOW)).toBe(false)
  })
  it("is effective before the expiry", () => {
    expect(isGrantEffective(grant({ expiresAt: "2999-01-01T00:00:00.000Z" }), NOW)).toBe(true)
  })
  it("defaults `now` to the current time when omitted", () => {
    expect(isGrantEffective(grant({ expiresAt: "2999-01-01T00:00:00.000Z" }))).toBe(true)
  })
})

describe("grantShare", () => {
  it("mints a grant with a fresh id and persists it", async () => {
    const grants = new MemoryGrantStore()
    const g = await grantShare(grants, { subjectKey: "f-1", recipientAgentId: "agent-2", scope: "notes:all" })
    expect(g.id).toBeTruthy()
    expect(g.subjectKey).toBe("f-1")
    expect(g.recipientAgentId).toBe("agent-2")
    expect(g.scope).toBe("notes:all")
    expect(g.revokedAt).toBeUndefined()
    expect(await grants.get(g.id)).toEqual(g)
  })

  it("carries an explicit expiresAt when provided", async () => {
    const grants = new MemoryGrantStore()
    const g = await grantShare(grants, {
      subjectKey: "f-1",
      recipientAgentId: "agent-2",
      scope: "identity",
      expiresAt: "2027-01-01T00:00:00.000Z",
    })
    expect(g.expiresAt).toBe("2027-01-01T00:00:00.000Z")
  })

  it("omits expiresAt when not provided", async () => {
    const grants = new MemoryGrantStore()
    const g = await grantShare(grants, { subjectKey: "f-1", recipientAgentId: "agent-2", scope: "name" })
    expect("expiresAt" in g).toBe(false)
  })
})

describe("revokeShare", () => {
  it("revokes a live grant by setting revokedAt", async () => {
    const grants = new MemoryGrantStore([grant()])
    const result = await revokeShare(grants, "g-1")
    expect(result.ok).toBe(true)
    expect(result.status).toBe("revoked")
    expect(result.grant?.revokedAt).toBeTruthy()
    expect((await grants.get("g-1"))?.revokedAt).toBeTruthy()
  })

  it("returns not_found for a missing grant", async () => {
    const grants = new MemoryGrantStore()
    const result = await revokeShare(grants, "ghost")
    expect(result.ok).toBe(false)
    expect(result.status).toBe("not_found")
    expect(grants.putCalls).toBe(0)
  })

  it("re-revoking an already-revoked grant is a noop (no second write)", async () => {
    const grants = new MemoryGrantStore([grant({ revokedAt: "2026-02-01T00:00:00.000Z" })])
    const result = await revokeShare(grants, "g-1")
    expect(result.ok).toBe(true)
    expect(result.status).toBe("noop")
    expect(grants.putCalls).toBe(0)
  })
})

describe("listShares", () => {
  const live = grant({ id: "live", recipientAgentId: "a", scope: "identity" })
  const revoked = grant({ id: "revoked", recipientAgentId: "a", scope: "notes:safe", revokedAt: "2026-02-01T00:00:00.000Z" })
  const otherSubject = grant({ id: "other", subjectKey: "f-2", recipientAgentId: "b", scope: "outcomes" })

  it("returns all grants with their effective flag", async () => {
    const grants = new MemoryGrantStore([live, revoked, otherSubject])
    const all = await listShares(grants)
    expect(all).toHaveLength(3)
    expect(all.find((g) => g.id === "live")?.effective).toBe(true)
    expect(all.find((g) => g.id === "revoked")?.effective).toBe(false)
  })

  it("filters by subject", async () => {
    const grants = new MemoryGrantStore([live, revoked, otherSubject])
    const result = await listShares(grants, { subjectKey: "f-2" })
    expect(result.map((g) => g.id)).toEqual(["other"])
  })

  it("filters by recipient", async () => {
    const grants = new MemoryGrantStore([live, revoked, otherSubject])
    const result = await listShares(grants, { recipientAgentId: "a" })
    expect(result.map((g) => g.id).sort()).toEqual(["live", "revoked"])
  })

  it("filters to effective-only when requested", async () => {
    const grants = new MemoryGrantStore([live, revoked, otherSubject])
    const result = await listShares(grants, { effectiveOnly: true })
    expect(result.map((g) => g.id).sort()).toEqual(["live", "other"])
  })

  it("returns an empty list when nothing matches", async () => {
    const grants = new MemoryGrantStore([live])
    expect(await listShares(grants, { recipientAgentId: "nobody" })).toEqual([])
  })
})
