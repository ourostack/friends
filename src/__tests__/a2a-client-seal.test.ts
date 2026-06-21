// seal/open — the AEAD-AD sealing primitive. Real libsodium (no mocks); every
// test awaits the WASM init. The load-bearing security properties are the
// NEGATIVE branches: tamper-fails, re-target-fails AT THE AEAD TAG, wrong-key-fails.
import { describe, expect, it } from "vitest"

import { openSealed, sealTo, SealOpenError } from "../a2a-client/seal"
import { readySodium } from "./_sodium"

const PLAINTEXT = new TextEncoder().encode(JSON.stringify({ secret: "super-secret-note", n: 42 }))

describe("seal/open round-trip", () => {
  it("openSealed(sealTo(x)) recovers the original bytes", async () => {
    const sodium = await readySodium()
    const recip = sodium.crypto_box_keypair()
    const blob = sealTo({
      sodium,
      plaintextBytes: PLAINTEXT,
      recipientX25519Pub: recip.publicKey,
      recipientDid: "did:key:zRecipient",
    })
    const opened = openSealed({
      sodium,
      blob,
      recipientX25519Priv: recip.privateKey,
      recipientX25519Pub: recip.publicKey,
      recipientDid: "did:key:zRecipient",
    })
    expect(Buffer.from(opened)).toEqual(Buffer.from(PLAINTEXT))
  })

  it("the blob defaults v to 1 and carries only base64 {v,ePk,n,ct}", async () => {
    const sodium = await readySodium()
    const recip = sodium.crypto_box_keypair()
    const blob = sealTo({ sodium, plaintextBytes: PLAINTEXT, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" })
    expect(blob.v).toBe(1)
    expect(Object.keys(blob).sort()).toEqual(["ct", "ePk", "n", "v"])
    // base64 ORIGINAL is decodable.
    expect(() => sodium.from_base64(blob.ct, sodium.base64_variants.ORIGINAL)).not.toThrow()
    // The ciphertext must NOT contain the plaintext secret in the clear.
    expect(Buffer.from(blob.ct, "base64").toString("utf-8")).not.toContain("super-secret-note")
  })

  it("honors an explicit v in both the blob and the AAD binding", async () => {
    const sodium = await readySodium()
    const recip = sodium.crypto_box_keypair()
    const blob = sealTo({ sodium, plaintextBytes: PLAINTEXT, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR", v: 7 })
    expect(blob.v).toBe(7)
    // Opens because open reconstructs AAD from blob.v (7).
    const opened = openSealed({ sodium, blob, recipientX25519Priv: recip.privateKey, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" })
    expect(Buffer.from(opened)).toEqual(Buffer.from(PLAINTEXT))
  })
})

describe("seal/open — tamper fails (AEAD tag)", () => {
  async function sealedFixture() {
    const sodium = await readySodium()
    const recip = sodium.crypto_box_keypair()
    const blob = sealTo({ sodium, plaintextBytes: PLAINTEXT, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" })
    return { sodium, recip, blob }
  }

  function flipFirstByte(sodium: Awaited<ReturnType<typeof readySodium>>, b64: string): string {
    const bytes = sodium.from_base64(b64, sodium.base64_variants.ORIGINAL)
    bytes[0] ^= 0x01
    return sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)
  }

  it("a bit-flip in ct → SealOpenError", async () => {
    const { sodium, recip, blob } = await sealedFixture()
    const tampered = { ...blob, ct: flipFirstByte(sodium, blob.ct) }
    expect(() =>
      openSealed({ sodium, blob: tampered, recipientX25519Priv: recip.privateKey, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" }),
    ).toThrow(SealOpenError)
  })

  it("a bit-flip in the nonce → SealOpenError", async () => {
    const { sodium, recip, blob } = await sealedFixture()
    const tampered = { ...blob, n: flipFirstByte(sodium, blob.n) }
    expect(() =>
      openSealed({ sodium, blob: tampered, recipientX25519Priv: recip.privateKey, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" }),
    ).toThrow(SealOpenError)
  })

  it("a bit-flip in ePk → SealOpenError (wrong shared key)", async () => {
    const { sodium, recip, blob } = await sealedFixture()
    const tampered = { ...blob, ePk: flipFirstByte(sodium, blob.ePk) }
    expect(() =>
      openSealed({ sodium, blob: tampered, recipientX25519Priv: recip.privateKey, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" }),
    ).toThrow(SealOpenError)
  })

  it("malformed base64 in the blob → SealOpenError (not an uncaught throw)", async () => {
    const { sodium, recip, blob } = await sealedFixture()
    const tampered = { ...blob, ct: "!!!not-base64!!!" }
    expect(() =>
      openSealed({ sodium, blob: tampered, recipientX25519Priv: recip.privateKey, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" }),
    ).toThrow(SealOpenError)
  })
})

describe("seal/open — re-target fails at the AAD (the load-bearing defense)", () => {
  it("opening with a DIFFERENT recipientDid in the AAD → AEAD tag fails", async () => {
    const sodium = await readySodium()
    const recip = sodium.crypto_box_keypair()
    // Sealed binding recipientDid = did:key:A …
    const blob = sealTo({ sodium, plaintextBytes: PLAINTEXT, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:A" })
    // … but open reconstructs AAD with did:key:B (a re-target). Even with the
    // CORRECT private key, the tag fails — the defense is at the crypto layer.
    expect(() =>
      openSealed({ sodium, blob, recipientX25519Priv: recip.privateKey, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:B" }),
    ).toThrow(SealOpenError)
  })
})

describe("seal/open — wrong key fails", () => {
  it("opening with a different X25519 private key → SealOpenError", async () => {
    const sodium = await readySodium()
    const recip = sodium.crypto_box_keypair()
    const attacker = sodium.crypto_box_keypair()
    const blob = sealTo({ sodium, plaintextBytes: PLAINTEXT, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" })
    expect(() =>
      openSealed({ sodium, blob, recipientX25519Priv: attacker.privateKey, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" }),
    ).toThrow(SealOpenError)
  })
})

describe("seal — freshness", () => {
  it("two seals of the same plaintext produce different ct/ePk/n (fresh ephemerals + nonce)", async () => {
    const sodium = await readySodium()
    const recip = sodium.crypto_box_keypair()
    const a = sealTo({ sodium, plaintextBytes: PLAINTEXT, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" })
    const b = sealTo({ sodium, plaintextBytes: PLAINTEXT, recipientX25519Pub: recip.publicKey, recipientDid: "did:key:zR" })
    expect(a.ct).not.toBe(b.ct)
    expect(a.ePk).not.toBe(b.ePk)
    expect(a.n).not.toBe(b.n)
  })
})
