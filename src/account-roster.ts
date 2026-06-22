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

/** SECURITY (finding 2, HIGH): an opaque "the caller has verified this peer controls
 * this did" token. `evaluateAccountMembership` grants family ONLY for a value of this
 * type, and the ONLY way to produce one is `verifiedCandidate(did)` — so the
 * candidate-DID precondition is impossible to forget at a call site (a bare string
 * does not type-check). The private brand makes it unforgeable from a plain object. */
export interface VerifiedCandidate {
  readonly did: string
  /** Private brand — prevents `{ did }` from structurally satisfying the type. */
  readonly [VERIFIED_BRAND]: true
}

declare const VERIFIED_BRAND: unique symbol

/** Mint a {@link VerifiedCandidate}. CALLING THIS IS AN ASSERTION: the caller has
 * already proven (via a DID/pinned-key handshake — e.g. the a2a-client sealed-envelope
 * gate that runs `DidVerifier` before this) that the peer controls `did`. Never call
 * it on an attacker-supplied did that has not been authenticated. */
export function verifiedCandidate(did: string): VerifiedCandidate {
  return { did } as VerifiedCandidate
}

export interface EvaluateAccountMembershipInput {
  roster: AccountRoster
  /** SECURITY (finding 2): the verified candidate — only mintable via
   * `verifiedCandidate(did)` after the caller has authenticated the peer's control of
   * the did. The roster membership + sig checks are NOT a proof of did-control on
   * their own; this token supplies that missing precondition. */
  candidate: VerifiedCandidate
  rosterKey: string
  store: RosterStore
  verifier?: RosterVerifier
}

export interface AccountMembershipResult {
  decision: AccountMembershipDecision
  reason?: string
}

/** One-time loud-warning latch: we warn at most once per process when a family grant
 * is refused purely because the active verifier is not cryptographic (finding 1). */
let warnedNonCryptographicVerifier = false

/** Test seam: reset the one-time-warning latch so a test can assert the loud warning
 * fires (and de-dupes) deterministically, independent of test order. */
export function _resetRosterVerifierWarningForTest(): void {
  warnedNonCryptographicVerifier = false
}

/** Decide whether the VERIFIED `candidate` is family-via-same-account under `roster`.
 *
 * Preconditions (all enforced, not merely documented):
 *  - The caller has authenticated that the peer controls `candidate.did` (carried by
 *    the unforgeable {@link VerifiedCandidate} — finding 2). Membership + sig are NOT
 *    a substitute for did-control.
 *  - A real cryptographic `verifier` (`grantsFamily: true`) is injected. The
 *    identity-only default fails closed: it can verify identity for non-grant checks
 *    but can NEVER produce a `family_same_account` grant (finding 1).
 *
 * Flow: TOFU-pin the roster key on first contact; a changed key hard-fails; the
 * verifier must accept the roster; the verifier must be family-granting; the
 * candidate's did must be in the roster. Any miss yields a non-family decision. */
export async function evaluateAccountMembership(
  input: EvaluateAccountMembershipInput,
): Promise<AccountMembershipResult> {
  const { roster, candidate, rosterKey, store } = input
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

  // 2b) SECURITY (finding 1, HIGH): FAIL CLOSED on the family-granting path. The
  // identity-only default accepts any well-formed roster (it ignores the sig), so it
  // MUST NOT be allowed to grant family — only a real cryptographic verifier
  // (`grantsFamily: true`) can. Without one, the strongest tier is unreachable: a
  // would-be member is `unverified`, never `family_same_account`. Warn LOUDLY once.
  if (verifier.grantsFamily !== true) {
    if (!warnedNonCryptographicVerifier) {
      warnedNonCryptographicVerifier = true
      emitNervesEvent({
        level: "warn",
        component: "friends",
        event: "friends.roster_verifier_not_cryptographic",
        message:
          "REFUSING to grant family_same_account: no cryptographic RosterVerifier injected (the identity-only default cannot back a family grant). Inject ed25519RosterVerifier to enable same-account family.",
        meta: { accountId },
      })
    }
    const result: AccountMembershipResult = {
      decision: "unverified",
      reason: "no cryptographic roster verifier injected — family grant withheld (fail-closed)",
    }
    emit(result.decision, accountId)
    return result
  }

  // 3) Membership: the candidate's did must be in the verified roster.
  const isMember = roster.members.some((m) => m.did === candidate.did)
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
