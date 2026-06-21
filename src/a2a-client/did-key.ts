// did:key — self-certifying DID identity with ZERO network/infra.
//
// The agent's DID IS its Ed25519 public key, multibase-base58btc-encoded with the
// ed25519-pub multicodec prefix (`0xed 0x01`): `did:key:z6Mk…`. The X25519
// keyAgreement key is DERIVED from the same Ed25519 key
// (`crypto_sign_ed25519_pk_to_curve25519` / `..._sk_to_curve25519`) — so ONE
// did:key yields BOTH a signing key and a sealing key deterministically, and
// `agentId === did` is clean. No fixture did.json is ever needed for did:key.
//
// base58btc (the multibase `z` prefix) is hand-rolled below — it is a small,
// well-specified alphabet transform with no dep available in libsodium.
import type { Sodium } from "./sodium"

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
// Reverse lookup: char → value (or -1).
const BASE58_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {}
  for (let i = 0; i < BASE58_ALPHABET.length; i++) m[BASE58_ALPHABET[i]] = i
  return m
})()

// The ed25519-pub multicodec, varint-encoded: 0xed → [0xed, 0x01].
const ED25519_MULTICODEC = Uint8Array.from([0xed, 0x01])
const ED25519_PUB_LEN = 32

/** Encode bytes as base58btc (Bitcoin alphabet). */
export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return ""
  // Count leading zero bytes → leading '1's.
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  // Big-endian base-256 → base-58 via repeated division.
  const digits: number[] = [0]
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  let out = "1".repeat(zeros)
  for (let k = digits.length - 1; k >= 0; k--) out += BASE58_ALPHABET[digits[k]]
  return out
}

/** Decode a base58btc string. Returns null on an invalid character. */
export function base58btcDecode(str: string): Uint8Array | null {
  if (str.length === 0) return new Uint8Array(0)
  let zeros = 0
  while (zeros < str.length && str[zeros] === "1") zeros++

  const bytes: number[] = [0]
  for (let i = zeros; i < str.length; i++) {
    const val = BASE58_MAP[str[i]]
    if (val === undefined) return null
    let carry = val
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }

  const out = new Uint8Array(zeros + bytes.length)
  // leading zeros already 0; fill the rest big-endian.
  for (let k = 0; k < bytes.length; k++) out[zeros + k] = bytes[bytes.length - 1 - k]
  return out
}

/** Parse a `did:key:z…` (Ed25519) into its 32-byte public key. Returns null on:
 * wrong scheme, missing `z` multibase prefix, bad base58, wrong multicodec, or
 * wrong key length. */
export function parseDidKey(did: string): { ed25519Pub: Uint8Array } | null {
  if (typeof did !== "string" || !did.startsWith("did:key:")) return null
  const mb = did.slice("did:key:".length)
  if (!mb.startsWith("z")) return null // only base58btc multibase supported
  const decoded = base58btcDecode(mb.slice(1))
  if (!decoded) return null
  if (decoded.length !== ED25519_MULTICODEC.length + ED25519_PUB_LEN) return null
  if (decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]) return null
  return { ed25519Pub: decoded.slice(ED25519_MULTICODEC.length) }
}

/** Encode an Ed25519 public key as a `did:key:z…`. Throws on a wrong-length key
 * (a guard — callers pass real 32-byte keys). */
export function ed25519PubToDidKey(pub: Uint8Array): string {
  if (pub.length !== ED25519_PUB_LEN) {
    throw new Error(`did:key: expected a ${ED25519_PUB_LEN}-byte Ed25519 public key, got ${pub.length}`)
  }
  const prefixed = new Uint8Array(ED25519_MULTICODEC.length + pub.length)
  prefixed.set(ED25519_MULTICODEC, 0)
  prefixed.set(pub, ED25519_MULTICODEC.length)
  return `did:key:z${base58btcEncode(prefixed)}`
}

/** Derive the X25519 keyAgreement PUBLIC key from an Ed25519 public key. */
export function keyAgreementFromDidKey(input: { sodium: Sodium; ed25519Pub: Uint8Array }): Uint8Array {
  return input.sodium.crypto_sign_ed25519_pk_to_curve25519(input.ed25519Pub)
}

/** A self-contained did:key identity (signing + derived sealing keys). The keyId
 * convention for did:key is `${did}#${zBase}` where the z-fragment repeats the
 * did:key's multibase body (did:key is self-describing — the fragment IS the key).
 */
export interface DidKeyIdentity {
  did: string
  ed25519Pub: Uint8Array
  ed25519Priv: Uint8Array
  x25519Pub: Uint8Array
  x25519Priv: Uint8Array
  keyId: string
}

/** Build a did:key identity from an Ed25519 keypair (the signing + the derived
 * X25519 keyAgreement keys). */
export function didKeyIdentityFromEd25519(input: {
  sodium: Sodium
  ed25519Pub: Uint8Array
  ed25519Priv: Uint8Array
}): DidKeyIdentity {
  const { sodium, ed25519Pub, ed25519Priv } = input
  const did = ed25519PubToDidKey(ed25519Pub)
  const x25519Pub = sodium.crypto_sign_ed25519_pk_to_curve25519(ed25519Pub)
  const x25519Priv = sodium.crypto_sign_ed25519_sk_to_curve25519(ed25519Priv)
  // The did:key fragment repeats the multibase body (did:key is self-describing).
  const zBase = did.slice("did:key:".length)
  return { did, ed25519Pub, ed25519Priv, x25519Pub, x25519Priv, keyId: `${did}#${zBase}` }
}
