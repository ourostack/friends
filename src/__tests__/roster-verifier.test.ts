import { describe, it, expect } from "vitest"

import { identityRosterVerifier, DEFAULT_ROSTER_VERIFIER, setNervesEmitter } from "../index"
import type { AccountRoster, NervesEvent } from "../index"

function roster(overrides: Partial<AccountRoster> = {}): AccountRoster {
  return {
    accountId: "acct-1",
    members: [{ handle: "alice", did: "did:key:zA" }],
    epoch: 1,
    sig: "anything",
    ...overrides,
  }
}

describe("identityRosterVerifier (core, crypto-free)", () => {
  it("accepts any well-formed roster without checking the sig (TOFU-equivalent)", () => {
    expect(identityRosterVerifier.verify(roster({ sig: "ignored" }), "any-key")).toBe(true)
  })

  it("emits friends.roster_verified on a verify", () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    try {
      identityRosterVerifier.verify(roster(), "k")
      expect(seen.some((e) => e.event === "friends.roster_verified")).toBe(true)
    } finally {
      setNervesEmitter(null)
    }
  })

  it("is the DEFAULT_ROSTER_VERIFIER", () => {
    expect(DEFAULT_ROSTER_VERIFIER).toBe(identityRosterVerifier)
  })
})
