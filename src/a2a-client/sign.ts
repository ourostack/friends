// sign — Ed25519 detached signing/verification over JCS-canonical envelope bytes,
// and the structured proof that rides in the envelope's reserved `proof?: string`
// slot (decision #3; the envelope-level `proof` TYPE is unchanged so CORE needs no
// edit).
//
// CRITICAL: the signature is computed over the envelope with its `proof` field
// EXCLUDED — you cannot sign over the proof you are producing, and the verifier
// must recompute the identical canonical bytes. Both sides strip `proof` before
// `jcsBytes`.
import { jcsBytes } from "./jcs"
import type { Sodium } from "./sodium"

/** The structured proof serialized (as JSON) into the envelope's `proof?: string`
 * slot. `alg`/`canon` are pinned so a verifier rejects anything it can't check. */
export interface StructuredProof {
  alg: "EdDSA"
  /** The detached Ed25519 signature, base64 (ORIGINAL variant). */
  sig: string
  /** The signer's DID (== its agentId; the binding is checked by DidVerifier). */
  signerDid: string
  /** The signer's key id (the did:key fragment / DID-doc verification-method id). */
  signerKeyId: string
  canon: "JCS"
}

/** Strip the `proof` field so signing/verifying both canonicalize the same bytes.
 * Returns a shallow copy without `proof` (the rest of the envelope is unchanged). */
function envelopeWithoutProof(envelope: unknown): unknown {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return envelope
  const { proof: _proof, ...rest } = envelope as Record<string, unknown>
  return rest
}

export interface SignEnvelopeInput {
  sodium: Sodium
  /** The plaintext envelope to sign (its `proof` field, if any, is excluded). */
  envelope: unknown
  signerEd25519Priv: Uint8Array
  signerDid: string
  signerKeyId: string
}

/** Sign an envelope: Ed25519 detached signature over `jcsBytes(envelope without
 * proof)`. Returns the structured proof. */
export function signEnvelope(input: SignEnvelopeInput): StructuredProof {
  const { sodium, envelope, signerEd25519Priv, signerDid, signerKeyId } = input
  const msg = jcsBytes(envelopeWithoutProof(envelope))
  const sig = sodium.crypto_sign_detached(msg, signerEd25519Priv)
  return {
    alg: "EdDSA",
    sig: sodium.to_base64(sig, sodium.base64_variants.ORIGINAL),
    signerDid,
    signerKeyId,
    canon: "JCS",
  }
}

export interface VerifyEnvelopeSignatureInput {
  sodium: Sodium
  /** The plaintext envelope whose signature is being checked (proof excluded). */
  envelope: unknown
  /** The structured proof — either the object or its JSON string form. */
  proof: StructuredProof | string | undefined
  signerEd25519Pub: Uint8Array
}

/** Verify an envelope's Ed25519 signature. Returns false (never throws) on a
 * malformed proof, wrong `alg`/`canon`, missing fields, bad base64, or a bad
 * signature. */
export function verifyEnvelopeSignature(input: VerifyEnvelopeSignatureInput): boolean {
  const { sodium, envelope, signerEd25519Pub } = input
  const proof = typeof input.proof === "string" ? parseProof(input.proof) : input.proof
  if (!proof) return false
  if (proof.alg !== "EdDSA" || proof.canon !== "JCS") return false
  if (typeof proof.sig !== "string" || typeof proof.signerDid !== "string" || typeof proof.signerKeyId !== "string") {
    return false
  }

  let sigBytes: Uint8Array
  try {
    sigBytes = sodium.from_base64(proof.sig, sodium.base64_variants.ORIGINAL)
  } catch {
    return false
  }

  const msg = jcsBytes(envelopeWithoutProof(envelope))
  try {
    return sodium.crypto_sign_verify_detached(sigBytes, msg, signerEd25519Pub)
  } catch {
    // A wrong-length signature can throw inside libsodium — treat as a failed
    // verification, never an uncaught error.
    return false
  }
}

/** Serialize a structured proof into the envelope's `proof?: string` slot. */
export function serializeProof(p: StructuredProof): string {
  return JSON.stringify(p)
}

/** Parse a structured proof from the `proof?: string` slot. Returns null on
 * invalid JSON or a non-object payload; field-level validation is the verifier's
 * job (so a partially-shaped proof still surfaces as a verify failure). */
export function parseProof(s: string): StructuredProof | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  return parsed as StructuredProof
}
