import { afterEach, describe, expect, expectTypeOf, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import { tmpdir } from "os"
import { join } from "path"

import { FileFriendStore } from "../index"
import type {
  ExternalIdClaimInput,
  FriendRecord,
  InitiativePolicy,
  RelationshipPolicy,
} from "../index"

const NOW = "2026-08-29T18:00:00.000Z"
const INCARNATION_A = "00000000-0000-4000-8000-000000000001"

function record(id: string, overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id,
    name: id,
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

function journalRecord(id: string, recordIncarnation: string): FriendRecord {
  return {
    id,
    recordIncarnation,
    recordGeneration: 0,
    name: id,
    role: "friend",
    trustLevel: "stranger",
    admissionState: "unverified",
    initiativePolicy: "none",
    relationshipPolicy: { schemaVersion: 1, version: 0, preferences: {} },
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "human",
  }
}

function telegramId(userId = "42") {
  return {
    provider: "telegram-user" as const,
    externalId: userId,
    linkedAt: NOW,
  }
}

describe("household relationship policy types", () => {
  it("keeps admission, initiative, relationship preferences, and capabilities independent", () => {
    const relationshipPolicy: RelationshipPolicy = {
      schemaVersion: 1,
      version: 3,
      preferences: {
        verbosity: {
          value: "concise",
          provenance: "stated",
          version: 2,
          source: "telegram:user-event-9",
        },
        reminderLeadMinutes: {
          value: 30,
          provenance: "observed",
          version: 1,
          source: "care:movie-night",
          expiresAt: "2026-09-30T00:00:00.000Z",
        },
      },
    }
    const friend = record("ari", {
      admissionState: "active",
      initiativePolicy: "proactive",
      relationshipPolicy,
      capabilityProfileId: "sanctuary-operator",
    })

    expect(friend.admissionState).toBe("active")
    expect(friend.initiativePolicy).toBe("proactive")
    expect(friend.relationshipPolicy).toEqual(relationshipPolicy)
    expect(friend.capabilityProfileId).toBe("sanctuary-operator")
    expectTypeOf(friend.initiativePolicy).toMatchTypeOf<InitiativePolicy | undefined>()
  })
})

describe("FileFriendStore household policy normalization", () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function storePair(): { first: FileFriendStore; second: FileFriendStore; friendsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "friends-household-"))
    dirs.push(root)
    const friendsPath = join(root, "friends")
    return {
      first: new FileFriendStore(friendsPath),
      second: new FileFriendStore(friendsPath),
      friendsPath,
    }
  }

  it("round-trips valid typed policy fields", async () => {
    const { first } = storePair()
    const relationshipPolicy: RelationshipPolicy = {
      schemaVersion: 1,
      version: 1,
      preferences: {
        verbosity: {
          value: "brief",
          provenance: "stated",
          version: 1,
          source: "telegram:user-event-1",
        },
      },
    }
    await first.put("mom", record("mom", {
      admissionState: "active",
      initiativePolicy: "request_follow_up_only",
      relationshipPolicy,
      capabilityProfileId: "sanctuary-household",
    }))

    expect(await first.get("mom")).toMatchObject({
      admissionState: "active",
      initiativePolicy: "request_follow_up_only",
      relationshipPolicy,
      capabilityProfileId: "sanctuary-household",
    })
  })

  it("normalizes absent or malformed authority fields fail-closed", async () => {
    const { first, friendsPath } = storePair()
    writeFileSync(join(friendsPath, "legacy.json"), JSON.stringify({
      ...record("legacy"),
      admissionState: "approved",
      initiativePolicy: "help-whenever",
      relationshipPolicy: {
        schemaVersion: 99,
        version: -1,
        preferences: {
          unsafe: { value: { arbitrary: true }, provenance: "guessed", version: 0, source: "" },
        },
      },
      capabilityProfileId: "   ",
    }))

    const loaded = await first.get("legacy")
    expect(loaded?.admissionState).toBe("unverified")
    expect(loaded?.initiativePolicy).toBe("none")
    expect(loaded?.relationshipPolicy).toEqual({ schemaVersion: 1, version: 0, preferences: {} })
    expect(loaded?.capabilityProfileId).toBeUndefined()
  })

  it("drops malformed preference entries without discarding valid entries", async () => {
    const { first, friendsPath } = storePair()
    writeFileSync(join(friendsPath, "mixed.json"), JSON.stringify({
      ...record("mixed"),
      relationshipPolicy: {
        schemaVersion: 1,
        version: 2,
        preferences: {
          valid: { value: true, provenance: "default", version: 1, source: "bundle:defaults" },
          expiredBad: { value: "x", provenance: "stated", version: 1, source: "event:1", expiresAt: "tomorrow" },
          arrayBad: { value: ["x"], provenance: "stated", version: 1, source: "event:2" },
        },
      },
    }))

    expect((await first.get("mixed"))?.relationshipPolicy).toEqual({
      schemaVersion: 1,
      version: 2,
      preferences: {
        valid: { value: true, provenance: "default", version: 1, source: "bundle:defaults" },
      },
    })
  })

  it("atomically creates one friend for concurrent claims from separate store instances", async () => {
    const { first, second } = storePair()
    const input = (id: string): ExternalIdClaimInput => ({
      externalId: telegramId(),
      target: { kind: "create", record: record(id) },
    })

    const [a, b] = await Promise.all([
      first.claimExternalId(input("candidate-a")),
      second.claimExternalId(input("candidate-b")),
    ])

    expect([a.status, b.status].sort()).toEqual(["already_claimed", "created"])
    expect(a.record?.id).toBe(b.record?.id)
    expect((await first.listAll()).filter((friend) =>
      friend.externalIds.some((externalId) => externalId.provider === "telegram-user" && externalId.externalId === "42"),
    )).toHaveLength(1)
  })

  it("links an unclaimed external id to an existing friend and is idempotent after restart", async () => {
    const { first, friendsPath } = storePair()
    await first.put("mom", record("mom"))
    const input: ExternalIdClaimInput = {
      externalId: telegramId(),
      target: { kind: "link", friendId: "mom" },
    }

    expect((await first.claimExternalId(input)).status).toBe("linked")
    const restarted = new FileFriendStore(friendsPath)
    const retried = await restarted.claimExternalId(input)
    expect(retried.status).toBe("already_claimed")
    expect(retried.record?.id).toBe("mom")
  })

  it("returns not_found for a missing link target", async () => {
    const { first } = storePair()
    const result = await first.claimExternalId({
      externalId: telegramId(),
      target: { kind: "link", friendId: "missing" },
    })
    expect(result).toEqual({ ok: false, status: "not_found" })
  })

  it("returns collision without merging trust, notes, or deleting either friend", async () => {
    const { first } = storePair()
    await first.put("owner", record("owner", {
      trustLevel: "acquaintance",
      externalIds: [telegramId()],
      notes: { ownerOnly: { value: "keep", savedAt: NOW } },
    }))
    await first.put("target", record("target", {
      trustLevel: "family",
      notes: { targetOnly: { value: "keep", savedAt: NOW } },
    }))

    const result = await first.claimExternalId({
      externalId: telegramId(),
      target: { kind: "link", friendId: "target" },
    })

    expect(result).toEqual({ ok: false, status: "collision", existingFriendId: "owner" })
    expect(await first.get("owner")).toMatchObject({
      trustLevel: "acquaintance",
      notes: { ownerOnly: { value: "keep", savedAt: NOW } },
    })
    expect(await first.get("target")).toMatchObject({
      trustLevel: "family",
      notes: { targetOnly: { value: "keep", savedAt: NOW } },
      externalIds: [],
    })
  })

  it("recovers a complete immutable claim left by a crashed writer", async () => {
    const { first, friendsPath } = storePair()
    const identityKey = JSON.stringify(["telegram-user", "42", null])
    const identityDigest = createHash("sha256").update(identityKey).digest("hex")
    const claimsPath = join(friendsPath, "_external-id-claims")
    mkdirSync(claimsPath, { mode: 0o700 })
    writeFileSync(
      join(claimsPath, `${identityDigest}.json`),
      JSON.stringify({
        schemaVersion: 1,
        state: "pending",
        identityDigest,
        externalId: telegramId(),
        friendId: "after-crash",
        recordIncarnation: INCARNATION_A,
        targetKind: "create",
        createRecord: journalRecord("after-crash", INCARNATION_A),
      }),
      { mode: 0o600 },
    )

    const result = await first.claimExternalId({
      externalId: telegramId(),
      target: { kind: "create", record: record("different-retry-candidate") },
    })
    expect(result.status).toBe("already_claimed")
    expect(result.record?.id).toBe("after-crash")
    expect(await first.get("different-retry-candidate")).toBeNull()
  })
})
