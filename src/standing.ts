// Earned standing — first-party reputation derived from outcomes (brick four).
//
// Where `trust-explanation.ts` explains "how much authority do I grant" (the
// manual gate), `standing.ts` answers "how has this agent actually performed on
// work I personally did with it" — a DERIVED, ADVISORY, first-party-only
// assessment that NEVER writes `trustLevel` and NEVER crosses the wire.
// Standing informs a manual trust decision; it does not make one.
//
// The four firewalls (each preserving the non-transitivity invariant):
//   1. FIRST-PARTY ONLY — `assessStanding` filters outcomes to
//      `provenance?.origin !== "imported"`. A peer's claim about a third agent
//      (imported namespace) never feeds your standing — reputation can't be
//      laundered across a hop.
//   2. NEVER WRITES `trustLevel` — a pure function returning a value; no
//      store-write path; cannot reach `setFriendTrust`.
//   3. NEVER ON THE WIRE — there is no `standing` envelope field, no
//      `kind:"standing_share"`, no way for A to tell B "C is great." The type to
//      express standing on the wire does not exist (the anti-Sybil core).
//   4. ADVISORY, NEVER A GATE — no consent / share / trust path reads standing;
//      the `explainStanding` advisory explicitly frames it as input to a MANUAL
//      trust decision, never an instruction.
//
// Mirrors `trust-explanation.ts`: a pure, store-free read that emits a nerves
// event and returns a value computed on read (persisted nowhere). The tier rule
// is a fixed, transparent ladder behind an injectable `StandingRule` swap point
// (mirroring `DEFAULT_CONSENT_POLICY`), so a future decay rule is a one-line swap.
import type { FriendRecord } from "./types"
import { emitNervesEvent } from "./observability"

/** A peer's earned standing tier — derived from the first-party outcomes you
 * personally recorded with them. Ordered worst→best for reference:
 * `troubled` < `untested` < `mixed` < `reliable` < `proven`. */
export type StandingTier = "proven" | "reliable" | "mixed" | "untested" | "troubled"

/** The tally of first-party outcomes by result (imported outcomes excluded). */
export interface StandingTally {
  success: number
  partial: number
  failed: number
}

/** A derived, advisory assessment of a peer from your first-party outcomes.
 * Computed on read; persisted nowhere; never crosses the wire. */
export interface Standing {
  tier: StandingTier
  /** How many first-party outcomes the tier rests on (imported excluded). */
  basisCount: number
  tally: StandingTally
  /** The peer's familiarity counter (read through from `agentMeta`). */
  familiarity: number
  /** ISO timestamp at which this assessment was computed. */
  assessedAt: string
}

/** A human gloss of a `Standing` plus advisory notes that frame it as input to a
 * MANUAL trust decision — never an instruction to change trust. */
export interface StandingExplanation {
  standing: Standing
  summary: string
  why: string
  /** Advisory notes. ALWAYS includes the guardrail that standing does not change
   * the peer's trust level (the anti-auto-promote firewall). */
  advisory: string[]
}

/** The inputs a tier rule maps to a `StandingTier`: the first-party tally, the
 * basis count, and the peer's familiarity. */
export interface StandingRuleInput {
  tally: StandingTally
  basisCount: number
  familiarity: number
}

/**
 * A pluggable tier rule — the swap point (mirrors `ConsentPolicy`). `tier`
 * deterministically maps `(tally, basisCount, familiarity)` to a `StandingTier`.
 * Inject a custom rule to change the ladder (e.g. add time-decay later) without
 * touching `assessStanding`/`explainStanding`.
 */
export interface StandingRule {
  readonly name: string
  tier(input: StandingRuleInput): StandingTier
}

/**
 * The familiarity floor a peer must reach (alongside ≥3 clean successes) to earn
 * `proven`. Equal to the proven success floor — a peer is only "proven" once you
 * have both enough good outcomes AND enough lived history. Tunable.
 */
export const FAMILIARITY_THRESHOLD = 3

/**
 * ── STANDING-RULE SWAP POINT (the default tier ladder) ──
 * The active tier rule. A fixed, transparent, count-based ladder — NOT ML:
 *   • no basis at all          → `untested`
 *   • failures outnumber wins  → `troubled`
 *   • ≥3 clean wins + familiar  → `proven`
 *   • ≥1 clean win              → `reliable`
 *   • otherwise (mixed signal)  → `mixed`
 * Swap this assignment (or inject a `rule` per-call) to change the ladder; e.g. a
 * later recency/decay rule is an additive swap here, not a rebuild.
 */
export const DEFAULT_STANDING_RULE: StandingRule = {
  name: "count_based",
  tier({ tally, basisCount, familiarity }) {
    if (basisCount === 0) return "untested"
    if (tally.failed > tally.success) return "troubled"
    if (tally.success >= 3 && tally.failed === 0 && familiarity >= FAMILIARITY_THRESHOLD) return "proven"
    if (tally.success >= 1 && tally.failed === 0) return "reliable"
    return "mixed"
  },
}

/**
 * Assess a peer's earned standing from the first-party outcomes you personally
 * recorded with them. Pure + store-free: reads `agentMeta.outcomes`, FILTERS to
 * first-party (firewall 1), tallies by result, reads `familiarity`, and maps via
 * the (injectable) tier rule. Emits `friends.standing_assessed`. Returns a value;
 * never writes trust (firewall 2); never produces a wire artifact (firewall 3).
 */
export function assessStanding(record: FriendRecord, now?: Date, rule?: StandingRule): Standing {
  throw new Error("not implemented")
}

/**
 * Explain a peer's earned standing in words: the tier with a human `summary` +
 * `why`, plus `advisory` notes that explicitly frame standing as input to a
 * MANUAL trust decision (firewall 4 — never an instruction to change trust).
 * Mirrors `describeTrustContext`'s shape.
 */
export function explainStanding(record: FriendRecord, now?: Date, rule?: StandingRule): StandingExplanation {
  throw new Error("not implemented")
}
