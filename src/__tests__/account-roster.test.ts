// evaluateAccountMembership — the Increment-1 payoff. Family-via-same_account ONLY
// for a key-verified, in-roster did; TOFU-pin on first contact; changed roster key
// hard-fails. This is NOT a core module, so the test MAY import the crypto: it uses
// the real ed25519RosterVerifier + signRoster (via ../a2a-client/roster-verify with
// the readySodium harness) for the crypto paths, and the identity default for the
// no-crypto path.
import { describe, it, expect } from "vitest"

import { evaluateAccountMembership, MemoryRosterStore, verifiedCandidate, DEFAULT_ROSTER_VERIFIER, setNervesEmitter, _resetRosterVerifierWarningForTest } from "../index"
import type { AccountRoster, NervesEvent } from "../index"
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
      candidate: verifiedCandidate("did:key:zMember"),
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
      candidate: verifiedCandidate("did:key:zStranger"),
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
      candidate: verifiedCandidate("did:key:zEvil"),
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
      candidate: verifiedCandidate("did:key:zMember"),
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
    const first = await evaluateAccountMembership({ roster, candidate: verifiedCandidate("did:key:zMember"), rosterKey, store, verifier })
    const second = await evaluateAccountMembership({ roster, candidate: verifiedCandidate("did:key:zMember"), rosterKey, store, verifier })
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
      candidate: verifiedCandidate("did:key:zAnyone"),
      rosterKey,
      store: new MemoryRosterStore(),
      verifier: ed25519RosterVerifier(sodium),
    })
    expect(result.decision).toBe("not_member")
  })
})

// SECURITY (finding 1, HIGH): the family-granting path must NEVER produce a family
// grant via the identity-only default. The identity verifier ignores the sig, so a
// garbage-signed roster would otherwise grant family to any did it lists. With no
// real (family-granting) verifier injected, the strongest tier is unreachable:
// membership is `unverified`, never `family_same_account`.
describe("evaluateAccountMembership (identity default, no crypto injected) — fail-closed", () => {
  it("NEVER grants family_same_account via the identity-only default (would-be member → unverified)", async () => {
    // A well-formed, garbage-signed roster that NAMES the candidate. Under the old
    // (vulnerable) behavior this granted family on did-presence alone; it must now
    // fail closed to `unverified` because no cryptographic verifier was injected.
    const roster: AccountRoster = { accountId: "acct-1", members: [{ handle: "alice", did: "did:key:zMember" }], epoch: 1, sig: "garbage-not-a-real-sig" }
    const result = await evaluateAccountMembership({
      roster,
      candidate: verifiedCandidate("did:key:zMember"),
      rosterKey: "any-key",
      store: new MemoryRosterStore(),
    })
    expect(result.decision).toBe("unverified")
  })

  it("fails closed for the explicit DEFAULT_ROSTER_VERIFIER too (no family grant)", async () => {
    const roster: AccountRoster = { accountId: "acct-1", members: [{ handle: "alice", did: "did:key:zMember" }], epoch: 1, sig: "ignored" }
    const result = await evaluateAccountMembership({
      roster,
      candidate: verifiedCandidate("did:key:zMember"),
      rosterKey: "any-key",
      store: new MemoryRosterStore(),
      verifier: DEFAULT_ROSTER_VERIFIER,
    })
    expect(result.decision).toBe("unverified")
  })

  it("emits a loud (warn-level) one-time warning when the family grant is refused for lack of a real verifier", async () => {
    _resetRosterVerifierWarningForTest()
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    try {
      const roster: AccountRoster = { accountId: "acct-warn", members: [{ handle: "alice", did: "did:key:zMember" }], epoch: 1, sig: "ignored" }
      // First refusal warns loudly...
      await evaluateAccountMembership({ roster, candidate: verifiedCandidate("did:key:zMember"), rosterKey: "k", store: new MemoryRosterStore() })
      const warns = seen.filter((e) => e.level === "warn" && e.event === "friends.roster_verifier_not_cryptographic")
      expect(warns).toHaveLength(1)
      // ...a SECOND refusal does not re-warn (one-time).
      await evaluateAccountMembership({ roster, candidate: verifiedCandidate("did:key:zMember"), rosterKey: "k", store: new MemoryRosterStore() })
      const warnsAfter = seen.filter((e) => e.level === "warn" && e.event === "friends.roster_verifier_not_cryptographic")
      expect(warnsAfter).toHaveLength(1)
    } finally {
      setNervesEmitter(null)
    }
  })
})

// SECURITY (finding 2, HIGH): the candidate-DID precondition is un-forgettable. The
// function grants family ONLY for a `VerifiedCandidate` — a value the caller can only
// mint via `verifiedCandidate(did)`, which IS the assertion "I verified this peer
// controls this did". A bare string does not type-check (compile-time enforcement),
// so the membership check can never be fooled by an unverified, attacker-claimed did.
describe("evaluateAccountMembership (finding 2: verified-candidate precondition)", () => {
  it("verifiedCandidate(did) carries the did through to the membership check", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const roster = signedRoster(sodium, kp.privateKey, [{ handle: "alice", did: "did:key:zVerified" }])
    const result = await evaluateAccountMembership({
      roster,
      candidate: verifiedCandidate("did:key:zVerified"),
      rosterKey,
      store: new MemoryRosterStore(),
      verifier: ed25519RosterVerifier(sodium),
    })
    expect(result.decision).toBe("family_same_account")
  })

  it("a verified candidate whose did is NOT a roster member never gets family (not_member)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const roster = signedRoster(sodium, kp.privateKey, [{ handle: "alice", did: "did:key:zMember" }])
    const result = await evaluateAccountMembership({
      roster,
      // The caller verified the peer controls zOutsider — but it is not in the roster.
      candidate: verifiedCandidate("did:key:zOutsider"),
      rosterKey,
      store: new MemoryRosterStore(),
      verifier: ed25519RosterVerifier(sodium),
    })
    expect(result.decision).toBe("not_member")
  })
})
