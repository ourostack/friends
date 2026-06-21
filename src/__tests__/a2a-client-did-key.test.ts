// did:key — both key derivations from one DID, and every parse reject branch.
// Real libsodium for the curve derivations + a real seal/open integration that
// closes the loop between the did:key keyAgreement and the U2 seal.
import { describe, expect, it } from "vitest"

import {
  base58btcDecode,
  base58btcEncode,
  didKeyIdentityFromEd25519,
  ed25519PubToDidKey,
  keyAgreementFromDidKey,
  parseDidKey,
} from "../a2a-client/did-key"
import { openSealed, sealTo } from "../a2a-client/seal"
import { readySodium } from "./_sodium"

describe("base58btc encode/decode", () => {
  it("round-trips arbitrary bytes", async () => {
    const sodium = await readySodium()
    const bytes = sodium.randombytes_buf(40)
    expect(base58btcDecode(base58btcEncode(bytes))).toEqual(bytes)
  })

  it("handles leading zero bytes (→ leading '1's)", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3])
    const enc = base58btcEncode(bytes)
    expect(enc.startsWith("11")).toBe(true)
    expect(base58btcDecode(enc)).toEqual(bytes)
  })

  it("empty input round-trips to empty", () => {
    expect(base58btcEncode(new Uint8Array(0))).toBe("")
    expect(base58btcDecode("")).toEqual(new Uint8Array(0))
  })

  it("returns null on an invalid base58 character", () => {
    expect(base58btcDecode("0OIl")).toBeNull() // 0, O, I, l are NOT in the alphabet
  })
})

describe("did:key encode/parse round-trip", () => {
  it("encodes an Ed25519 pubkey to did:key:z6Mk… and parses back to the same bytes", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const did = ed25519PubToDidKey(kp.publicKey)
    expect(did.startsWith("did:key:z6Mk")).toBe(true) // the ed25519-pub multicodec prefix
    const parsed = parseDidKey(did)
    expect(parsed).not.toBeNull()
    expect(parsed!.ed25519Pub).toEqual(kp.publicKey)
  })

  it("ed25519PubToDidKey throws on a wrong-length key", () => {
    expect(() => ed25519PubToDidKey(new Uint8Array([1, 2, 3]))).toThrow(/32-byte/)
  })
})

describe("did:key — both keys from one DID", () => {
  it("keyAgreementFromDidKey(pub) matches the X25519 pub derived from the private side", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    // Derive the X25519 keyAgreement PUBLIC key two independent ways:
    //  (a) from the Ed25519 PUBLIC key (what a verifier does from the DID), and
    //  (b) from the Ed25519 PRIVATE key → X25519 priv → its scalar-mult-base pub.
    const xPubFromPub = keyAgreementFromDidKey({ sodium, ed25519Pub: kp.publicKey })
    const xPrivFromPriv = sodium.crypto_sign_ed25519_sk_to_curve25519(kp.privateKey)
    const xPubFromPriv = sodium.crypto_scalarmult_base(xPrivFromPriv)
    expect(xPubFromPub).toEqual(xPubFromPriv)
  })

  it("INTEGRATION: seal to keyAgreementFromDidKey(parseDidKey(did)), open with the derived X25519 priv → round-trips", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const did = ed25519PubToDidKey(kp.publicKey)

    // Sender side: recover the recipient's keyAgreement pub from its DID only.
    const recipX25519Pub = keyAgreementFromDidKey({ sodium, ed25519Pub: parseDidKey(did)!.ed25519Pub })
    const plaintext = new TextEncoder().encode("sealed-to-did-key")
    const blob = sealTo({ sodium, plaintextBytes: plaintext, recipientX25519Pub: recipX25519Pub, recipientDid: did })

    // Recipient side: derive the X25519 PRIVATE key from its Ed25519 private key.
    const recipX25519Priv = sodium.crypto_sign_ed25519_sk_to_curve25519(kp.privateKey)
    const opened = openSealed({ sodium, blob, recipientX25519Priv: recipX25519Priv, recipientX25519Pub: recipX25519Pub, recipientDid: did })
    expect(Buffer.from(opened)).toEqual(Buffer.from(plaintext))
  })
})

describe("didKeyIdentityFromEd25519", () => {
  it("yields did + both keypairs + a self-describing keyId", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const id = didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
    expect(id.did.startsWith("did:key:z6Mk")).toBe(true)
    expect(id.ed25519Pub).toEqual(kp.publicKey)
    expect(id.ed25519Priv).toEqual(kp.privateKey)
    expect(id.x25519Priv).toEqual(sodium.crypto_sign_ed25519_sk_to_curve25519(kp.privateKey))
    expect(id.x25519Pub).toEqual(keyAgreementFromDidKey({ sodium, ed25519Pub: kp.publicKey }))
    // keyId = `${did}#${zBody}` (the fragment repeats the multibase body).
    expect(id.keyId).toBe(`${id.did}#${id.did.slice("did:key:".length)}`)
  })
})

describe("parseDidKey — reject branches", () => {
  it("returns null for a non-string / non-did:key input", () => {
    expect(parseDidKey(undefined as unknown as string)).toBeNull()
    expect(parseDidKey("did:web:example.com")).toBeNull()
    expect(parseDidKey("not-a-did")).toBeNull()
  })

  it("returns null when the multibase prefix is not 'z'", () => {
    // did:key with a 'f' (base16) multibase → unsupported.
    expect(parseDidKey("did:key:fabcdef")).toBeNull()
  })

  it("returns null on bad base58 in the body", () => {
    expect(parseDidKey("did:key:z0OIl")).toBeNull() // invalid base58 chars after z
  })

  it("returns null on a non-Ed25519 multicodec (e.g. x25519-pub 0xec)", async () => {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    // Encode [0xec, 0x01] + 32 bytes → valid base58 but wrong multicodec.
    const wrong = Uint8Array.from([0xec, 0x01, ...kp.publicKey])
    const did = `did:key:z${base58btcEncode(wrong)}`
    expect(parseDidKey(did)).toBeNull()
  })

  it("returns null on a truncated key (right multicodec, short body)", () => {
    const truncated = Uint8Array.from([0xed, 0x01, 1, 2, 3, 4]) // only 4 key bytes
    const did = `did:key:z${base58btcEncode(truncated)}`
    expect(parseDidKey(did)).toBeNull()
  })
})
