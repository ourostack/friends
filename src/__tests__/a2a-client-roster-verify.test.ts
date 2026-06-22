// ed25519RosterVerifier — the RosterVerifier seam's real Ed25519 implementation.
// A roster signed by `signRoster` with key K verifies under K; any tamper (member,
// epoch, key) or malformed input is rejected (false, never a throw). Lives in
// src/__tests__/ with the `a2a-client-` prefix and imports the impl via the relative
// `../a2a-client/…` path, using the readySodium harness — mirroring the other
// a2a-client tests.
import { describe, it, expect } from "vitest"

import { ed25519RosterVerifier, signRoster } from "../a2a-client/roster-verify"
import type { AccountRoster } from "../roster-store"
import { readySodium } from "./_sodium"

type Members = AccountRoster["members"]

function rosterBody(members: Members = [{ handle: "alice", did: "did:key:zA" }], epoch = 1): Omit<AccountRoster, "sig"> {
  return { accountId: "acct-1", members, epoch }
}

describe("ed25519RosterVerifier", () => {
  it("verifies a roster signed by the matching account key (true)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const body = rosterBody()
    const sig = signRoster({ sodium, accountKeyPriv: kp.privateKey, roster: body })
    const verifier = ed25519RosterVerifier(sodium)
    expect(verifier.verify({ ...body, sig }, rosterKey)).toBe(true)
  })

  it("rejects a tampered member (false)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const body = rosterBody()
    const sig = signRoster({ sodium, accountKeyPriv: kp.privateKey, roster: body })
    const verifier = ed25519RosterVerifier(sodium)
    // Swap in a different member after signing → bytes no longer match the sig.
    const tampered: AccountRoster = { ...body, members: [{ handle: "mallory", did: "did:key:zEvil" }], sig }
    expect(verifier.verify(tampered, rosterKey)).toBe(false)
  })

  it("rejects a bumped epoch (false)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const body = rosterBody()
    const sig = signRoster({ sodium, accountKeyPriv: kp.privateKey, roster: body })
    const verifier = ed25519RosterVerifier(sodium)
    expect(verifier.verify({ ...body, epoch: 2, sig }, rosterKey)).toBe(false)
  })

  it("rejects verification under the wrong key (false)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const other = sodium.crypto_sign_keypair()
    const wrongKey = sodium.to_base64(other.publicKey, sodium.base64_variants.ORIGINAL)
    const body = rosterBody()
    const sig = signRoster({ sodium, accountKeyPriv: kp.privateKey, roster: body })
    const verifier = ed25519RosterVerifier(sodium)
    expect(verifier.verify({ ...body, sig }, wrongKey)).toBe(false)
  })

  it("rejects a malformed base64 rosterKey (false, guarded)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const body = rosterBody()
    const sig = signRoster({ sodium, accountKeyPriv: kp.privateKey, roster: body })
    const verifier = ed25519RosterVerifier(sodium)
    expect(verifier.verify({ ...body, sig }, "!!!not-base64!!!")).toBe(false)
  })

  it("rejects a malformed base64 sig (false, guarded)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const verifier = ed25519RosterVerifier(sodium)
    expect(verifier.verify({ ...rosterBody(), sig: "!!!not-base64!!!" }, rosterKey)).toBe(false)
  })

  it("rejects a wrong-length key/sig that throws inside libsodium (false)", async () => {
    const sodium = await readySodium()
    // A valid-base64 but wrong-length key → crypto_sign_verify_detached throws;
    // the verifier must map it to false, never an uncaught error.
    const shortKey = sodium.to_base64(new Uint8Array([1, 2, 3]), sodium.base64_variants.ORIGINAL)
    const kp = sodium.crypto_sign_keypair()
    const body = rosterBody()
    const sig = signRoster({ sodium, accountKeyPriv: kp.privateKey, roster: body })
    const verifier = ed25519RosterVerifier(sodium)
    expect(verifier.verify({ ...body, sig }, shortKey)).toBe(false)
  })
})
