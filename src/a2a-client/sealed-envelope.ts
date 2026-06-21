// SealedEnvelope — the full sign-then-seal compose (ties U2 seal + U3 sign).
//
// ORDER (sign-then-seal, spec §3.1): sign the plaintext envelope FIRST, put the
// structured proof in the envelope's reserved slot, then SEAL the whole signed
// bundle to the recipient. The signature lives INSIDE the ciphertext — the relay
// never sees who signed. `friendsKind` also rides inside the sealed plaintext
// (relay-blind), so the recipient unseals first, THEN branches on the kind.
import { openSealed, sealTo } from "./seal"
import type { SealedBlob } from "./seal"
import { serializeProof, signEnvelope } from "./sign"
import type { Sodium } from "./sodium"

/** The friends taxonomy discriminant (the re-homed mailbox `kind`). Travels
 * SEALED, never on the DataPart `data`. */
export type FriendsKind = "profile_share" | "mission_share" | "coordination"

/** The on-the-wire sealed envelope: NOTHING plaintext beyond the version. */
export interface SealedEnvelope {
  v: number
  sealed: SealedBlob
}

/** The signer's identity material (self). */
export interface FromIdentity {
  did: string
  keyId: string
  ed25519Priv: Uint8Array
}

/** The exact JSON object that gets sealed. Kept explicit so the open side parses
 * the identical shape. */
interface SealedPlaintext {
  envelope: unknown
  signature: string
  signerDid: string
  signerKeyId: string
  recipient: string
  v: number
  friendsKind: FriendsKind
}

export interface SealEnvelopeInput {
  sodium: Sodium
  /** The plaintext friends envelope (ProfileShare/MissionShare/Coordination). */
  envelope: Record<string, unknown>
  friendsKind: FriendsKind
  fromIdentity: FromIdentity
  recipientDid: string
  recipientX25519Pub: Uint8Array
  v?: number
}

/** Sign-then-seal compose. Returns the opaque SealedEnvelope. */
export function sealEnvelope(input: SealEnvelopeInput): SealedEnvelope {
  const { sodium, envelope, friendsKind, fromIdentity, recipientDid, recipientX25519Pub } = input
  const v = input.v ?? 1

  // 1. Sign the envelope (proof excluded from the canonical bytes — see sign.ts).
  const proof = signEnvelope({
    sodium,
    envelope,
    signerEd25519Priv: fromIdentity.ed25519Priv,
    signerDid: fromIdentity.did,
    signerKeyId: fromIdentity.keyId,
  })

  // 2. Put the structured proof in the envelope's reserved slot, so the unsealed
  //    plaintext carries the proof the importer reads via `envelope.proof`.
  const envelopeWithProof = { ...envelope, proof: serializeProof(proof) }

  // 3. Build the sealed plaintext (friendsKind + the recipient binding ride INSIDE).
  const plaintext: SealedPlaintext = {
    envelope: envelopeWithProof,
    signature: proof.sig,
    signerDid: proof.signerDid,
    signerKeyId: proof.signerKeyId,
    recipient: recipientDid,
    v,
    friendsKind,
  }
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(plaintext))

  // 4. Seal to the recipient (the recipientDid is bound into the AEAD AD by sealTo).
  const sealed = sealTo({ sodium, plaintextBytes, recipientX25519Pub, recipientDid, v })
  return { v, sealed }
}

/** The recipient's identity material (self). */
export interface RecipientIdentity {
  x25519Priv: Uint8Array
  x25519Pub: Uint8Array
}

export type OpenSealedEnvelopeResult =
  | {
      ok: true
      envelope: Record<string, unknown>
      fromAgentId: string
      signerDid: string
      signerKeyId: string
      friendsKind: FriendsKind
    }
  | { ok: false; error: "unseal_failed" | "malformed_plaintext" | "recipient_mismatch" }

export interface OpenSealedEnvelopeInput {
  sodium: Sodium
  sealedEnvelope: SealedEnvelope
  recipientDid: string
  recipientIdentity: RecipientIdentity
}

/** Open a SealedEnvelope. Does NOT verify the signature (U8's adapter resolves +
 * pins the sender DID, then runs DidVerifier — the single authentication gate).
 * The belt-and-suspenders `recipient === recipientDid` check is the redundant
 * second line behind the AEAD AD (which already enforced it). */
export function openSealedEnvelope(input: OpenSealedEnvelopeInput): OpenSealedEnvelopeResult {
  const { sodium, sealedEnvelope, recipientDid, recipientIdentity } = input

  let plaintextBytes: Uint8Array
  try {
    plaintextBytes = openSealed({
      sodium,
      blob: sealedEnvelope.sealed,
      recipientX25519Priv: recipientIdentity.x25519Priv,
      recipientX25519Pub: recipientIdentity.x25519Pub,
      recipientDid,
    })
  } catch {
    return { ok: false, error: "unseal_failed" }
  }

  let plaintext: SealedPlaintext
  try {
    const parsed = JSON.parse(new TextDecoder().decode(plaintextBytes))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "malformed_plaintext" }
    }
    plaintext = parsed as SealedPlaintext
  } catch {
    return { ok: false, error: "malformed_plaintext" }
  }

  if (!plaintext.envelope || typeof plaintext.envelope !== "object") {
    return { ok: false, error: "malformed_plaintext" }
  }
  if (typeof plaintext.friendsKind !== "string" || typeof plaintext.signerDid !== "string") {
    return { ok: false, error: "malformed_plaintext" }
  }

  // Belt-and-suspenders: the AEAD AD already bound the recipient, but re-assert.
  if (plaintext.recipient !== recipientDid) {
    return { ok: false, error: "recipient_mismatch" }
  }

  const envelope = plaintext.envelope as Record<string, unknown>
  const fromAgentId = typeof envelope.fromAgentId === "string" ? envelope.fromAgentId : ""

  return {
    ok: true,
    envelope,
    fromAgentId,
    signerDid: plaintext.signerDid,
    signerKeyId: plaintext.signerKeyId,
    friendsKind: plaintext.friendsKind,
  }
}
