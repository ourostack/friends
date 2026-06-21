import { describe, it, expect } from "vitest"

import { describeTrustContext } from "../index"
import type { FriendRecord } from "../index"

function friend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "f-1",
    name: "Person",
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

describe("describeTrustContext", () => {
  it("describes family as direct trust with no constraints", () => {
    const e = describeTrustContext({ friend: friend({ trustLevel: "family" }), channel: "cli" })
    expect(e.level).toBe("family")
    expect(e.basis).toBe("direct")
    expect(e.summary).toBe("direct family trust")
    expect(e.constraints).toEqual([])
    expect(e.permits.length).toBeGreaterThan(0)
  })

  it("describes friend as direct trust", () => {
    const e = describeTrustContext({ friend: friend({ trustLevel: "friend" }), channel: "teams" })
    expect(e.level).toBe("friend")
    expect(e.basis).toBe("direct")
    expect(e.summary).toBe("direct trusted relationship")
    expect(e.constraints).toEqual([])
  })

  it("describes acquaintance as shared_group trust with guarded constraints", () => {
    const e = describeTrustContext({ friend: friend({ trustLevel: "acquaintance" }), channel: "bluebubbles" })
    expect(e.level).toBe("acquaintance")
    expect(e.basis).toBe("shared_group")
    expect(e.summary).toBe("known through a shared group context")
    expect(e.constraints.length).toBeGreaterThan(0)
    expect(e.relatedGroupId).toBeUndefined()
  })

  it("surfaces the related group id for an acquaintance linked to a group", () => {
    const e = describeTrustContext({
      friend: friend({
        trustLevel: "acquaintance",
        externalIds: [{ provider: "imessage-handle", externalId: "group:any;+;g1", linkedAt: "2026-01-01T00:00:00.000Z" }],
      }),
      channel: "bluebubbles",
    })
    expect(e.relatedGroupId).toBe("group:any;+;g1")
    expect(e.summary).toBe("known through the shared project group")
    expect(e.why).toContain("group:any;+;g1")
  })

  it("describes stranger as unknown first-contact trust", () => {
    const e = describeTrustContext({ friend: friend({ trustLevel: "stranger" }), channel: "mail" })
    expect(e.level).toBe("stranger")
    expect(e.basis).toBe("unknown")
    expect(e.summary).toBe("truly unknown first-contact context")
    expect(e.constraints.length).toBeGreaterThan(0)
  })

  it("defaults a record with no trust level to stranger", () => {
    const e = describeTrustContext({ friend: friend({ trustLevel: undefined }), channel: "cli" })
    expect(e.level).toBe("stranger")
    expect(e.basis).toBe("unknown")
  })
})
