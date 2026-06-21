import { describe, it, expect } from "vitest"

import {
  strictPolicy,
  trustImpliedPolicy,
  tieredPolicy,
  DEFAULT_CONSENT_POLICY,
} from "../index"
import type { GrantStore, ShareGrant, ShareScope, TrustLevel, ConsentRecipient } from "../index"

const NOW = new Date("2026-03-14T18:00:00.000Z")

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

function grant(overrides: Partial<ShareGrant> = {}): ShareGrant {
  return {
    id: "g-1",
    subjectFriendId: "f-1",
    recipientAgentId: "agent-2",
    scope: "notes:safe",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function recipient(trustLevel: TrustLevel, agentId = "agent-2"): ConsentRecipient {
  return { agentId, trustLevel }
}

describe("strictPolicy (A1)", () => {
  it("consents only when an effective grant covers (subject, recipient, scope)", async () => {
    const grants = new MemoryGrantStore([grant()])
    expect(
      await strictPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("stranger"), scope: "notes:safe", grants, now: NOW }),
    ).toBe(true)
  })

  it("refuses when no grant exists, even for a family recipient", async () => {
    const grants = new MemoryGrantStore()
    expect(
      await strictPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("family"), scope: "identity", grants, now: NOW }),
    ).toBe(false)
  })

  it("refuses when the grant is for a different scope", async () => {
    const grants = new MemoryGrantStore([grant({ scope: "notes:safe" })])
    expect(
      await strictPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("friend"), scope: "notes:all", grants, now: NOW }),
    ).toBe(false)
  })

  it("refuses when the grant is for a different recipient", async () => {
    const grants = new MemoryGrantStore([grant({ recipientAgentId: "someone-else" })])
    expect(
      await strictPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("friend"), scope: "notes:safe", grants, now: NOW }),
    ).toBe(false)
  })

  it("refuses when the grant is for a different subject", async () => {
    const grants = new MemoryGrantStore([grant({ subjectFriendId: "other" })])
    expect(
      await strictPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("friend"), scope: "notes:safe", grants, now: NOW }),
    ).toBe(false)
  })

  it("refuses when the only matching grant is revoked", async () => {
    const grants = new MemoryGrantStore([grant({ revokedAt: "2026-02-01T00:00:00.000Z" })])
    expect(
      await strictPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("friend"), scope: "notes:safe", grants, now: NOW }),
    ).toBe(false)
  })

  it("refuses when the only matching grant has expired", async () => {
    const grants = new MemoryGrantStore([grant({ expiresAt: "2026-02-01T00:00:00.000Z" })])
    expect(
      await strictPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("friend"), scope: "notes:safe", grants, now: NOW }),
    ).toBe(false)
  })

  it("defaults `now` to the current time when omitted (future expiry still effective)", async () => {
    const grants = new MemoryGrantStore([grant({ expiresAt: "2999-01-01T00:00:00.000Z" })])
    expect(
      await strictPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("friend"), scope: "notes:safe", grants }),
    ).toBe(true)
  })
})

describe("trustImpliedPolicy (A2)", () => {
  it("consents on trust ≥ friend regardless of scope, with no grant", async () => {
    const grants = new MemoryGrantStore()
    expect(
      await trustImpliedPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("friend"), scope: "notes:all", grants, now: NOW }),
    ).toBe(true)
    expect(
      await trustImpliedPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("family"), scope: "outcomes", grants, now: NOW }),
    ).toBe(true)
  })

  it("falls back to the grant check below friend trust — consents with a grant", async () => {
    const grants = new MemoryGrantStore([grant({ scope: "notes:safe" })])
    expect(
      await trustImpliedPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("acquaintance"), scope: "notes:safe", grants, now: NOW }),
    ).toBe(true)
  })

  it("refuses below friend trust with no grant", async () => {
    const grants = new MemoryGrantStore()
    expect(
      await trustImpliedPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("acquaintance"), scope: "notes:safe", grants, now: NOW }),
    ).toBe(false)
    expect(
      await trustImpliedPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("stranger"), scope: "identity", grants, now: NOW }),
    ).toBe(false)
  })
})

describe("tieredPolicy (A3, the default)", () => {
  it("is the module default consent policy", () => {
    expect(DEFAULT_CONSENT_POLICY).toBe(tieredPolicy)
  })

  it("consents identity-scope shares on trust ≥ friend without a grant", async () => {
    const grants = new MemoryGrantStore()
    expect(
      await tieredPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("friend"), scope: "identity", grants, now: NOW }),
    ).toBe(true)
    expect(
      await tieredPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("family"), scope: "name", grants, now: NOW }),
    ).toBe(true)
  })

  it("refuses identity-scope shares below friend trust", async () => {
    const grants = new MemoryGrantStore()
    expect(
      await tieredPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("acquaintance"), scope: "identity", grants, now: NOW }),
    ).toBe(false)
  })

  it("requires an explicit grant for note-content scopes even at family trust", async () => {
    const grants = new MemoryGrantStore()
    expect(
      await tieredPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("family"), scope: "notes:safe", grants, now: NOW }),
    ).toBe(false)
    expect(
      await tieredPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("family"), scope: "outcomes", grants, now: NOW }),
    ).toBe(false)
  })

  it("consents note-content scopes when an explicit grant covers them", async () => {
    const grants = new MemoryGrantStore([grant({ scope: "notes:all" })])
    expect(
      await tieredPolicy.consents({ subjectFriendId: "f-1", recipient: recipient("stranger"), scope: "notes:all", grants, now: NOW }),
    ).toBe(true)
  })

  it("exposes a stable policy name for observability", () => {
    expect(strictPolicy.name).toBe("strict")
    expect(trustImpliedPolicy.name).toBe("trust_implied")
    expect(tieredPolicy.name).toBe("tiered")
  })
})

// Type-only guard: ShareScope is a real exported union usable as an annotation.
const _scope: ShareScope = "notes:safe"
void _scope
