import { describe, it, expect } from "vitest"

import { TRUSTED_LEVELS, IDENTITY_SCOPES, isTrustedLevel, isIdentityProvider, isIntegration, isShareScope } from "../index"
import type { ShareScope } from "../index"

describe("TRUSTED_LEVELS / isTrustedLevel", () => {
  it("TRUSTED_LEVELS is exactly {family, friend}", () => {
    expect(Array.from(TRUSTED_LEVELS).sort()).toEqual(["family", "friend"])
  })
  it("family and friend are trusted", () => {
    expect(isTrustedLevel("family")).toBe(true)
    expect(isTrustedLevel("friend")).toBe(true)
  })
  it("acquaintance and stranger are not trusted", () => {
    expect(isTrustedLevel("acquaintance")).toBe(false)
    expect(isTrustedLevel("stranger")).toBe(false)
  })
  it("a missing trust level defaults to trusted (legacy 'friend')", () => {
    expect(isTrustedLevel(undefined)).toBe(true)
  })
})

describe("isIdentityProvider", () => {
  it("accepts every known provider", () => {
    for (const p of ["aad", "local", "teams-conversation", "imessage-handle", "email-address", "a2a-agent"]) {
      expect(isIdentityProvider(p)).toBe(true)
    }
  })
  it("rejects unknown strings and non-strings", () => {
    expect(isIdentityProvider("slack")).toBe(false)
    expect(isIdentityProvider(42)).toBe(false)
    expect(isIdentityProvider(null)).toBe(false)
    expect(isIdentityProvider(undefined)).toBe(false)
  })
})

describe("isIntegration", () => {
  it("accepts known integrations", () => {
    expect(isIntegration("ado")).toBe(true)
    expect(isIntegration("github")).toBe(true)
    expect(isIntegration("graph")).toBe(true)
  })
  it("rejects unknown values", () => {
    expect(isIntegration("jira")).toBe(false)
    expect(isIntegration(123)).toBe(false)
  })
})

describe("isShareScope / IDENTITY_SCOPES", () => {
  it("accepts every known share scope", () => {
    for (const s of ["name", "identity", "notes:safe", "notes:all", "outcomes"] as ShareScope[]) {
      expect(isShareScope(s)).toBe(true)
    }
  })
  it("rejects unknown strings and non-strings", () => {
    expect(isShareScope("notes")).toBe(false)
    expect(isShareScope("everything")).toBe(false)
    expect(isShareScope(7)).toBe(false)
    expect(isShareScope(undefined)).toBe(false)
  })
  it("IDENTITY_SCOPES is exactly {name, identity}", () => {
    expect(Array.from(IDENTITY_SCOPES).sort()).toEqual(["identity", "name"])
  })
})
