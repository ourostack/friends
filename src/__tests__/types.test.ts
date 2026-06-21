import { describe, it, expect } from "vitest"

import { TRUSTED_LEVELS, IDENTITY_SCOPES, isTrustedLevel, isIdentityProvider, isIntegration, isShareScope } from "../index"
import type {
  ShareScope,
  MissionKey,
  MissionLearning,
  ImportedLearning,
  MissionRecord,
} from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

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
    for (const s of ["name", "identity", "notes:safe", "notes:all", "outcomes", "mission"] as ShareScope[]) {
      expect(isShareScope(s)).toBe(true)
    }
  })
  it("accepts the new mission scope (brick 3)", () => {
    expect(isShareScope("mission")).toBe(true)
  })
  it("still accepts outcomes (regression — mission is additive)", () => {
    expect(isShareScope("outcomes")).toBe(true)
  })
  it("rejects unknown strings and non-strings", () => {
    expect(isShareScope("notes")).toBe(false)
    expect(isShareScope("everything")).toBe(false)
    expect(isShareScope("missions")).toBe(false)
    expect(isShareScope(7)).toBe(false)
    expect(isShareScope(undefined)).toBe(false)
  })
  it("IDENTITY_SCOPES is exactly {name, identity} — mission is content, not identity", () => {
    expect(Array.from(IDENTITY_SCOPES).sort()).toEqual(["identity", "name"])
    expect(IDENTITY_SCOPES.has("mission" as ShareScope)).toBe(false)
  })
})

describe("mission types (brick 3) — shape fixtures load under the public API", () => {
  it("constructs a MissionLearning with the p5 value shape", () => {
    const learning: MissionLearning = {
      value: "the deploy needs the canary FF off first",
      savedAt: NOW,
      provenance: { origin: "first_party" },
      shareable: true,
    }
    expect(learning.value).toBe("the deploy needs the canary FF off first")
    expect(learning.shareable).toBe(true)
    expect(learning.provenance?.origin).toBe("first_party")
  })

  it("constructs an ImportedLearning mirroring ImportedNote", () => {
    const imported: ImportedLearning = {
      value: "peer's learning",
      importedAt: NOW,
      assertedBy: { agentId: "agent-a" },
      originallyAssertedBy: { agentId: "agent-origin" },
    }
    expect(imported.assertedBy?.agentId).toBe("agent-a")
    expect(imported.originallyAssertedBy?.agentId).toBe("agent-origin")
  })

  it("constructs a MissionRecord with a MissionKey and the full p5 shape", () => {
    const missionKey: MissionKey = "PROJ-1234"
    const record: MissionRecord = {
      id: "m-uuid-1",
      missionKey,
      title: "Ship the mission ledger",
      status: "active",
      participants: [{ agentId: "agent-a", agentName: "Agent A" }],
      outcomes: [{ missionId: "m-uuid-1", result: "success", timestamp: NOW }],
      learnings: { gotcha: { value: "rebase not merge", savedAt: NOW } },
      importedLearnings: { "agent-b": { peerfact: { value: "theirs", importedAt: NOW } } },
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    }
    expect(record.missionKey).toBe("PROJ-1234")
    expect(record.status).toBe("active")
    expect(record.participants[0].agentId).toBe("agent-a")
    expect(record.learnings.gotcha.value).toBe("rebase not merge")
    expect(record.importedLearnings?.["agent-b"].peerfact.value).toBe("theirs")
    expect(record.schemaVersion).toBe(1)
  })
})
