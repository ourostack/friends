// sign/verify + structured proof. Real Ed25519 (no mocks). The load-bearing
// negatives: forge-fails, tamper-fails (a mutated signed field breaks the canonical
// bytes), wrong-key-fails, and every malformed-proof reject branch.
import { describe, expect, it } from "vitest"

import { parseProof, serializeProof, signEnvelope, verifyEnvelopeSignature } from "../a2a-client/sign"
import type { StructuredProof } from "../a2a-client/sign"
import { readySodium } from "./_sodium"

const ENVELOPE = {
  v: 1,
  fromAgentId: "did:key:zAlice",
  issuedAt: "2026-01-01T00:00:00.000Z",
  notes: [{ key: "role", value: "designer" }],
}

async function fixture() {
  const sodium = await readySodium()
  const kp = sodium.crypto_sign_keypair()
  const proof = signEnvelope({
    sodium,
    envelope: ENVELOPE,
    signerEd25519Priv: kp.privateKey,
    signerDid: "did:key:zAlice",
    signerKeyId: "did:key:zAlice#key-1",
  })
  return { sodium, kp, proof }
}

describe("sign/verify round-trip", () => {
  it("a signed envelope verifies with the matching pubkey", async () => {
    const { sodium, kp, proof } = await fixture()
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof, signerEd25519Pub: kp.publicKey })).toBe(true)
  })

  it("the structured proof has the pinned alg/canon and the signer fields", async () => {
    const { proof } = await fixture()
    expect(proof.alg).toBe("EdDSA")
    expect(proof.canon).toBe("JCS")
    expect(proof.signerDid).toBe("did:key:zAlice")
    expect(proof.signerKeyId).toBe("did:key:zAlice#key-1")
    expect(typeof proof.sig).toBe("string")
  })

  it("verifies when the proof is supplied as its JSON string form", async () => {
    const { sodium, kp, proof } = await fixture()
    const asString = serializeProof(proof)
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: asString, signerEd25519Pub: kp.publicKey })).toBe(true)
  })
})

describe("sign/verify — forge & tamper fail", () => {
  it("a bit-flipped signature → verify false", async () => {
    const { sodium, kp, proof } = await fixture()
    const sigBytes = sodium.from_base64(proof.sig, sodium.base64_variants.ORIGINAL)
    sigBytes[0] ^= 0x01
    const forged: StructuredProof = { ...proof, sig: sodium.to_base64(sigBytes, sodium.base64_variants.ORIGINAL) }
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: forged, signerEd25519Pub: kp.publicKey })).toBe(false)
  })

  it("mutating a signed field after signing → verify false (canonical bytes changed)", async () => {
    const { sodium, kp, proof } = await fixture()
    const mutatedFrom = { ...ENVELOPE, fromAgentId: "did:key:zMallory" }
    expect(verifyEnvelopeSignature({ sodium, envelope: mutatedFrom, proof, signerEd25519Pub: kp.publicKey })).toBe(false)

    const mutatedNote = { ...ENVELOPE, notes: [{ key: "role", value: "ATTACKER" }] }
    expect(verifyEnvelopeSignature({ sodium, envelope: mutatedNote, proof, signerEd25519Pub: kp.publicKey })).toBe(false)

    const mutatedTime = { ...ENVELOPE, issuedAt: "2099-01-01T00:00:00.000Z" }
    expect(verifyEnvelopeSignature({ sodium, envelope: mutatedTime, proof, signerEd25519Pub: kp.publicKey })).toBe(false)
  })

  it("a different Ed25519 pubkey → verify false", async () => {
    const { sodium, proof } = await fixture()
    const other = sodium.crypto_sign_keypair()
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof, signerEd25519Pub: other.publicKey })).toBe(false)
  })

  it("a forged proof (signature by a non-matching key) → verify false", async () => {
    const { sodium, kp } = await fixture()
    // Mallory signs the SAME envelope with her own key, claims to be Alice.
    const mallory = sodium.crypto_sign_keypair()
    const forged = signEnvelope({
      sodium,
      envelope: ENVELOPE,
      signerEd25519Priv: mallory.privateKey,
      signerDid: "did:key:zAlice",
      signerKeyId: "did:key:zAlice#key-1",
    })
    // Verified against Alice's REAL pubkey → false.
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: forged, signerEd25519Pub: kp.publicKey })).toBe(false)
  })
})

describe("verifyEnvelopeSignature — malformed proof reject branches", () => {
  it("undefined proof → false", async () => {
    const { sodium, kp } = await fixture()
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: undefined, signerEd25519Pub: kp.publicKey })).toBe(false)
  })

  it("a non-JSON proof string → false (parse fails)", async () => {
    const { sodium, kp } = await fixture()
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: "{not json", signerEd25519Pub: kp.publicKey })).toBe(false)
  })

  it("wrong alg → false", async () => {
    const { sodium, kp, proof } = await fixture()
    expect(
      verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: { ...proof, alg: "RS256" as unknown as "EdDSA" }, signerEd25519Pub: kp.publicKey }),
    ).toBe(false)
  })

  it("wrong canon → false", async () => {
    const { sodium, kp, proof } = await fixture()
    expect(
      verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: { ...proof, canon: "RFC7159" as unknown as "JCS" }, signerEd25519Pub: kp.publicKey }),
    ).toBe(false)
  })

  it("missing sig field → false", async () => {
    const { sodium, kp, proof } = await fixture()
    const { sig: _sig, ...noSig } = proof
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: noSig as unknown as StructuredProof, signerEd25519Pub: kp.publicKey })).toBe(false)
  })

  it("missing signerDid field → false", async () => {
    const { sodium, kp, proof } = await fixture()
    const { signerDid: _did, ...noDid } = proof
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: noDid as unknown as StructuredProof, signerEd25519Pub: kp.publicKey })).toBe(false)
  })

  it("missing signerKeyId field → false", async () => {
    const { sodium, kp, proof } = await fixture()
    const { signerKeyId: _kid, ...noKid } = proof
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: noKid as unknown as StructuredProof, signerEd25519Pub: kp.publicKey })).toBe(false)
  })

  it("non-base64 sig → false (from_base64 throws, caught)", async () => {
    const { sodium, kp, proof } = await fixture()
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: { ...proof, sig: "!!!not-base64!!!" }, signerEd25519Pub: kp.publicKey })).toBe(false)
  })

  it("a wrong-LENGTH signature (valid base64, bad size) → false (verify_detached throws, caught)", async () => {
    const { sodium, kp, proof } = await fixture()
    const short = sodium.to_base64(new Uint8Array([1, 2, 3]), sodium.base64_variants.ORIGINAL)
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof: { ...proof, sig: short }, signerEd25519Pub: kp.publicKey })).toBe(false)
  })
})

describe("proof is EXCLUDED from the signed canonical bytes", () => {
  it("setting envelope.proof after signing and re-verifying still passes", async () => {
    const { sodium, kp, proof } = await fixture()
    // Simulate the compose: put the serialized proof into the slot, verify with
    // that proof field PRESENT on the envelope — still passes (proof excluded).
    const withProof = { ...ENVELOPE, proof: serializeProof(proof) }
    expect(verifyEnvelopeSignature({ sodium, envelope: withProof, proof, signerEd25519Pub: kp.publicKey })).toBe(true)
  })

  it("signing an envelope that ALREADY has a (stale) proof ignores it", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const envWithStaleProof = { ...ENVELOPE, proof: "stale-garbage" }
    const proof = signEnvelope({ sodium, envelope: envWithStaleProof, signerEd25519Priv: kp.privateKey, signerDid: "did:key:zAlice", signerKeyId: "k" })
    // The proof verifies against the SAME envelope whether or not the stale proof
    // is present, AND against the proof-free envelope — proof is excluded.
    expect(verifyEnvelopeSignature({ sodium, envelope: envWithStaleProof, proof, signerEd25519Pub: kp.publicKey })).toBe(true)
    expect(verifyEnvelopeSignature({ sodium, envelope: ENVELOPE, proof, signerEd25519Pub: kp.publicKey })).toBe(true)
  })
})

describe("non-object envelopes pass through the proof-strip guard unchanged", () => {
  it("a primitive 'envelope' (string) signs and verifies (no proof field to strip)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const proof = signEnvelope({ sodium, envelope: "just-a-string", signerEd25519Priv: kp.privateKey, signerDid: "d", signerKeyId: "k" })
    expect(verifyEnvelopeSignature({ sodium, envelope: "just-a-string", proof, signerEd25519Pub: kp.publicKey })).toBe(true)
    expect(verifyEnvelopeSignature({ sodium, envelope: "tampered", proof, signerEd25519Pub: kp.publicKey })).toBe(false)
  })

  it("an array 'envelope' signs and verifies (Array.isArray guard branch)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const arr = [1, 2, 3]
    const proof = signEnvelope({ sodium, envelope: arr, signerEd25519Priv: kp.privateKey, signerDid: "d", signerKeyId: "k" })
    expect(verifyEnvelopeSignature({ sodium, envelope: arr, proof, signerEd25519Pub: kp.publicKey })).toBe(true)
  })

  it("a null 'envelope' signs and verifies (the falsy guard branch)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const proof = signEnvelope({ sodium, envelope: null, signerEd25519Priv: kp.privateKey, signerDid: "d", signerKeyId: "k" })
    expect(verifyEnvelopeSignature({ sodium, envelope: null, proof, signerEd25519Pub: kp.publicKey })).toBe(true)
  })
})

describe("serializeProof / parseProof", () => {
  it("round-trips a structured proof", async () => {
    const { proof } = await fixture()
    expect(parseProof(serializeProof(proof))).toEqual(proof)
  })

  it("parseProof returns null on invalid JSON", () => {
    expect(parseProof("{not json")).toBeNull()
  })

  it("parseProof returns null on a non-object JSON payload (array / primitive)", () => {
    expect(parseProof("[1,2,3]")).toBeNull()
    expect(parseProof('"a string"')).toBeNull()
    expect(parseProof("42")).toBeNull()
    expect(parseProof("null")).toBeNull()
  })
})
