import { describe, expect, it } from "vitest"

import { checkPinnedDelegationGrant } from "../index"

const DID = "did:key:z6MkSender"
const NOW = new Date("2026-10-09T12:00:00.000Z")
const base = { scope: "principal_commands", did: DID, grantedAt: "2026-10-01T00:00:00.000Z", source: "operator cli" }

describe("checkPinnedDelegationGrant", () => {
  it("accepts a well-formed grant for the matching DID", () => {
    expect(checkPinnedDelegationGrant(base, { did: DID, now: NOW })).toEqual({ ok: true })
  })

  it("accepts a grant that has not yet expired, and accepts now as epoch ms", () => {
    const g = { ...base, expiresAt: "2026-10-10T00:00:00.000Z" }
    expect(checkPinnedDelegationGrant(g, { did: DID, now: NOW })).toEqual({ ok: true })
    expect(checkPinnedDelegationGrant(g, { did: DID, now: NOW.getTime() })).toEqual({ ok: true })
  })

  it("refuses a different signer DID", () => {
    expect(checkPinnedDelegationGrant(base, { did: "did:key:other", now: NOW })).toEqual({ ok: false, reason: "did_mismatch" })
  })

  it("refuses an expired grant, including at the exact expiry instant", () => {
    const g = { ...base, expiresAt: "2026-10-09T12:00:00.000Z" }
    expect(checkPinnedDelegationGrant(g, { did: DID, now: NOW })).toEqual({ ok: false, reason: "expired" })
    expect(checkPinnedDelegationGrant({ ...base, expiresAt: "2026-10-01T00:00:00.000Z" }, { did: DID, now: NOW })).toEqual({ ok: false, reason: "expired" })
  })

  it("treats a non-finite expiresAt as expired", () => {
    expect(checkPinnedDelegationGrant({ ...base, expiresAt: "never" }, { did: DID, now: NOW })).toEqual({ ok: false, reason: "expired" })
  })

  it("refuses a grant when now is not a finite time (fails closed)", () => {
    expect(checkPinnedDelegationGrant({ ...base, expiresAt: "2099-01-01T00:00:00.000Z" }, { did: DID, now: Number.NaN })).toEqual({ ok: false, reason: "expired" })
  })

  it.each([
    ["null", null],
    ["array", []],
    ["string", "grant"],
    ["extra key", { ...base, extra: 1 }],
    ["missing source", { scope: "principal_commands", did: DID, grantedAt: base.grantedAt }],
    ["wrong scope", { ...base, scope: "admin" }],
    ["blank did", { ...base, did: "" }],
    ["bad grantedAt", { ...base, grantedAt: "yesterday" }],
    ["blank source", { ...base, source: "  " }],
    ["non-string expiresAt", { ...base, expiresAt: 5 }],
  ])("refuses a malformed grant: %s", (_name, grant) => {
    expect(checkPinnedDelegationGrant(grant, { did: DID, now: NOW })).toEqual({ ok: false, reason: "malformed" })
  })
})
