// authorizeConnect — the management-sense authority predicate (brick 8, greenfield).
//
// The control-plane gate for `connect_to`: a PURE function that decides whether the
// owner introducing one of their own agents into the calling agent's fleet may
// COMMIT inline, or must DOWNGRADE to a confirm-prompt. Brick 8 is genuinely
// greenfield in friends — there is NO trust-gate.ts / handleStranger to patch (those
// live in ouroboros); this predicate is the management-sense authority from scratch.
//
// CORE-CLEAN by construction: the `closed`-branch membership decision arrives
// PRE-COMPUTED via the injected seam. The CALLER runs evaluateAccountMembership
// against the increment-1 roster surface and passes the `AccountMembershipResult` in;
// this module never calls it, so it imports NO a2a-client / libsodium (the lint
// enforces the direction). It is a pure value→value map with one observability emit.
//
// The contract (every branch — see connect-authority.test.ts):
//   - local                                  → commit  (owner-only stdio/CLI — the management sense)
//   - closed + membership family_same_account → commit  (org-gated AND a roster-verified same-account peer)
//   - closed + any other / absent membership  → downgrade closed_sense_not_member  (NEVER a blanket allow)
//   - open (a2a/mail/bluebubbles)             → downgrade open_sense_needs_confirmation  (regardless of membership)
//   - internal                               → downgrade internal_sense_not_management
// A downgrade is ALWAYS a structured RETURN value, never a throw — the caller turns it
// into a confirm-prompt and writes no audit / makes no link.
import { emitNervesEvent } from "./observability"
import type { SenseType } from "./types"
import type { AccountMembershipResult } from "./account-roster"

/** Input to the management-sense authority predicate. `senseType` is the sense the
 * `connect_to` arrived through (the MCP boundary supplies `local` for the owner-only
 * stdio path; a network transport passes its real senseType). `membership` is the
 * PRE-COMPUTED account-roster decision for the `closed` branch — the caller runs
 * evaluateAccountMembership and passes its result; absent ⇒ no membership proven. */
export interface AuthorizeConnectInput {
  senseType: SenseType
  membership?: AccountMembershipResult
}

/** The authority decision (PINNED discriminated union). `commit` ⇒ the `connect_to`
 * may link inline + audit. `downgrade` ⇒ it must NOT commit; the caller raises a
 * confirm-prompt instead. The `reason` names exactly why the inline commit was
 * withheld, so the prompt copy + the audit/no-audit branch are unambiguous. */
export type ConnectAuthorization =
  | { decision: "commit" }
  | {
      decision: "downgrade"
      reason: "open_sense_needs_confirmation" | "closed_sense_not_member" | "internal_sense_not_management"
    }

/** Decide whether a `connect_to` may COMMIT inline from the given management sense.
 *
 * `local` is the owner-only management sense (stdio/CLI — the user who launched the
 * process). `closed` is org-gated but NOT inherently the owner, so it commits ONLY
 * when the peer is proven same-account family via the signed roster (the caller's
 * pre-computed `membership`); any other decision — or no membership at all — downgrades
 * (NEVER a blanket allow on `closed`). An `open` sense (anyone can reach it) never
 * commits inline regardless of membership. `internal` is the agent's inner dialog —
 * not a management surface at all. Every non-commit is a structured downgrade RETURN.
 *
 * ┌─ PRE-CONDITION before any non-local / networked `controlContext` is ever wired ──────┐
 * │ (security review inc-2 findings 2-3): this gate authenticates the CALLER's           │
 * │ sense/membership but places NO constraint on the TARGET, and connectAgents defaults  │
 * │ the introduce trust to `family`. Both are correct + safe ONLY because the path is     │
 * │ owner-only stdio today (every wire supplies `senseType: "local"`; no wire constructs  │
 * │ a non-`local` controlContext). The `connect` commit MUST add target-side roster      │
 * │ verification (the target did must ALSO be roster-checked, not just TOFU-upserted)     │
 * │ AND validate the caller-supplied `trustLevel` against the authority decision BEFORE   │
 * │ any non-`local`/networked controlContext is wired. The current `family` default +     │
 * │ unconstrained target are safe only for the owner-only-stdio path.                     │
 * └──────────────────────────────────────────────────────────────────────────────────────┘ */
export function authorizeConnect(input: AuthorizeConnectInput): ConnectAuthorization {
  const result = decide(input)
  emitNervesEvent({
    component: "friends",
    event: "friends.connect_authorized",
    message: "evaluated connect_to management-sense authority",
    meta: {
      senseType: input.senseType,
      decision: result.decision,
      ...(result.decision === "downgrade" ? { reason: result.reason } : {}),
    },
  })
  return result
}

/** The pure decision, factored out so the single observability emit wraps every
 * branch (the one return path keeps the emit DRY and fully covered). */
function decide(input: AuthorizeConnectInput): ConnectAuthorization {
  switch (input.senseType) {
    case "local":
      // Owner-only management sense — the user who launched the process. Commit.
      return { decision: "commit" }
    case "closed":
      // Org-gated but not inherently the owner: commit ONLY for a roster-verified
      // same-account peer. Anything else (incl. absent membership) downgrades — there
      // is NO blanket allow on `closed`.
      return input.membership?.decision === "family_same_account"
        ? { decision: "commit" }
        : { decision: "downgrade", reason: "closed_sense_not_member" }
    case "open":
      // Anyone can reach an open sense — it can NEVER commit a control-plane link
      // inline, regardless of any membership claim.
      return { decision: "downgrade", reason: "open_sense_needs_confirmation" }
    case "internal":
      // The agent's inner dialog — not a management surface.
      return { decision: "downgrade", reason: "internal_sense_not_management" }
  }
}
