// evaluateAccountMembership — the Increment-1 payoff (Item 3). Grants `family` via
// TrustBasis "same_account" ONLY to a peer whose `did` is in the pinned roster AND
// whose roster verifies under the TOFU-pinned roster key. A changed roster key
// HARD-FAILS (no silent re-pin).
//
// CORE module: it uses the INJECTED RosterVerifier + RosterStore seams and does NO
// direct crypto (no a2a-client / libsodium import) — the Ed25519 verifier is
// injected by the host/test. The lint enforces the dependency direction.
import { emitNervesEvent } from "./observability"
import type { AccountRoster, RosterStore } from "./roster-store"
import type { RosterVerifier } from "./roster-verifier"
import { DEFAULT_ROSTER_VERIFIER } from "./roster-verifier"

export type AccountMembershipDecision =
  | "family_same_account"
  | "not_member"
  | "unverified"
  | "roster_key_mismatch"

export interface EvaluateAccountMembershipInput {
  roster: AccountRoster
  candidateDid: string
  rosterKey: string
  store: RosterStore
  verifier?: RosterVerifier
}

export interface AccountMembershipResult {
  decision: AccountMembershipDecision
  reason?: string
}

/** Decide whether `candidateDid` is family-via-same-account under `roster`.
 * TOFU-pins the roster key on first contact; a changed key hard-fails;
 * verify-then-membership gates the `family_same_account` grant. (Unit 8a stub —
 * not implemented.) */
export async function evaluateAccountMembership(
  input: EvaluateAccountMembershipInput,
): Promise<AccountMembershipResult> {
  // RED stub: always not_member so the family/unverified/mismatch/pin assertions
  // fail behaviorally. Implemented GREEN in Unit 8b. References keep the imports
  // wired for the real body.
  void input.store
  void DEFAULT_ROSTER_VERIFIER
  void emitNervesEvent
  return { decision: "not_member" }
}
