// Roster store abstraction (p11 Item 3 — the account roster).
//
// The pinned account roster + its TOFU roster-key pin persist through RosterStore —
// a sibling to GrantStore/MissionStore, mirroring their shape. The core stays
// storage-agnostic; backends stay pluggable. No roster module imports `fs` directly
// except the FileRosterStore adapter. This file is a PURE INTERFACE (no logic) and
// is coverage-excluded in vitest.config.ts, mirroring src/store.ts.

/** The signed account roster as it lives on the wire / on disk. `members` lists the
 * owner's agents by `{ handle, did }`; `epoch` is the monotonic roster version; the
 * Ed25519 `sig` is over `jcsBytes({ accountId, members, epoch })` (the roster minus
 * `sig`), exactly how `verifyEnvelopeSignature` signs the proof-stripped envelope. */
export interface AccountRoster {
  accountId: string
  members: { handle: string; did: string }[]
  epoch: number
  sig: string
}

/** The TOFU-pinned roster signing key for an account (first-contact pin; a changed
 * key HARD-FAILS rather than silently re-pinning). `rosterKey` is the base64
 * Ed25519 public key the roster `sig` must verify under. */
export interface RosterPin {
  accountId: string
  rosterKey: string
  pinnedAt: string
}

/** Domain-specific store for the account roster + its pinned signing key. One
 * roster and one pin per accountId. */
export interface RosterStore {
  getRoster(accountId: string): Promise<AccountRoster | null>
  putRoster(roster: AccountRoster): Promise<void>
  getPin(accountId: string): Promise<RosterPin | null>
  putPin(pin: RosterPin): Promise<void>
}
