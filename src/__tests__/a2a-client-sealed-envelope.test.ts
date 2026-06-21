// SealedEnvelope sign-then-seal compose. Real did:key identities + real crypto.
// Proves content-blindness (no plaintext on the wire) and every open error branch.
import { describe, expect, it } from "vitest"

import { didKeyIdentityFromEd25519 } from "../a2a-client/did-key"
import { sealTo } from "../a2a-client/seal"
import { openSealedEnvelope, sealEnvelope } from "../a2a-client/sealed-envelope"
import type { FromIdentity, RecipientIdentity } from "../a2a-client/sealed-envelope"
import { verifyEnvelopeSignature, parseProof } from "../a2a-client/sign"
import { readySodium } from "./_sodium"

const NOW = "2026-01-01T00:00:00.000Z"

async function parties() {
  const sodium = await readySodium()
  const aKp = sodium.crypto_sign_keypair()
  const bKp = sodium.crypto_sign_keypair()
  const a = didKeyIdentityFromEd25519({ sodium, ed25519Pub: aKp.publicKey, ed25519Priv: aKp.privateKey })
  const b = didKeyIdentityFromEd25519({ sodium, ed25519Pub: bKp.publicKey, ed25519Priv: bKp.privateKey })
  return { sodium, a, b }
}

function envelopeFrom(did: string) {
  return {
    subject: { externalIds: [{ provider: "teams", externalId: "teams:proof-subject-xyz", linkedAt: NOW }], displayName: "Jordan" },
    fromAgentId: did,
    scope: "notes:safe",
    notes: [{ key: "bio", value: "super-secret-note" }],
    issuedAt: NOW,
  } as Record<string, unknown>
}

function fromIdentity(id: { did: string; keyId: string; ed25519Priv: Uint8Array }): FromIdentity {
  return { did: id.did, keyId: id.keyId, ed25519Priv: id.ed25519Priv }
}
function recipientIdentity(id: { x25519Priv: Uint8Array; x25519Pub: Uint8Array }): RecipientIdentity {
  return { x25519Priv: id.x25519Priv, x25519Pub: id.x25519Pub }
}

describe("sealEnvelope / openSealedEnvelope — full compose round-trip", () => {
  it("recovers the envelope + structured proof; a downstream signature verify passes", async () => {
    const { sodium, a, b } = await parties()
    const env = envelopeFrom(a.did)
    const sealed = sealEnvelope({ sodium, envelope: env, friendsKind: "profile_share", fromIdentity: fromIdentity(a), recipientDid: b.did, recipientX25519Pub: b.x25519Pub })

    const opened = openSealedEnvelope({ sodium, sealedEnvelope: sealed, recipientDid: b.did, recipientIdentity: recipientIdentity(b) })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.fromAgentId).toBe(a.did)
    expect(opened.signerDid).toBe(a.did)
    expect(opened.signerKeyId).toBe(a.keyId)
    expect(opened.friendsKind).toBe("profile_share")
    // The recovered envelope carries the structured proof in its slot …
    const proof = parseProof(opened.envelope.proof as string)
    expect(proof).not.toBeNull()
    // … and a downstream signature verify against A's key passes.
    expect(verifyEnvelopeSignature({ sodium, envelope: opened.envelope, proof: opened.envelope.proof as string, signerEd25519Pub: a.ed25519Pub })).toBe(true)
  })

  it("defaults v to 1", async () => {
    const { sodium, a, b } = await parties()
    const sealed = sealEnvelope({ sodium, envelope: envelopeFrom(a.did), friendsKind: "coordination", fromIdentity: fromIdentity(a), recipientDid: b.did, recipientX25519Pub: b.x25519Pub })
    expect(sealed.v).toBe(1)
  })
})

describe("content-blindness — nothing plaintext on the wire", () => {
  it("the serialized SealedEnvelope contains NO plaintext envelope field", async () => {
    const { sodium, a, b } = await parties()
    const sealed = sealEnvelope({ sodium, envelope: envelopeFrom(a.did), friendsKind: "profile_share", fromIdentity: fromIdentity(a), recipientDid: b.did, recipientX25519Pub: b.x25519Pub })
    const json = JSON.stringify(sealed)
    expect(json).not.toContain("teams:proof-subject-xyz") // subject join-key
    expect(json).not.toContain("super-secret-note") // note value
    expect(json).not.toContain("profile_share") // friendsKind
    expect(json).not.toContain(a.did) // fromAgentId / signerDid
    // Only v + the sealed blob fields.
    expect(Object.keys(sealed).sort()).toEqual(["sealed", "v"])
    expect(Object.keys(sealed.sealed).sort()).toEqual(["ct", "ePk", "n", "v"])
  })
})

describe("openSealedEnvelope — error branches", () => {
  it("a bit-flipped ct → unseal_failed", async () => {
    const { sodium, a, b } = await parties()
    const sealed = sealEnvelope({ sodium, envelope: envelopeFrom(a.did), friendsKind: "profile_share", fromIdentity: fromIdentity(a), recipientDid: b.did, recipientX25519Pub: b.x25519Pub })
    const ctBytes = sodium.from_base64(sealed.sealed.ct, sodium.base64_variants.ORIGINAL)
    ctBytes[0] ^= 0x01
    const tampered = { ...sealed, sealed: { ...sealed.sealed, ct: sodium.to_base64(ctBytes, sodium.base64_variants.ORIGINAL) } }
    const r = openSealedEnvelope({ sodium, sealedEnvelope: tampered, recipientDid: b.did, recipientIdentity: recipientIdentity(b) })
    expect(r).toEqual({ ok: false, error: "unseal_failed" })
  })

  it("opening with the WRONG recipientDid → unseal_failed (AEAD AD mismatch)", async () => {
    const { sodium, a, b } = await parties()
    const sealed = sealEnvelope({ sodium, envelope: envelopeFrom(a.did), friendsKind: "profile_share", fromIdentity: fromIdentity(a), recipientDid: b.did, recipientX25519Pub: b.x25519Pub })
    // Reconstruct AD with a different DID → tag fails at the AEAD layer.
    const r = openSealedEnvelope({ sodium, sealedEnvelope: sealed, recipientDid: "did:key:zWrong", recipientIdentity: recipientIdentity(b) })
    expect(r).toEqual({ ok: false, error: "unseal_failed" })
  })

  it("the belt-and-suspenders recipient_mismatch fires when a crafted plaintext's inner recipient ≠ the opener's DID", async () => {
    const { sodium, a, b } = await parties()
    // Craft a sealed plaintext whose AEAD AD binds B (so it OPENS for B) but whose
    // INNER `recipient` field says someone else → the redundant second line fires.
    const craftedPlaintext = {
      envelope: { fromAgentId: a.did, proof: "x" },
      signature: "x",
      signerDid: a.did,
      signerKeyId: a.keyId,
      recipient: "did:key:zSomeoneElse", // ≠ the opener (B)
      v: 1,
      friendsKind: "profile_share",
    }
    const blob = sealTo({ sodium, plaintextBytes: new TextEncoder().encode(JSON.stringify(craftedPlaintext)), recipientX25519Pub: b.x25519Pub, recipientDid: b.did })
    const r = openSealedEnvelope({ sodium, sealedEnvelope: { v: 1, sealed: blob }, recipientDid: b.did, recipientIdentity: recipientIdentity(b) })
    expect(r).toEqual({ ok: false, error: "recipient_mismatch" })
  })

  it("a sealed NON-JSON plaintext → malformed_plaintext", async () => {
    const { sodium, b } = await parties()
    const blob = sealTo({ sodium, plaintextBytes: new TextEncoder().encode("not-json{"), recipientX25519Pub: b.x25519Pub, recipientDid: b.did })
    const r = openSealedEnvelope({ sodium, sealedEnvelope: { v: 1, sealed: blob }, recipientDid: b.did, recipientIdentity: recipientIdentity(b) })
    expect(r).toEqual({ ok: false, error: "malformed_plaintext" })
  })

  it("a sealed JSON ARRAY plaintext → malformed_plaintext", async () => {
    const { sodium, b } = await parties()
    const blob = sealTo({ sodium, plaintextBytes: new TextEncoder().encode("[1,2,3]"), recipientX25519Pub: b.x25519Pub, recipientDid: b.did })
    const r = openSealedEnvelope({ sodium, sealedEnvelope: { v: 1, sealed: blob }, recipientDid: b.did, recipientIdentity: recipientIdentity(b) })
    expect(r).toEqual({ ok: false, error: "malformed_plaintext" })
  })

  it("a sealed plaintext missing envelope → malformed_plaintext", async () => {
    const { sodium, b } = await parties()
    const blob = sealTo({ sodium, plaintextBytes: new TextEncoder().encode(JSON.stringify({ recipient: b.did, friendsKind: "profile_share", signerDid: "d" })), recipientX25519Pub: b.x25519Pub, recipientDid: b.did })
    const r = openSealedEnvelope({ sodium, sealedEnvelope: { v: 1, sealed: blob }, recipientDid: b.did, recipientIdentity: recipientIdentity(b) })
    expect(r).toEqual({ ok: false, error: "malformed_plaintext" })
  })

  it("a sealed plaintext missing friendsKind/signerDid → malformed_plaintext", async () => {
    const { sodium, b } = await parties()
    const blob = sealTo({ sodium, plaintextBytes: new TextEncoder().encode(JSON.stringify({ envelope: { fromAgentId: "a" }, recipient: b.did })), recipientX25519Pub: b.x25519Pub, recipientDid: b.did })
    const r = openSealedEnvelope({ sodium, sealedEnvelope: { v: 1, sealed: blob }, recipientDid: b.did, recipientIdentity: recipientIdentity(b) })
    expect(r).toEqual({ ok: false, error: "malformed_plaintext" })
  })

  it("a recovered envelope with a non-string fromAgentId yields fromAgentId '' (still ok)", async () => {
    const { sodium, a, b } = await parties()
    const blob = sealTo({
      sodium,
      plaintextBytes: new TextEncoder().encode(JSON.stringify({ envelope: { notFrom: 1 }, recipient: b.did, friendsKind: "profile_share", signerDid: a.did, signerKeyId: a.keyId, signature: "s", v: 1 })),
      recipientX25519Pub: b.x25519Pub,
      recipientDid: b.did,
    })
    const r = openSealedEnvelope({ sodium, sealedEnvelope: { v: 1, sealed: blob }, recipientDid: b.did, recipientIdentity: recipientIdentity(b) })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.fromAgentId).toBe("")
  })
})
