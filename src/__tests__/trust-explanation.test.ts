import { describe, it, expect } from "vitest"

import { describeTrustContext, setNervesEmitter } from "../index"
import type { FriendRecord, NervesEvent } from "../index"

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

// same_account basis — when a family relationship is account-derived (the peer is
// a key-verified member of the owner's signed roster), the explanation reflects
// `same_account` rather than the generic `direct`, while keeping the family tier's
// permits/constraints. The hint ONLY applies where the relationship is family.
describe("describeTrustContext — same_account basis", () => {
  it("renders a same_account basis for a family friend when the hint is supplied", () => {
    const e = describeTrustContext({
      friend: friend({ trustLevel: "family" }),
      channel: "cli",
      basisHint: "same_account",
    })
    expect(e.level).toBe("family")
    expect(e.basis).toBe("same_account")
    expect(e.summary.toLowerCase()).toContain("account")
    expect(e.why.toLowerCase()).toContain("roster")
    // family-tier permits/constraints are unchanged.
    expect(e.constraints).toEqual([])
    expect(e.permits.length).toBeGreaterThan(0)
  })

  it("leaves family as direct (byte-for-byte) when no hint is supplied", () => {
    const e = describeTrustContext({ friend: friend({ trustLevel: "family" }), channel: "cli" })
    expect(e.basis).toBe("direct")
    expect(e.summary).toBe("direct family trust")
    expect(e.why).toBe("this relationship is directly trusted rather than inferred through a shared group or cold first contact.")
  })

  it("ignores the same_account hint for a non-family (acquaintance) friend", () => {
    const e = describeTrustContext({
      friend: friend({ trustLevel: "acquaintance" }),
      channel: "teams",
      basisHint: "same_account",
    })
    expect(e.basis).toBe("shared_group")
  })

  it("emits friends.trust_explained with meta.basis reflecting same_account", () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    try {
      describeTrustContext({ friend: friend({ trustLevel: "family" }), channel: "cli", basisHint: "same_account" })
      const explained = seen.find((e) => e.event === "friends.trust_explained")
      expect(explained?.meta?.basis).toBe("same_account")
    } finally {
      setNervesEmitter(null)
    }
  })
})
