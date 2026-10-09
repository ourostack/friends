// envelope-binding — the recipient/kind/id/time checks on an opened envelope (R2).
//
// `sealEnvelope` stamps a reserved, SIGNED `binding: { to, kind, id }` into every
// envelope before signing, so a signed envelope is cryptographically tied to ONE
// recipient, ONE friends kind and ONE message id. Without it, a recipient who opens
// a signed message could re-seal the same signed bytes to a third party. This module
// is the receive-side check; `receiveShare` and any hand-rolled receive path call it.
import type { FriendsKind, OpenSealedEnvelopeResult } from "./sealed-envelope"

/** The reserved signed field `sealEnvelope` stamps into every envelope. */
export interface EnvelopeBinding {
  /** The recipient DID the sender sealed this envelope to. */
  to: string
  /** The friends kind the sender sealed this envelope as. */
  kind: FriendsKind
  /** 128 random bits, base64url (22 chars): the per-message id used for replay dedup. */
  id: string
}

export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_DELEGATED_MAX_AGE_MS = 10 * 60 * 1000
export const DEFAULT_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000

/** Matches 16 random bytes in unpadded base64url. */
const BINDING_ID = /^[A-Za-z0-9_-]{22}$/

/** The minimal duck type of a seen-ledger (same shape as `SeenLedgerLike`). */
export interface BindingSeenLedger {
  isSeen(key: string): boolean
  markSeen(key: string): void
}

export interface EnvelopeBindingOptions {
  /** Clock override (Date or epoch ms). Defaults to the current time. */
  now?: Date | number
  /** Refuse envelopes with no `binding` (default false: accept them with `bound: false`). */
  rejectUnboundEnvelopes?: boolean
  /** Max envelope age for any kind. Default 7 days. */
  maxAgeMs?: number
  /** Max envelope age when the envelope carries `onBehalfOf`. Default 10 minutes. */
  delegatedMaxAgeMs?: number
  /** Max time an envelope's `issuedAt` may be ahead of the clock. Default 2 minutes. */
  maxFutureSkewMs?: number
}

/** ISO-8601 date-time with an explicit zone (Z or an offset). Anything else (RFC 2822,
 * zone-less, date-only) is refused, so `Date.parse` quirks cannot move `issuedAt`. */
const ISO_WITH_ZONE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/

export interface CheckEnvelopeBindingInput extends EnvelopeBindingOptions {
  recipientDid: string
  /** The ledger the `mid:<senderDid>:<id>` key is CHECKED against (never marked here). */
  seen: BindingSeenLedger
}

export type EnvelopeBindingRejection =
  | "malformed_binding"
  | "signed_recipient_mismatch"
  | "signed_kind_mismatch"
  | "stale_envelope"
  | "stale_delegation"
  | "unbound_delegation"
  | "unbound_envelope"
  | "replayed"

export type EnvelopeBindingResult =
  /** `bindingId` and `seenKey` are present only when `bound`. `seenKey` is the
   * `mid:<senderDid>:<id>` ledger key: this function only CHECKS it, so the caller
   * marks it durably once the signature has verified. */
  | { ok: true; bound: boolean; bindingId?: string; seenKey?: string }
  | { ok: false; reason: EnvelopeBindingRejection }

type OpenedEnvelope = Extract<OpenSealedEnvelopeResult, { ok: true }>

/** Throws a TypeError unless every supplied time option is finite (and every window is
 * non-negative). An invalid option must never turn the freshness check into a pass. */
export function assertValidBindingOptions(options: EnvelopeBindingOptions): void {
  if (options.now !== undefined) {
    const ms = typeof options.now === "number" ? options.now : options.now instanceof Date ? options.now.getTime() : Number.NaN
    if (!Number.isFinite(ms)) throw new TypeError("envelope binding: `now` must be a finite time")
  }
  for (const name of ["maxAgeMs", "delegatedMaxAgeMs", "maxFutureSkewMs"] as const) {
    const value = options[name]
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      throw new TypeError(`envelope binding: \`${name}\` must be a finite, non-negative number`)
    }
  }
}

/** Check an opened envelope's binding and freshness. SYNCHRONOUS and side-effect free:
 * it CHECKS `mid:<senderDid>:<binding.id>` against `seen` but does not mark it. The
 * caller claims it in memory before its first `await` and marks `seenKey` durably only
 * after the signature verifies. It does not verify the signature itself. Throws a
 * TypeError on invalid options (non-finite `now` or windows, negative windows). */
export function checkEnvelopeBinding(opened: OpenedEnvelope, input: CheckEnvelopeBindingInput): EnvelopeBindingResult {
  assertValidBindingOptions(input)
  const envelope = opened.envelope
  const delegated = envelope.onBehalfOf !== undefined
  const binding = envelope.binding

  if (binding === undefined) {
    if (delegated) return { ok: false, reason: "unbound_delegation" }
    if (input.rejectUnboundEnvelopes === true) return { ok: false, reason: "unbound_envelope" }
    const fresh = checkFreshness(envelope, delegated, input)
    return fresh ?? { ok: true, bound: false }
  }

  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return { ok: false, reason: "malformed_binding" }
  const b = binding as Record<string, unknown>
  const keys = Object.keys(b).sort().join(",")
  if (keys !== "id,kind,to") return { ok: false, reason: "malformed_binding" }
  if (typeof b.to !== "string" || typeof b.kind !== "string" || typeof b.id !== "string" || !BINDING_ID.test(b.id)) {
    return { ok: false, reason: "malformed_binding" }
  }
  if (b.to !== input.recipientDid) return { ok: false, reason: "signed_recipient_mismatch" }
  if (b.kind !== opened.friendsKind) return { ok: false, reason: "signed_kind_mismatch" }

  const stale = checkFreshness(envelope, delegated, input)
  if (stale) return stale

  const key = `mid:${opened.fromAgentId}:${b.id}`
  if (input.seen.isSeen(key)) return { ok: false, reason: "replayed" }
  return { ok: true, bound: true, bindingId: b.id, seenKey: key }
}

function checkFreshness(
  envelope: Record<string, unknown>,
  delegated: boolean,
  input: CheckEnvelopeBindingInput,
): { ok: false; reason: "stale_envelope" | "stale_delegation" } | null {
  const reason = delegated ? "stale_delegation" : "stale_envelope"
  const issuedAt = typeof envelope.issuedAt === "string" && ISO_WITH_ZONE.test(envelope.issuedAt) ? Date.parse(envelope.issuedAt) : Number.NaN
  if (!Number.isFinite(issuedAt)) return { ok: false, reason }
  const now = input.now === undefined ? Date.now() : typeof input.now === "number" ? input.now : input.now.getTime()
  const maxAge = delegated ? (input.delegatedMaxAgeMs ?? DEFAULT_DELEGATED_MAX_AGE_MS) : (input.maxAgeMs ?? DEFAULT_MAX_AGE_MS)
  const maxFuture = input.maxFutureSkewMs ?? DEFAULT_MAX_FUTURE_SKEW_MS
  if (now - issuedAt > maxAge || issuedAt - now > maxFuture) return { ok: false, reason }
  return null
}
