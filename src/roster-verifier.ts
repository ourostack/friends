// RosterVerifier — the pluggable account-roster authentication seam (Q1; mirrors
// AgentVerifier exactly). The core declares the INTERFACE + an identity-only
// default that does NO crypto; the a2a-client side provides the real Ed25519
// implementation (`ed25519RosterVerifier`), which the host injects — the same split
// that keeps `DidVerifier` out of the core. THIS MODULE MUST NOT import
// src/a2a-client/ or libsodium (the no-restricted-imports lint enforces it).
//
// The canonical-bytes contract both sides agree on: the roster `sig` is an Ed25519
// detached signature over `jcsBytes({ accountId, members, epoch })` — the roster
// MINUS its `sig` field — exactly how `verifyEnvelopeSignature` signs the
// proof-stripped envelope. The identity default ignores the sig (TOFU-equivalent);
// the crypto impl checks it.
import { emitNervesEvent } from "./observability"
import type { AccountRoster } from "./roster-store"

export interface RosterVerifier {
  /** Whether `roster` is authentic under the pinned `rosterKey`. The identity-only
   * default returns true for any well-formed roster (ignores the sig); an Ed25519
   * impl verifies the detached sig over the canonical roster bytes. */
  verify(roster: AccountRoster, rosterKey: string): boolean

  /** SECURITY (finding 1, HIGH): whether this verifier is strong enough to back a
   * FAMILY grant. The identity-only default ignores the sig, so it MUST NOT grant
   * family — only a real cryptographic verifier (the a2a-client `ed25519RosterVerifier`)
   * sets this true. `evaluateAccountMembership` fails closed (→ `unverified`, never
   * `family_same_account`) when the active verifier is not family-granting. Optional
   * + defaulting-to-false so a custom verifier is non-granting unless it opts in. */
  grantsFamily?: boolean
}

/** A roster is well-formed when it has the structural shape the membership check
 * relies on: a string accountId, an array of `{handle, did}` members, a numeric
 * epoch, and a string sig. (The identity verifier accepts any well-formed roster
 * without checking the sig — TOFU-equivalent, mirroring `tofuVerifier`.) */
function isWellFormedRoster(roster: AccountRoster): boolean {
  return (
    typeof roster.accountId === "string" &&
    Array.isArray(roster.members) &&
    roster.members.every((m) => typeof m.handle === "string" && typeof m.did === "string") &&
    typeof roster.epoch === "number" &&
    typeof roster.sig === "string"
  )
}

/** Identity-only roster verifier: accept any well-formed roster, ignore the sig.
 * The day-one default for NON-GRANT identity checks; it deliberately omits
 * `grantsFamily` (defaults to false) so the family-granting path
 * (`evaluateAccountMembership`) fails closed under it — a garbage-signed roster can
 * never yield a family grant without a real cryptographic verifier injected. Mirrors
 * `tofuVerifier`. */
export const identityRosterVerifier: RosterVerifier = {
  verify(roster: AccountRoster): boolean {
    const ok = isWellFormedRoster(roster)
    emitNervesEvent({
      component: "friends",
      event: "friends.roster_verified",
      message: "verified account roster (tofu)",
      meta: { accountId: roster.accountId, epoch: roster.epoch, ok },
    })
    return ok
  },
}

/** The default verifier used when no crypto verifier is injected. */
export const DEFAULT_ROSTER_VERIFIER: RosterVerifier = identityRosterVerifier
