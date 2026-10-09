// adapter — the host-side send/receive that ties everything together. Transports
// are INJECTABLE (no real HTTP/git in this module; the host supplies them; the
// malicious-relay proof supplies a hostile stub). The async DID resolve + pin runs
// BEFORE the (sync) core importer, so the importer's verifier stays sync.
import { importCoordination } from "../coordination"
import { receiveMessage } from "../message"
import type { ReceivedMessage } from "../message"
import { importMissionShare } from "../mission-share"
import { importProfileShare } from "../share"
import type { FriendStore } from "../store"
import type { MissionStore } from "../mission-store"
import type { TrustLevel } from "../types"
import { DidVerifier } from "./did-verifier"
import type { PinStore } from "./did-verifier"
import { unwrapDataPart, wrapInDataPart } from "./a2a-message"
import type { A2AMessage } from "./a2a-message"
import { resolveReachability } from "./reachability"
import { assertValidBindingOptions, checkEnvelopeBinding } from "./envelope-binding"
import type { EnvelopeBindingOptions } from "./envelope-binding"
import { sealEnvelope, openSealedEnvelope } from "./sealed-envelope"
import type { FriendsKind, FromIdentity, RecipientIdentity, SealedEnvelope } from "./sealed-envelope"
import type { Sodium } from "./sodium"

/** An injectable A2A transport: deliver one A2A message to a target. Direct + relay
 * are both "send an A2A message"; the proof's relay stub implements this maliciously.
 */
export interface A2ATransport {
  send(target: { rung: "direct" | "relay" | "mailbox"; address: string }, message: A2AMessage): Promise<void>
}

/** The async DID resolve + pin step (wraps did:key / did:web + TOFU + binding). It
 * runs BEFORE the importer so the verifier handed to the importer is pure-sync. */
export interface DidResolution {
  /** Resolve `did` to its pinned Ed25519 (+ optionally X25519) key material,
   * pinning on first contact and verifying against the pin thereafter. Returns
   * null on an unresolvable / failed-binding / failed-rotation DID. */
  resolveAndPin(input: {
    fromAgentId: string
    did: string
    pinStore: PinStore
    trustOfSource: TrustLevel
  }): Promise<{ ed25519Pub: Uint8Array } | null>
}

// ── send ────────────────────────────────────────────────────────────────────

export type SendShareResult =
  | { ok: true; rung: "direct" | "relay" | "mailbox"; message: A2AMessage }
  | { ok: false; reason: "unreachable" | "resolve_failed" }

export interface SendShareInput {
  sodium: Sodium
  transport: A2ATransport
  fromIdentity: FromIdentity
  /** The recipient peer's coords. */
  toPeer: { a2a?: { endpointUrl?: string; relay?: { url: string; handle: string }; did?: string }; mailbox?: { repo: string; selfOutboxAgentId: string } }
  recipientDid: string
  recipientX25519Pub: Uint8Array
  plaintextEnvelope: Record<string, unknown>
  friendsKind: FriendsKind
}

/** Seal+sign a friends envelope and deliver it over the resolved rung. The SAME
 * SealedEnvelope is built regardless of rung (direct/relay/mailbox) — only the
 * transport target differs. */
export async function sendShare(input: SendShareInput): Promise<SendShareResult> {
  const plan = resolveReachability(input.toPeer.a2a, input.toPeer.mailbox)
  if (plan.rung === "unreachable") {
    return { ok: false, reason: "unreachable" }
  }

  const sealed: SealedEnvelope = sealEnvelope({
    sodium: input.sodium,
    envelope: input.plaintextEnvelope,
    friendsKind: input.friendsKind,
    fromIdentity: input.fromIdentity,
    recipientDid: input.recipientDid,
    recipientX25519Pub: input.recipientX25519Pub,
  })
  const message = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: input.recipientDid })

  const address =
    plan.rung === "direct" ? plan.endpointUrl : plan.rung === "relay" ? plan.relay.handle : plan.mailbox.repo
  await input.transport.send({ rung: plan.rung, address }, message)
  return { ok: true, rung: plan.rung, message }
}

// ── receive ───────────────────────────────────────────────────────────────────

/** A2A TaskState mapping for an inbound share. `completed` carries the importer
 * status; `rejected` carries the reason code. */
export type ReceiveShareResult =
  | { state: "completed"; friendsKind: FriendsKind; status: string; message?: ReceivedMessage; bound: boolean; bindingId?: string }
  | {
      state: "rejected"
      reason:
        | "malformed_message"
        | "unseal_failed"
        | "recipient_mismatch"
        | "malformed_plaintext"
        | "sender_binding_mismatch"
        | "resolve_failed"
        | "replayed"
        | "bad_signature"
        | "untrusted_source"
        | "signed_recipient_mismatch"
        | "signed_kind_mismatch"
        | "malformed_binding"
        | "stale_envelope"
        | "stale_delegation"
        | "unbound_delegation"
        | "unbound_envelope"
        | "import_failed"
    }

export interface SeenLedgerLike {
  isSeen(nonce: string): boolean
  markSeen(nonce: string): void
}

export interface ReceiveShareInput {
  sodium: Sodium
  store: FriendStore
  missionStore: MissionStore
  pinStore: PinStore
  didResolution: DidResolution
  seen: SeenLedgerLike
  a2aMessage: A2AMessage
  recipientDid: string
  recipientIdentity: RecipientIdentity
  trustOfSource: TrustLevel
  /** Binding and freshness settings (clock, age windows, `rejectUnboundEnvelopes`). */
  options?: EnvelopeBindingOptions
}

/** In-flight claims, per ledger instance: keys of deliveries that passed their replay
 * checks and are still being processed. They stop parallel duplicates without touching
 * the durable ledger, and are always released, so a failed attempt burns nothing. */
const IN_FLIGHT = new WeakMap<SeenLedgerLike, Set<string>>()

function inFlightFor(seen: SeenLedgerLike): Set<string> {
  let set = IN_FLIGHT.get(seen)
  if (!set) {
    set = new Set<string>()
    IN_FLIGHT.set(seen, set)
  }
  return set
}

/** The ledger key for one sealed blob: a hash over the whole blob (ePk, nonce and
 * ciphertext), so a forged blob that reuses a real blob's nonce cannot collide with it. */
function blobKey(sodium: Sodium, blob: { ePk: string; n: string; ct: string }): string {
  const digest = sodium.crypto_generichash(24, `${blob.ePk}|${blob.n}|${blob.ct}`, null)
  return `blob:${sodium.to_base64(digest, sodium.base64_variants.URLSAFE_NO_PADDING)}`
}

/** Receive a sealed A2A message: unwrap → unseal → check the signed binding → resolve+pin
 * the SENDER → build a sync DidVerifier → branch on the (unsealed) friendsKind → call the
 * UNCHANGED importer → map to A2A TaskState.
 *
 * Replay protection: before the first `await`, the blob key and the `mid:` key are
 * checked against the durable ledger and claimed in an in-memory in-flight set (released
 * on every exit). They are marked in the durable ledger only once the signature verifies,
 * so a transient failure leaves the message redeliverable and a forged blob cannot burn a
 * real one. A legacy nonce-only ledger entry still counts as seen. Throws a TypeError on
 * invalid `options` (non-finite clock or windows). */
export async function receiveShare(input: ReceiveShareInput): Promise<ReceiveShareResult> {
  if (input.options) assertValidBindingOptions(input.options)
  const payload = unwrapDataPart(input.a2aMessage)
  if (!payload) return { state: "rejected", reason: "malformed_message" }

  const inFlight = inFlightFor(input.seen)
  const nonceKey = blobKey(input.sodium, payload.sealed)
  if (input.seen.isSeen(payload.sealed.n) || input.seen.isSeen(nonceKey) || inFlight.has(nonceKey)) {
    return { state: "rejected", reason: "replayed" }
  }

  const opened = openSealedEnvelope({
    sodium: input.sodium,
    sealedEnvelope: { v: payload.v, sealed: payload.sealed },
    recipientDid: input.recipientDid,
    recipientIdentity: input.recipientIdentity,
  })
  if (!opened.ok) {
    // unseal_failed / malformed_plaintext / recipient_mismatch map 1:1.
    return { state: "rejected", reason: opened.error }
  }

  // SECURITY (binding): the trustworthy sender identity is `opened.fromAgentId` —
  // it lives INSIDE the signed envelope bytes, so it is authentic once the
  // signature verifies. `opened.signerDid` comes from the OUTER, UNSIGNED sealed
  // plaintext and is ADVISORY only. We pin/verify/route on the SIGNED
  // `fromAgentId`, and require the advisory `signerDid` to match it (a divergence
  // is a malformed/spoofed bundle). The real gate remains DidVerifier: the pinned
  // key (keyed to `fromAgentId`) must have signed THIS envelope.
  const senderDid = opened.fromAgentId
  if (senderDid.length === 0 || opened.signerDid !== senderDid) {
    return { state: "rejected", reason: "sender_binding_mismatch" }
  }

  // Recipient/kind/id/time binding (durable check only), then the synchronous in-flight claim.
  const binding = checkEnvelopeBinding(opened, { ...input.options, recipientDid: input.recipientDid, seen: input.seen })
  if (!binding.ok) return { state: "rejected", reason: binding.reason }
  if (binding.seenKey !== undefined && inFlight.has(binding.seenKey)) {
    return { state: "rejected", reason: "replayed" }
  }
  const claimed = binding.seenKey === undefined ? [nonceKey] : [nonceKey, binding.seenKey]
  for (const key of claimed) inFlight.add(key)
  try {
    return await processClaimed(input, opened, senderDid, binding, claimed)
  } finally {
    for (const key of claimed) inFlight.delete(key)
  }
}

async function processClaimed(
  input: ReceiveShareInput,
  opened: Extract<ReturnType<typeof openSealedEnvelope>, { ok: true }>,
  senderDid: string,
  binding: { bound: boolean; bindingId?: string },
  claimed: string[],
): Promise<ReceiveShareResult> {
  const bound = binding.bound

  // Resolve + pin the SENDER's DID (async — BEFORE the sync importer/verifier).
  const resolved = await input.didResolution.resolveAndPin({
    fromAgentId: senderDid,
    did: senderDid,
    pinStore: input.pinStore,
    trustOfSource: input.trustOfSource,
  })
  if (!resolved) return { state: "rejected", reason: "resolve_failed" }

  // Build the sync verifier bound to THIS envelope + the pinned sender key. A successful
  // verification is the moment the delivery becomes durably "seen".
  const didVerifier = new DidVerifier({
    sodium: input.sodium,
    pinnedEd25519Pub: resolved.ed25519Pub,
    pinnedDid: senderDid,
    envelope: opened.envelope,
  })
  const verifier = {
    verify(fromAgentId: string, proof?: string): boolean {
      const ok = didVerifier.verify(fromAgentId, proof)
      if (ok) for (const key of claimed) input.seen.markSeen(key)
      return ok
    },
  }

  // Branch on the unsealed friendsKind → the UNCHANGED importer. fromAgentId is the
  // SIGNED sender DID, so the verifier's binding (proof.signerDid === fromAgentId
  // === pinnedDid) anchors on authentic, signature-covered material.
  const fromAgentId = senderDid
  const importInput = { envelope: opened.envelope as never, fromAgentId, trustOfSource: input.trustOfSource }
  const done = (r: ReceiveShareResult): ReceiveShareResult =>
    r.state === "completed" && binding.bindingId !== undefined ? { ...r, bindingId: binding.bindingId } : r

  if (opened.friendsKind === "profile_share") {
    const r = await importProfileShare(input.store, importInput, { verifier })
    return done(mapImport(r, opened.friendsKind, bound))
  }
  if (opened.friendsKind === "mission_share") {
    const r = await importMissionShare(input.missionStore, importInput, { verifier })
    return done(mapImport(r, opened.friendsKind, bound))
  }
  if (opened.friendsKind === "message") {
    // A message imports nothing: it returns the verified text for the recipient to act on.
    const m = receiveMessage({ envelope: opened.envelope, fromAgentId, trustOfSource: input.trustOfSource }, { verifier })
    if (m.ok) return done({ state: "completed", friendsKind: "message", status: m.status, message: m.message, bound })
    if (m.status === "malformed_message") return { state: "rejected", reason: "malformed_plaintext" }
    // receiveMessage reports both a failed signature and a too-low trust as untrusted_source;
    // tell them apart here so the sender can act on the right one.
    const proof = typeof opened.envelope.proof === "string" ? opened.envelope.proof : undefined
    return { state: "rejected", reason: verifier.verify(fromAgentId, proof) ? "untrusted_source" : "bad_signature" }
  }
  // openSealedEnvelope admits only FRIENDS_KINDS, so the remaining kind is coordination.
  const r = await importCoordination(input.missionStore, importInput, { verifier })
  return done(mapImport(r, opened.friendsKind, bound))
}

/** Map an importer result to the A2A TaskState shape. */
function mapImport(
  r: { ok: boolean; status: string },
  friendsKind: FriendsKind,
  bound: boolean,
): ReceiveShareResult {
  if (r.ok) {
    return { state: "completed", friendsKind, status: r.status, bound }
  }
  // The importer returns `untrusted_source` when the verifier fails (forge) OR the
  // trust cap is too low (stranger) — both map to the A2A `rejected` taxonomy.
  if (r.status === "untrusted_source") {
    return { state: "rejected", reason: "untrusted_source" }
  }
  return { state: "rejected", reason: "import_failed" }
}
