// DidVerifier — the AgentVerifier seam implementation (the interface is UNCHANGED;
// this is a new impl). Its `verify` is a PURE SYNC Ed25519 check over already-
// resolved key material: the adapter (U8) resolves + pins the sender's DID doc
// ASYNC *before* calling the importer, then hands the importer this sync verifier,
// so the core importer stays sync (it never learns about DIDs or the network).
//
// Three jobs here:
//   1. verify(fromAgentId, proof) — agentId===did binding + pinned-key signature check.
//   2. TOFU pin (accept + pin on first contact; verify-against-pin thereafter).
//   3. trust-tiered key-rotation (Fork 11): family/friend auto-accept a SIGNED
//      successor proof; acquaintance/stranger reject (re-confirm out of band).
import type { AgentVerifier } from "../verifier"
import type { TrustLevel } from "../types"
import { jcsBytes } from "./jcs"
import type { Sodium } from "./sodium"
import { verifyEnvelopeSignature, parseProof } from "./sign"

/** The pinned identity record for a peer (persisted by the HOST onto
 * `AgentMeta.a2a.did` + a pinned-key field; injectable so tests use a map). */
export interface PinnedDid {
  did: string
  ed25519Pub: Uint8Array
  /** When the pin was last moved by a verified rotation: the successor statement's
   * `issuedAt` (or the acceptance time for an opted-in undated statement). A later
   * successor statement must be newer than this. Absent until the first rotation.
   * HOSTS MUST PERSIST THIS FIELD, or the replay guard does nothing. */
  rotatedAt?: string
  /** Set only on a RETIRED pin: the DID this one rotated to. A retired pin is a
   * tombstone kept under the old DID so the old (possibly compromised) key cannot be
   * pinned again, cannot rotate again, and cannot verify anything. HOSTS MUST PERSIST
   * THIS FIELD with the rest of the pin, and must treat a pin that carries it as
   * unusable (including in any `resolveAndPin` implementation). */
  retiredBy?: string
}

/** A pin store the host implements (in-memory map in tests; persisted on the
 * agent record in production — a2a-client never touches fs itself). */
export interface PinStore {
  get(fromAgentId: string): PinnedDid | undefined
  set(fromAgentId: string, pinned: PinnedDid): void
  /** Retire a pin. A verified rotation moves the pin to the new DID and calls this
   * for the old one. The store must keep a tombstone under `fromAgentId`: the old
   * `did` and key with `retiredBy` and `rotatedAt` set, persisted. Required: a host
   * that cannot retire a pin cannot rotate safely. */
  retire(fromAgentId: string, retiredBy: string, rotatedAt: string): void
}

/** A simple in-memory PinStore (used by tests + as a host convenience). */
export class MemoryPinStore implements PinStore {
  private readonly map = new Map<string, PinnedDid>()
  get(fromAgentId: string): PinnedDid | undefined {
    return this.map.get(fromAgentId)
  }
  set(fromAgentId: string, pinned: PinnedDid): void {
    this.map.set(fromAgentId, pinned)
  }
  retire(fromAgentId: string, retiredBy: string, rotatedAt: string): void {
    const current = this.map.get(fromAgentId)
    if (!current) return
    this.map.set(fromAgentId, { ...current, retiredBy, rotatedAt })
  }
}

/** Constant-time-ish byte equality (length-checked). The keys are public, so this
 * is correctness, not timing-secrecy — but keep it total. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export interface DidVerifierInput {
  sodium: Sodium
  /** The already-resolved+pinned Ed25519 public key for the inbound message's
   * sender (the key the signature is verified against). */
  pinnedEd25519Pub: Uint8Array
  /** The DID the pinned key belongs to (== the expected `fromAgentId`). */
  pinnedDid: string
  /** The concrete inbound plaintext envelope this verifier is bound to. The
   * signature is over `jcsBytes(envelope without proof)`, so the verifier must
   * hold the envelope to perform a REAL crypto check inside the sync `verify`.
   * The adapter (U8) constructs a fresh DidVerifier per inbound message. */
  envelope: unknown
}

/** The sync verifier handed to a core importer. Bound to one inbound envelope;
 * `verify` confirms the agentId===did binding AND the Ed25519 signature over that
 * envelope against the PINNED key. Pure sync, no I/O — the async DID resolve + pin
 * happened in the adapter BEFORE construction. */
export class DidVerifier implements AgentVerifier {
  private readonly sodium: Sodium
  private readonly pinnedEd25519Pub: Uint8Array
  private readonly pinnedDid: string
  private readonly envelope: unknown

  constructor(input: DidVerifierInput) {
    this.sodium = input.sodium
    this.pinnedEd25519Pub = input.pinnedEd25519Pub
    this.pinnedDid = input.pinnedDid
    this.envelope = input.envelope
  }

  /** Sync, no I/O. False on any binding or signature failure. */
  verify(fromAgentId: string, proof?: string): boolean {
    if (proof === undefined) return false
    const parsed = parseProof(proof)
    if (!parsed) return false
    // agentId === did binding (Fork 10): the proof's signer DID must equal the
    // arriving agentId AND the pinned DID. A spoof where agentId ≠ signerDid, or a
    // proof claiming a different DID than the pinned one, is rejected here before
    // any crypto.
    if (parsed.signerDid !== fromAgentId) return false
    if (parsed.signerDid !== this.pinnedDid) return false
    // Real cryptographic gate: the pinned Ed25519 key must have signed this exact
    // (proof-stripped) envelope.
    return verifyEnvelopeSignature({
      sodium: this.sodium,
      envelope: this.envelope,
      proof: parsed,
      signerEd25519Pub: this.pinnedEd25519Pub,
    })
  }
}

// ── Bidirectional card ↔ DID binding ──────────────────────────────────────────

export interface CardDidBindingInput {
  /** The agent card (carries a `did`; for did:web also a back-reference). */
  card: { did?: unknown; url?: unknown }
  /** The resolved DID document (did:web). For did:key pass `null` — the binding is
   * "card.did === the did:key string" only (did:key is self-contained). */
  didDoc: { id: string; cardServiceUrl?: string } | null
  /** The DID the card claims (the agent's identity). */
  did: string
}

/** Verify the card and DID agree BOTH directions. For did:web: card.did === did
 * === didDoc.id AND the doc's `service` endpoint === the card URL. For did:key
 * (didDoc null): card.did === did only. */
export function verifyCardDidBinding(input: CardDidBindingInput): boolean {
  const cardDid = typeof input.card.did === "string" ? input.card.did : undefined
  if (cardDid !== input.did) return false // card → DID

  if (input.didDoc === null) {
    // did:key: self-contained; the card.did === did check above is sufficient.
    return true
  }

  // did:web: DID → card. The doc must reference the card URL via a service entry.
  if (input.didDoc.id !== input.did) return false
  const cardUrl = typeof input.card.url === "string" ? input.card.url : undefined
  if (!cardUrl) return false
  return input.didDoc.cardServiceUrl === cardUrl
}

// ── TOFU pin ──────────────────────────────────────────────────────────────────

/** First contact: accept + pin the (did, key). Idempotent re-pin to the same key
 * is fine; a DIFFERENT key for an existing pin must go through `evaluateRotation`,
 * not this. Returns the pinned record. */
export function pinOnFirstContact(input: {
  pinStore: PinStore
  fromAgentId: string
  did: string
  ed25519Pub: Uint8Array
}): PinnedDid {
  // A retired DID never comes back: re-pinning its key would undo the rotation.
  if (input.pinStore.get(input.fromAgentId)?.retiredBy !== undefined || input.pinStore.get(input.did)?.retiredBy !== undefined) {
    throw new Error("DID pin is retired; it cannot be pinned again")
  }
  const pinned: PinnedDid = { did: input.did, ed25519Pub: input.ed25519Pub }
  input.pinStore.set(input.fromAgentId, pinned)
  return pinned
}

/** Whether a peer is already pinned. */
export function isPinned(pinStore: PinStore, fromAgentId: string): boolean {
  return getPinned(pinStore, fromAgentId) !== undefined
}

/** The pinned record for a peer, or undefined. */
export function getPinned(pinStore: PinStore, fromAgentId: string): PinnedDid | undefined {
  const pinned = pinStore.get(fromAgentId)
  return pinned && pinned.retiredBy === undefined ? pinned : undefined
}

// ── Trust-tiered key rotation (Fork 11) ────────────────────────────────────────

export type RotationDecision =
  | { decision: "unchanged" }
  | { decision: "accepted" }
  | { decision: "rejected"; reason: "bad_rotation_proof" | "rotation_requires_reconfirm" | "not_pinned" | "stale_rotation" | "undated_rotation" | "retired_pin" }

/** Successor statements dated further ahead than this are rejected. */
const ROTATION_CLOCK_SKEW_MS = 2 * 60 * 1000

/** The canonical successor statement the OLD key signs to authorize a rotation.
 * With `issuedAt` it is the current shape. Without it, it is the original shape,
 * which `evaluateRotation` accepts only with `acceptUndatedSuccessor: true`. */
function successorMessage(
  newDid: string,
  newEd25519Pub: Uint8Array,
  b64: (b: Uint8Array) => string,
  issuedAt?: string,
): Uint8Array {
  return jcsBytes({
    statement: "key-successor",
    successor: newDid,
    newKey: b64(newEd25519Pub),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  })
}

/** Mint a rotation proof: the OLD private key signs `{successor:newDid, newKey,
 * issuedAt}`. Pass `issuedAt` (ISO time) to mint the current shape; omit it to mint
 * the original shape, accepted only with `acceptUndatedSuccessor`. Returns the base64
 * detached signature. (Test/host helper.) */
export function signSuccessor(input: {
  sodium: Sodium
  oldEd25519Priv: Uint8Array
  newDid: string
  newEd25519Pub: Uint8Array
  issuedAt?: string
}): string {
  const { sodium } = input
  const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
  const msg = successorMessage(input.newDid, input.newEd25519Pub, b64, input.issuedAt)
  return b64(sodium.crypto_sign_detached(msg, input.oldEd25519Priv))
}

export interface EvaluateRotationInput {
  sodium: Sodium
  pinStore: PinStore
  fromAgentId: string
  trustOfSource: TrustLevel
  newDid: string
  newEd25519Pub: Uint8Array
  /** The base64 signature from `signSuccessor`, if presented. */
  rotationProof?: string
  /** The `issuedAt` the successor statement was signed with. Required unless
   * `acceptUndatedSuccessor` is set. */
  issuedAt?: string
  /** Opt in to the original undated statement shape, which cannot be replay-checked.
   * Default false. */
  acceptUndatedSuccessor?: boolean
  /** Clock override for tests. */
  now?: Date
}

/** Evaluate a presented key against the pin (Fork 11). family/friend auto-accept a
 * VALID signed successor proof (re-pin); acquaintance/stranger reject regardless;
 * an unchanged key is `unchanged`; an unpinned peer is `not_pinned` (use TOFU). */
export function evaluateRotation(input: EvaluateRotationInput): RotationDecision {
  const { sodium, pinStore, fromAgentId, trustOfSource, newDid, newEd25519Pub } = input
  const current = pinStore.get(fromAgentId)
  if (!current) return { decision: "rejected", reason: "not_pinned" }
  // A retired DID cannot rotate again, and nothing may rotate back onto one.
  if (current.retiredBy !== undefined || pinStore.get(newDid)?.retiredBy !== undefined) {
    return { decision: "rejected", reason: "retired_pin" }
  }

  // Unchanged key (same bytes) → nothing to rotate.
  if (current.did === newDid && bytesEqual(current.ed25519Pub, newEd25519Pub)) {
    return { decision: "unchanged" }
  }

  // acquaintance / stranger: never auto-accept a rotation, even with a valid proof.
  if (trustOfSource === "acquaintance" || trustOfSource === "stranger") {
    return { decision: "rejected", reason: "rotation_requires_reconfirm" }
  }

  // family / friend: require a VALID signed successor proof from the OLD pinned key.
  if (input.rotationProof === undefined) {
    return { decision: "rejected", reason: "bad_rotation_proof" }
  }
  const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
  const issuedAt = input.issuedAt
  const msg = successorMessage(newDid, newEd25519Pub, b64, issuedAt)
  let sig: Uint8Array
  try {
    sig = sodium.from_base64(input.rotationProof, sodium.base64_variants.ORIGINAL)
  } catch {
    return { decision: "rejected", reason: "bad_rotation_proof" }
  }
  let ok = false
  try {
    ok = sodium.crypto_sign_verify_detached(sig, msg, current.ed25519Pub)
  } catch {
    ok = false
  }
  if (!ok) return { decision: "rejected", reason: "bad_rotation_proof" }

  // Replay guard. A statement must be dated, not in the future, and newer than the
  // pin's last rotation. An undated one cannot be checked, so it needs the opt-in.
  const now = input.now ?? new Date()
  if (issuedAt === undefined) {
    if (input.acceptUndatedSuccessor !== true) return { decision: "rejected", reason: "undated_rotation" }
  } else {
    const issued = Date.parse(issuedAt)
    if (!Number.isFinite(issued) || issued > now.getTime() + ROTATION_CLOCK_SKEW_MS) {
      return { decision: "rejected", reason: "stale_rotation" }
    }
    if (current.rotatedAt !== undefined && issued <= Date.parse(current.rotatedAt)) {
      return { decision: "rejected", reason: "stale_rotation" }
    }
  }

  // Valid: move the pin to the new DID and retire the old one, so messages signed by
  // the new DID verify and the old key no longer does.
  const rotatedAt = issuedAt ?? now.toISOString()
  pinStore.set(newDid, { did: newDid, ed25519Pub: newEd25519Pub, rotatedAt })
  if (newDid !== fromAgentId) pinStore.retire(fromAgentId, newDid, rotatedAt)
  return { decision: "accepted" }
}
