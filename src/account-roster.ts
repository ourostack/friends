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
  const { roster, candidateDid, rosterKey, store } = input
  const accountId = roster.accountId

  // 1) Roster-key pin (TOFU). First contact pins the key; an EXISTING pin for a
  // DIFFERENT key HARD-FAILS (no silent re-pin); a matching pin proceeds.
  const existingPin = await store.getPin(accountId)
  if (!existingPin) {
    await store.putPin({ accountId, rosterKey, pinnedAt: new Date().toISOString() })
  } else if (existingPin.rosterKey !== rosterKey) {
    const result: AccountMembershipResult = {
      decision: "roster_key_mismatch",
      reason: "presented roster key does not match the pinned key",
    }
    emit(result.decision, accountId)
    return result
  }

  // 2) Authenticity: the injected verifier (or the identity default) must accept
  // the roster under the pinned/presented key.
  const verifier = input.verifier ?? DEFAULT_ROSTER_VERIFIER
  if (!verifier.verify(roster, rosterKey)) {
    const result: AccountMembershipResult = { decision: "unverified", reason: "roster signature did not verify" }
    emit(result.decision, accountId)
    return result
  }

  // 3) Membership: the candidate's did must be in the verified roster.
  const isMember = roster.members.some((m) => m.did === candidateDid)
  const result: AccountMembershipResult = isMember
    ? { decision: "family_same_account" }
    : { decision: "not_member", reason: "candidate did is not in the roster" }
  emit(result.decision, accountId)
  return result
}

/** Emit the membership-evaluated nerves event. */
function emit(decision: AccountMembershipDecision, accountId: string): void {
  emitNervesEvent({
    component: "friends",
    event: "friends.account_membership_evaluated",
    message: "evaluated account-roster membership",
    meta: { accountId, decision },
  })
}
