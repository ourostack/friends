// seal — the E2E sealing primitive (the "sealed-box shape" with a REAL AEAD AD).
//
// The relay is UNTRUSTED: it must carry ciphertext only and never be able to
// read, tamper, or RE-TARGET a blob. Standard `crypto_box_seal` exposes no AAD,
// so to honor the spec literally ("AEAD associated-data binds the blob to its
// recipient") this builds the seal from `crypto_aead_xchacha20poly1305_ietf_*`
// over an ephemeral X25519 ECDH key, with AAD = the JCS-canonical bytes of
// `{ recipientDid, v }`. Consequence: a re-target (delivering B's blob to C) fails
// at the AEAD TAG when C reconstructs its own DID as AAD — the strong, crypto-
// layer defense, not a post-unseal app check.
//
// Construction (decision #1):
//   sender:   ePk,eSk = X25519 keypair; shared = scalarmult(eSk, recipientX25519Pub)
//             K = generichash(32, shared || ePk || recipientX25519Pub)   (transcript-bound)
//             N = 24 random bytes; ct = AEAD_encrypt(plaintext, AAD={recipientDid,v}, N, K)
//             blob = { v, ePk, n, ct } (all base64 ORIGINAL)
//   recipient: shared' = scalarmult(recipientX25519Priv, ePk); K' = generichash(32, shared'||ePk||recipientX25519Pub)
//             AEAD_decrypt(ct, AAD={recipientDid:self,v}, N, K') — throws on tag mismatch.
import { jcsBytes } from "./jcs"
import type { Sodium } from "./sodium"

/** The opaque sealed blob the relay carries. All fields base64 (ORIGINAL
 * variant). Nothing here reveals the sender, the payload, or the friends kind. */
export interface SealedBlob {
  /** Overlay version (bound into the AAD). */
  v: number
  /** The sender's ephemeral X25519 public key (base64). */
  ePk: string
  /** The AEAD nonce (base64, 24 bytes). */
  n: string
  /** The AEAD ciphertext+tag (base64). */
  ct: string
}

export interface SealToInput {
  sodium: Sodium
  /** The plaintext to seal (already the sign-then-seal plaintext bytes). */
  plaintextBytes: Uint8Array
  /** The recipient's X25519 keyAgreement public key. */
  recipientX25519Pub: Uint8Array
  /** The recipient's DID — bound into the AEAD AD (the re-target defense). */
  recipientDid: string
  /** Overlay version (default 1). */
  v?: number
}

/** Derive the transcript-bound symmetric key from an ECDH shared secret. Binding
 * `ePk` and the recipient pubkey into the KDF means the key is unique per
 * (ephemeral, recipient) pair — a relay cannot swap ephemerals to attack it. */
function deriveKey(sodium: Sodium, shared: Uint8Array, ePk: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const transcript = new Uint8Array(shared.length + ePk.length + recipientPub.length)
  transcript.set(shared, 0)
  transcript.set(ePk, shared.length)
  transcript.set(recipientPub, shared.length + ePk.length)
  return sodium.crypto_generichash(32, transcript, null)
}

/** Seal `plaintextBytes` to a recipient, binding the recipient DID into the AEAD
 * associated-data. Returns the opaque blob. */
export function sealTo(input: SealToInput): SealedBlob {
  const { sodium, plaintextBytes, recipientX25519Pub, recipientDid } = input
  const v = input.v ?? 1

  // Ephemeral X25519 keypair (one-shot per message).
  const eph = sodium.crypto_box_keypair()
  const ePk = eph.publicKey
  const eSk = eph.privateKey

  const shared = sodium.crypto_scalarmult(eSk, recipientX25519Pub)
  const key = deriveKey(sodium, shared, ePk, recipientX25519Pub)

  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
  const ad = jcsBytes({ recipientDid, v })
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintextBytes, ad, null, nonce, key)

  const ORIGINAL = sodium.base64_variants.ORIGINAL
  return {
    v,
    ePk: sodium.to_base64(ePk, ORIGINAL),
    n: sodium.to_base64(nonce, ORIGINAL),
    ct: sodium.to_base64(ct, ORIGINAL),
  }
}

export interface OpenSealedInput {
  sodium: Sodium
  blob: SealedBlob
  /** The recipient's X25519 keyAgreement private key. */
  recipientX25519Priv: Uint8Array
  /** The recipient's X25519 keyAgreement public key (bound into the KDF). */
  recipientX25519Pub: Uint8Array
  /** The recipient's own DID — reconstructed as the AEAD AD. A wrong DID (a
   * re-targeted blob) breaks the tag. */
  recipientDid: string
}

/** Thrown by `openSealed` on any failure (bad base64, wrong key, tampered or
 * re-targeted ciphertext → AEAD tag mismatch). The caller maps this to a typed
 * `unseal_failed` result; it never leaks plaintext. */
export class SealOpenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SealOpenError"
  }
}

/** Open a sealed blob. Throws `SealOpenError` on any failure (the AEAD tag
 * enforces tamper + re-target resistance at the crypto layer). */
export function openSealed(input: OpenSealedInput): Uint8Array {
  const { sodium, blob, recipientX25519Priv, recipientX25519Pub, recipientDid } = input
  const ORIGINAL = sodium.base64_variants.ORIGINAL

  let ePk: Uint8Array
  let nonce: Uint8Array
  let ct: Uint8Array
  try {
    ePk = sodium.from_base64(blob.ePk, ORIGINAL)
    nonce = sodium.from_base64(blob.n, ORIGINAL)
    ct = sodium.from_base64(blob.ct, ORIGINAL)
  } catch {
    throw new SealOpenError("seal: malformed base64 in sealed blob")
  }

  const shared = sodium.crypto_scalarmult(recipientX25519Priv, ePk)
  const key = deriveKey(sodium, shared, ePk, recipientX25519Pub)
  const ad = jcsBytes({ recipientDid, v: blob.v })

  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, ad, nonce, key)
  } catch {
    // Tag mismatch: tampered ct/nonce, wrong ephemeral, wrong recipient key, OR a
    // re-targeted blob (wrong recipientDid in the AAD). All collapse to one
    // indistinguishable failure — exactly the security property we want.
    throw new SealOpenError("seal: AEAD open failed (tampered, wrong recipient, or re-targeted)")
  }
}
