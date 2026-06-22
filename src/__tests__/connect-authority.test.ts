// authorizeConnect — the management-sense authority predicate (brick 8, greenfield).
//
// A PURE predicate that decides whether a `connect_to` may COMMIT inline or must
// DOWNGRADE to a confirm-prompt. It consumes a pre-computed `AccountMembershipResult`
// (the caller runs evaluateAccountMembership against the increment-1 roster surface
// and passes the result in) — so this module imports NO a2a-client / libsodium and
// stays core-clean. The contract (every branch):
//   - local                                  → commit
//   - closed + membership family_same_account → commit
//   - closed + any other / absent membership  → downgrade (closed_sense_not_member) — NEVER a blanket allow
//   - open (a2a/mail/bluebubbles)             → downgrade (open_sense_needs_confirmation) — regardless of membership
//   - internal                               → downgrade (internal_sense_not_management)
// A downgrade is always a structured RETURN value, never a throw.
import { describe, it, expect, afterEach } from "vitest"

import { authorizeConnect } from "../connect-authority"
import type { ConnectAuthorization } from "../connect-authority"
import { setNervesEmitter } from "../observability"
import type { NervesEvent } from "../observability"
import type { AccountMembershipResult, AccountMembershipDecision } from "../account-roster"

function membership(decision: AccountMembershipDecision): AccountMembershipResult {
  return { decision }
}

describe("authorizeConnect — the management-sense authority predicate", () => {
  afterEach(() => setNervesEmitter(null))

  it("local sense → commit", () => {
    const result = authorizeConnect({ senseType: "local" })
    expect(result).toEqual<ConnectAuthorization>({ decision: "commit" })
  })

  it("closed sense WITH family_same_account membership → commit", () => {
    const result = authorizeConnect({ senseType: "closed", membership: membership("family_same_account") })
    expect(result).toEqual<ConnectAuthorization>({ decision: "commit" })
  })

  it("closed sense WITHOUT a family-granting membership (not_member) → downgrade closed_sense_not_member (never a blanket allow)", () => {
    const result = authorizeConnect({ senseType: "closed", membership: membership("not_member") })
    expect(result).toEqual<ConnectAuthorization>({ decision: "downgrade", reason: "closed_sense_not_member" })
  })

  it("closed sense WITH an unverified membership → downgrade closed_sense_not_member", () => {
    const result = authorizeConnect({ senseType: "closed", membership: membership("unverified") })
    expect(result).toEqual<ConnectAuthorization>({ decision: "downgrade", reason: "closed_sense_not_member" })
  })

  it("closed sense WITH a roster_key_mismatch membership → downgrade closed_sense_not_member", () => {
    const result = authorizeConnect({ senseType: "closed", membership: membership("roster_key_mismatch") })
    expect(result).toEqual<ConnectAuthorization>({ decision: "downgrade", reason: "closed_sense_not_member" })
  })

  it("closed sense with membership ABSENT → downgrade closed_sense_not_member (no membership ⇒ no commit)", () => {
    const result = authorizeConnect({ senseType: "closed" })
    expect(result).toEqual<ConnectAuthorization>({ decision: "downgrade", reason: "closed_sense_not_member" })
  })

  it("open sense → downgrade open_sense_needs_confirmation (an open sense never commits inline)", () => {
    const result = authorizeConnect({ senseType: "open" })
    expect(result).toEqual<ConnectAuthorization>({ decision: "downgrade", reason: "open_sense_needs_confirmation" })
  })

  it("open sense WITH a family_same_account membership STILL downgrades (membership cannot rescue an open sense)", () => {
    const result = authorizeConnect({ senseType: "open", membership: membership("family_same_account") })
    expect(result).toEqual<ConnectAuthorization>({ decision: "downgrade", reason: "open_sense_needs_confirmation" })
  })

  it("internal sense → downgrade internal_sense_not_management", () => {
    const result = authorizeConnect({ senseType: "internal" })
    expect(result).toEqual<ConnectAuthorization>({ decision: "downgrade", reason: "internal_sense_not_management" })
  })

  it("internal sense WITH a family_same_account membership STILL downgrades (internal is never a management sense)", () => {
    const result = authorizeConnect({ senseType: "internal", membership: membership("family_same_account") })
    expect(result).toEqual<ConnectAuthorization>({ decision: "downgrade", reason: "internal_sense_not_management" })
  })

  it("never throws on any sense (the downgrade is a structured RETURN, not an exception)", () => {
    expect(() => authorizeConnect({ senseType: "open" })).not.toThrow()
    expect(() => authorizeConnect({ senseType: "internal" })).not.toThrow()
    expect(() => authorizeConnect({ senseType: "closed" })).not.toThrow()
  })

  it("emits a nerves event carrying the decision on each call (the house observability pattern)", () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    authorizeConnect({ senseType: "local" })
    authorizeConnect({ senseType: "open" })
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.every((e) => e.component === "friends")).toBe(true)
    // the decision is observable in the event meta
    const decisions = seen.map((e) => e.meta?.decision)
    expect(decisions).toContain("commit")
    expect(decisions).toContain("downgrade")
  })
})
