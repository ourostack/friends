// evaluateAccountMembership — the Increment-1 payoff. Family-via-same_account ONLY
// for a key-verified, in-roster did; TOFU-pin on first contact; changed roster key
// hard-fails. This is NOT a core module, so the test MAY import the crypto: it uses
// the real ed25519RosterVerifier + signRoster (via ../a2a-client/roster-verify with
// the readySodium harness) for the crypto paths, and the identity default for the
// no-crypto path.
import { describe, it, expect } from "vitest"

import { evaluateAccountMembership, MemoryRosterStore } from "../index"
import type { AccountRoster } from "../index"
import { ed25519RosterVerifier, signRoster } from "../a2a-client/roster-verify"
import { readySodium } from "./_sodium"

const NOW = "2026-03-14T18:00:00.000Z"

type Members = AccountRoster["members"]

function signedRoster(sodium: Awaited<ReturnType<typeof readySodium>>, accountKeyPriv: Uint8Array, members: Members, epoch = 1): AccountRoster {
  const body = { accountId: "acct-1", members, epoch }
  const sig = signRoster({ sodium, accountKeyPriv, roster: body })
  return { ...body, sig }
}

describe("evaluateAccountMembership (crypto verifier injected)", () => {
  it("grants family_same_account for a key-verified member, pinning the key on first contact", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const roster = signedRoster(sodium, kp.privateKey, [{ handle: "alice", did: "did:key:zMember" }])
    const store = new MemoryRosterStore()
    const result = await evaluateAccountMembership({
      roster,
      candidateDid: "did:key:zMember",
      rosterKey,
      store,
      verifier: ed25519RosterVerifier(sodium),
    })
    expect(result.decision).toBe("family_same_account")
    // first contact TOFU-pinned the roster key
    expect((await store.getPin("acct-1"))?.rosterKey).toBe(rosterKey)
  })

  it("returns not_member for a bare sibling claim whose did is absent from the roster", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const roster = signedRoster(sodium, kp.privateKey, [{ handle: "alice", did: "did:key:zMember" }])
    const result = await evaluateAccountMembership({
      roster,
      candidateDid: "did:key:zStranger",
      rosterKey,
      store: new MemoryRosterStore(),
      verifier: ed25519RosterVerifier(sodium),
    })
    expect(result.decision).toBe("not_member")
  })

  it("returns unverified when the signature does not verify (tampered roster)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const roster = signedRoster(sodium, kp.privateKey, [{ handle: "alice", did: "did:key:zMember" }])
    // Tamper AFTER signing → sig no longer matches.
    const tampered: AccountRoster = { ...roster, members: [{ handle: "alice", did: "did:key:zMember" }, { handle: "evil", did: "did:key:zEvil" }] }
    const result = await evaluateAccountMembership({
      roster: tampered,
      candidateDid: "did:key:zEvil",
      rosterKey,
      store: new MemoryRosterStore(),
      verifier: ed25519RosterVerifier(sodium),
    })
    expect(result.decision).toBe("unverified")
  })

  it("hard-fails with roster_key_mismatch when a pin exists for a DIFFERENT key (no silent re-pin)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const roster = signedRoster(sodium, kp.privateKey, [{ handle: "alice", did: "did:key:zMember" }])
    const store = new MemoryRosterStore()
    // Pre-pin a DIFFERENT key (K1).
    await store.putPin({ accountId: "acct-1", rosterKey: "K1-different", pinnedAt: NOW })
    const result = await evaluateAccountMembership({
      roster,
      candidateDid: "did:key:zMember",
      rosterKey, // K2
      store,
      verifier: ed25519RosterVerifier(sodium),
    })
    expect(result.decision).toBe("roster_key_mismatch")
    // pin is UNCHANGED (still K1).
    expect((await store.getPin("acct-1"))?.rosterKey).toBe("K1-different")
  })

  it("is idempotent on a same-key re-eval (no error, pin unchanged)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const roster = signedRoster(sodium, kp.privateKey, [{ handle: "alice", did: "did:key:zMember" }])
    const store = new MemoryRosterStore()
    const verifier = ed25519RosterVerifier(sodium)
    const first = await evaluateAccountMembership({ roster, candidateDid: "did:key:zMember", rosterKey, store, verifier })
    const second = await evaluateAccountMembership({ roster, candidateDid: "did:key:zMember", rosterKey, store, verifier })
    expect(first.decision).toBe("family_same_account")
    expect(second.decision).toBe("family_same_account")
    expect((await store.getPin("acct-1"))?.rosterKey).toBe(rosterKey)
  })

  it("returns not_member for an empty-members roster (no throw)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const roster = signedRoster(sodium, kp.privateKey, [])
    const result = await evaluateAccountMembership({
      roster,
      candidateDid: "did:key:zAnyone",
      rosterKey,
      store: new MemoryRosterStore(),
      verifier: ed25519RosterVerifier(sodium),
    })
    expect(result.decision).toBe("not_member")
  })
})

describe("evaluateAccountMembership (identity default, no crypto injected)", () => {
  it("decides membership on did-presence alone for a member when no verifier is wired", async () => {
    // DEFAULT_ROSTER_VERIFIER accepts any well-formed roster → membership turns on
    // did presence. Documents the core-only behavior with no crypto.
    const roster: AccountRoster = { accountId: "acct-1", members: [{ handle: "alice", did: "did:key:zMember" }], epoch: 1, sig: "ignored" }
    const result = await evaluateAccountMembership({
      roster,
      candidateDid: "did:key:zMember",
      rosterKey: "any-key",
      store: new MemoryRosterStore(),
    })
    expect(result.decision).toBe("family_same_account")
  })

  it("returns not_member for a non-member under the identity default", async () => {
    const roster: AccountRoster = { accountId: "acct-1", members: [{ handle: "alice", did: "did:key:zMember" }], epoch: 1, sig: "ignored" }
    const result = await evaluateAccountMembership({
      roster,
      candidateDid: "did:key:zNotIn",
      rosterKey: "any-key",
      store: new MemoryRosterStore(),
    })
    expect(result.decision).toBe("not_member")
  })
})
