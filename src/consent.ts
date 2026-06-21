// Consent policies — Fork A, all three postures behind one swap.
//
// A ConsentPolicy answers one question: may scope <scope> of subject
// <subjectKey> be shared with recipient agent <recipient>? The three
// postures share the same machinery (an explicit-grant lookup + the recipient's
// trust level) and differ only in the rule they apply, so the operator's choice
// of posture is a ONE-LINE default swap (see DEFAULT_CONSENT_POLICY below), not a
// rebuild.
//
// ── CONSENT-POLICY SWAP POINT ──
// `DEFAULT_CONSENT_POLICY` (bottom of this file) is the single injectable config
// point. To change the product's privacy posture, point it at `strictPolicy`,
// `trustImpliedPolicy`, or `tieredPolicy`. `prepareProfileShare` falls back to it
// when no policy is passed; pass an explicit `consent` to override per-call.
import type { GrantStore } from "./grant-store"
import type { ShareScope, TrustLevel } from "./types"
import { IDENTITY_SCOPES } from "./types"
import { isGrantEffective } from "./grants"

/** The recipient of a share, as the consent layer sees it: its join-key agentId
 * and its resolved trust level on this graph (the authorization input). */
export interface ConsentRecipient {
  agentId: string
  trustLevel: TrustLevel
}

export interface ConsentDecisionInput {
  /** The subject whose data may be shared — a friend UUID for a profile share, a
   * missionKey for a mission share (Fork D: opaque subject key). */
  subjectKey: string
  recipient: ConsentRecipient
  scope: ShareScope
  grants: GrantStore
  now?: Date
}

/** A pluggable consent posture. `consents` resolves true iff the share is
 * permitted under this posture. */
export interface ConsentPolicy {
  readonly name: string
  consents(input: ConsentDecisionInput): Promise<boolean>
}

const TRUST_RANK: Record<TrustLevel, number> = { family: 4, friend: 3, acquaintance: 2, stranger: 1 }

/** True when `level` is at least `friend` (the "trusted" floor). */
function isAtLeastFriend(level: TrustLevel): boolean {
  return TRUST_RANK[level] >= TRUST_RANK.friend
}

/** Whether an effective, non-revoked, non-expired grant covers exactly
 * (subject, recipient, scope). The shared machinery all three policies build on. */
async function hasEffectiveGrant(input: ConsentDecisionInput): Promise<boolean> {
  const now = input.now ?? new Date()
  const all = await input.grants.listAll()
  return all.some(
    (g) =>
      g.subjectKey === input.subjectKey &&
      g.recipientAgentId === input.recipient.agentId &&
      g.scope === input.scope &&
      isGrantEffective(g, now),
  )
}

// ── A1: strict ──
// Consented ONLY if a non-revoked, non-expired explicit grant covers
// (subject, recipient, scope). Safest; trust alone never implies a share.
export const strictPolicy: ConsentPolicy = {
  name: "strict",
  async consents(input) {
    return hasEffectiveGrant(input)
  },
}

// ── A2: trust-implied ──
// Consented if an explicit grant covers it, OR the recipient's trust ≥ friend
// (any scope). Fast; can surprise on privacy because trust unlocks note content.
export const trustImpliedPolicy: ConsentPolicy = {
  name: "trust_implied",
  async consents(input) {
    if (isAtLeastFriend(input.recipient.trustLevel)) return true
    return hasEffectiveGrant(input)
  },
}

// ── A3: tiered (the recommended default) ──
// Identity-scope shares (the join key only — "name"/"identity") are consented if
// the recipient's trust ≥ friend; but any note-content scope (`notes:*`,
// `outcomes`) ALWAYS requires an explicit grant. Trust agrees on WHO; content
// still requires consent.
export const tieredPolicy: ConsentPolicy = {
  name: "tiered",
  async consents(input) {
    if (IDENTITY_SCOPES.has(input.scope)) {
      return isAtLeastFriend(input.recipient.trustLevel)
    }
    return hasEffectiveGrant(input)
  },
}

/**
 * ── CONSENT-POLICY SWAP POINT (the operator's one-line default) ──
 * The active consent posture. Swap this assignment to `strictPolicy` or
 * `trustImpliedPolicy` to change the product's privacy posture; `tieredPolicy`
 * is the recommended default (identity via trust, note content via explicit
 * grant). `prepareProfileShare` uses this when no `consent` policy is injected.
 */
export const DEFAULT_CONSENT_POLICY: ConsentPolicy = tieredPolicy
