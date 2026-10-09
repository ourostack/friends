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
import type { FriendStore } from "../store"
import type { FriendRecord, TrustLevel } from "../types"
import { parseDidKey } from "./did-key"
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
  | { decision: "rejected"; reason: "bad_rotation_proof" | "rotation_requires_reconfirm" | "not_pinned" | "stale_rotation" | "undated_rotation" | "retired_pin" | "successor_already_pinned" | "successor_key_mismatch" | "missing_successor_proof" | "bad_successor_proof" }

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

/** The statement the NEW key signs to consent to being the successor of `oldDid`. It
 * covers the old DID, the new DID, the new key and (when dated) the time, so a consent
 * cannot be reused for another predecessor, another key or another moment. */
function consentMessage(
  oldDid: string,
  newDid: string,
  newEd25519Pub: Uint8Array,
  b64: (b: Uint8Array) => string,
  issuedAt?: string,
): Uint8Array {
  const body = jcsBytes({
    statement: "key-successor-consent",
    predecessor: oldDid,
    successor: newDid,
    newKey: b64(newEd25519Pub),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  })
  // A fixed context prefix keeps this signature from ever matching a signature over a
  // bare JSON object, such as an envelope signature over a look-alike object.
  const out = new Uint8Array(CONSENT_CONTEXT.length + body.length)
  out.set(CONSENT_CONTEXT, 0)
  out.set(body, CONSENT_CONTEXT.length)
  return out
}

const CONSENT_CONTEXT = new TextEncoder().encode("ourostack-friends/v1/key-successor-consent\0")

/** Mint the successor's consent: the NEW private key signs the old DID, the new DID, the
 * new key and `issuedAt`. Returns the base64 detached signature for `successorProof`. */
export function signSuccessorConsent(input: {
  sodium: Sodium
  oldDid: string
  newDid: string
  newEd25519Pub: Uint8Array
  newEd25519Priv: Uint8Array
  issuedAt?: string
}): string {
  const { sodium } = input
  const b64 = (b: Uint8Array) => sodium.to_base64(b, sodium.base64_variants.ORIGINAL)
  const msg = consentMessage(input.oldDid, input.newDid, input.newEd25519Pub, b64, input.issuedAt)
  return b64(sodium.crypto_sign_detached(msg, input.newEd25519Priv))
}

/** Build both halves of a rotation from the two keys: `rotationProof` (old key) and
 * `successorProof` (new key). A host with both keys passes the result to
 * `evaluateRotation` on the receiving side. */
export function signFullSuccessor(input: {
  sodium: Sodium
  oldDid: string
  oldEd25519Priv: Uint8Array
  newDid: string
  newEd25519Pub: Uint8Array
  newEd25519Priv: Uint8Array
  issuedAt?: string
}): { rotationProof: string; successorProof: string; issuedAt?: string } {
  return {
    rotationProof: signSuccessor(input),
    successorProof: signSuccessorConsent(input),
    ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
  }
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
  /** The base64 signature from `signSuccessorConsent`: the NEW key consenting to succeed
   * `fromAgentId`. Required for every accepted rotation. */
  successorProof?: string
  /** The successor's key as the host verified it out of band (for example by resolving
   * a did:web document). Required to rotate to a different non-did:key DID. */
  resolvedSuccessorPub?: Uint8Array
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

  // A successor DID that is already pinned belongs to another peer: a statement signed
  // by this peer's key must not overwrite that pin.
  if (newDid !== fromAgentId && pinStore.get(newDid) !== undefined) {
    return { decision: "rejected", reason: "successor_already_pinned" }
  }

  // Unchanged key (same bytes) → nothing to rotate.
  if (current.did === newDid && bytesEqual(current.ed25519Pub, newEd25519Pub)) {
    return { decision: "unchanged" }
  }

  // The successor DID must belong to the successor key, or a peer could pin a key under
  // a DID it does not control (squatting a victim's DID before the victim first calls).
  const derived = parseDidKey(newDid)
  if (derived) {
    if (!bytesEqual(derived.ed25519Pub, newEd25519Pub)) {
      return { decision: "rejected", reason: "successor_key_mismatch" }
    }
  } else if (input.resolvedSuccessorPub === undefined || !bytesEqual(input.resolvedSuccessorPub, newEd25519Pub)) {
    // Any other method, a same-DID rotation included, needs the host's own resolution.
    return { decision: "rejected", reason: "successor_key_mismatch" }
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

  // The successor must consent too, or a peer could name any real DID and key as its
  // successor. The NEW key signs the old DID, the new DID, its own key and the date.
  if (input.successorProof === undefined) return { decision: "rejected", reason: "missing_successor_proof" }
  let consented = false
  try {
    const consentSig = sodium.from_base64(input.successorProof, sodium.base64_variants.ORIGINAL)
    consented = sodium.crypto_sign_verify_detached(consentSig, consentMessage(fromAgentId, newDid, newEd25519Pub, b64, issuedAt), newEd25519Pub)
  } catch {
    consented = false
  }
  if (!consented) return { decision: "rejected", reason: "bad_successor_proof" }

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

// ── Carrying the relationship across an accepted rotation ──────────────────────

export type ApplyRotationResult =
  | { ok: true; record: FriendRecord }
  | { ok: false; reason: "rotation_not_accepted" | "rotation_chain_invalid" | "record_not_found" | "successor_already_linked" }

/** The most rotations `applyAcceptedRotation` will follow from the old DID. */
export const MAX_ROTATION_HOPS = 16

/** After `evaluateRotation` returns `accepted`, call this to move the peer's record from
 * the old DID to where the rotation chain ends. It follows `retiredBy` hop by hop from
 * `oldDid` to the live pin, so back-to-back rotations (A to B to C) do not strand the
 * record: `newDid` may be any DID on the chain, and the record always moves to the live
 * end. It moves the `a2a-agent` external id and the record's DID and keeps trust, grant
 * and profile, because a verified rotation is the same peer (this is not a reset). It
 * looks for the record at `oldDid` first, then at each later DID before the live end, so
 * a record already moved part-way is finished. It refuses unless every hop is a retired
 * pin naming an existing next pin, the chain ends in a live pin, and `newDid` is on it
 * (`rotation_not_accepted`), or the chain loops or exceeds 16 hops (`rotation_chain_invalid`). */
export async function applyAcceptedRotation(input: {
  store: FriendStore
  pinStore: PinStore
  oldDid: string
  newDid: string
}): Promise<ApplyRotationResult> {
  const { store, pinStore, oldDid, newDid } = input
  const chain = [oldDid]
  for (;;) {
    const next = pinStore.get(chain[chain.length - 1])?.retiredBy
    if (next === undefined) break
    if (chain.includes(next) || chain.length > MAX_ROTATION_HOPS) return { ok: false, reason: "rotation_chain_invalid" }
    if (pinStore.get(next) === undefined) return { ok: false, reason: "rotation_not_accepted" }
    chain.push(next)
  }
  const liveEnd = chain[chain.length - 1]
  if (chain.length < 2 || !chain.includes(newDid) || newDid === oldDid || getPinned(pinStore, liveEnd) === undefined) {
    return { ok: false, reason: "rotation_not_accepted" }
  }

  let record: FriendRecord | null = null
  let heldAt = oldDid
  for (const did of chain.slice(0, -1)) {
    record = await store.findByExternalId("a2a-agent", did)
    if (record) {
      heldAt = did
      break
    }
  }
  if (!record) return { ok: false, reason: "record_not_found" }
  const holder = await store.findByExternalId("a2a-agent", liveEnd)
  if (holder && holder.id !== record.id) return { ok: false, reason: "successor_already_linked" }

  const { pinnedKey: _stalePinnedKey, ...identity } = record.agentMeta?.identity ?? {}
  const agentMeta = record.agentMeta
    ? {
        ...record.agentMeta,
        a2a: { ...record.agentMeta.a2a, agentId: liveEnd, did: liveEnd },
        identity: { ...identity, did: liveEnd },
      }
    : undefined
  const updated: FriendRecord = {
    ...record,
    externalIds: record.externalIds.map((ext) =>
      ext.provider === "a2a-agent" && ext.externalId === heldAt ? { ...ext, externalId: liveEnd } : ext),
    ...(agentMeta ? { agentMeta } : {}),
    updatedAt: new Date().toISOString(),
  }
  await store.put(updated.id, updated)
  return { ok: true, record: updated }
}
