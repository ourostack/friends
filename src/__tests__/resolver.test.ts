import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import {
  FriendResolver,
  FileFriendStore,
  isLocalMachineOwnerIdentity,
  machineOwnerUsername,
  _setMachineOwnerUsernameForTest,
  MemoryRosterStore,
} from "../index"
import type {
  FriendRecord,
  AccountRoster,
  FriendStore,
  ExternalIdClaimStore,
  ExternalIdClaimInput,
} from "../index"
import { ed25519RosterVerifier, signRoster } from "../a2a-client/roster-verify"
import { readySodium } from "./_sodium"

const NOW = "2026-09-23T00:00:00.000Z"

function tmpStore(): { store: FileFriendStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "friends-resolver-"))
  return { store: new FileFriendStore(join(dir, "friends")), dir }
}

function makeFriend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "friend-id",
    name: "Jordan",
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

function isExternalIdClaimStore(store: FriendStore): store is ExternalIdClaimStore {
  return typeof (store as Partial<ExternalIdClaimStore>).claimExternalId === "function"
}

describe("FriendResolver against a temp FileFriendStore", () => {
  const dirs: string[] = []
  afterEach(() => {
    _setMachineOwnerUsernameForTest(undefined)
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("first contact on an empty bundle imprints the primary at family trust", async () => {
    const { store, dir } = tmpStore()
    dirs.push(dir)

    const ctx = await new FriendResolver(store, {
      provider: "aad",
      externalId: "aad-first",
      tenantId: "t1",
      displayName: "First Person",
      channel: "teams",
    }).resolve()

    expect(ctx.friend.role).toBe("primary")
    expect(ctx.friend.trustLevel).toBe("family")
    expect(ctx.friend.name).toBe("First Person")
    // Persisted to disk.
    const persisted = await store.findByExternalId("aad", "aad-first", "t1")
    expect(persisted?.id).toBe(ctx.friend.id)
  })

  it("first contact AFTER the bundle is populated keeps stranger trust with store-owned defaults", async () => {
    const { store, dir } = tmpStore()
    dirs.push(dir)
    // Imprint the primary first so the bundle is non-empty.
    await new FriendResolver(store, {
      provider: "aad",
      externalId: "aad-primary",
      tenantId: "t1",
      displayName: "Primary",
      channel: "teams",
    }).resolve()

    const ctx = await new FriendResolver(store, {
      provider: "aad",
      externalId: "aad-second",
      tenantId: "t1",
      displayName: "Cold Contact",
      channel: "teams",
    }).resolve()

    expect(ctx.friend.trustLevel).toBe("stranger")
    expect(ctx.friend.role).toBe("friend")
    expect(ctx.friend.admissionState).toBe("unverified")
  })

  it("resolves the machine-owner local identity to family even on a populated bundle", async () => {
    _setMachineOwnerUsernameForTest("operator")
    const { store, dir } = tmpStore()
    dirs.push(dir)
    // Populate the bundle so this is NOT a first imprint.
    await new FriendResolver(store, {
      provider: "aad",
      externalId: "someone",
      displayName: "Someone",
      channel: "teams",
    }).resolve()

    const ctx = await new FriendResolver(store, {
      provider: "local",
      externalId: "operator",
      displayName: "operator",
      channel: "cli",
    }).resolve()

    expect(ctx.friend.trustLevel).toBe("family")
    expect(ctx.friend.role).toBe("family")
  })

  it("resolves a user@host machine-owner identity to family", async () => {
    _setMachineOwnerUsernameForTest("operator")
    const { store, dir } = tmpStore()
    dirs.push(dir)
    await new FriendResolver(store, {
      provider: "aad",
      externalId: "someone",
      displayName: "Someone",
      channel: "teams",
    }).resolve()

    const ctx = await new FriendResolver(store, {
      provider: "local",
      externalId: "operator@laptop",
      displayName: "operator",
      channel: "cli",
    }).resolve()

    expect(ctx.friend.trustLevel).toBe("family")
  })

  it("keeps a non-owner local identity at stranger trust on a populated bundle", async () => {
    _setMachineOwnerUsernameForTest("operator")
    const { store, dir } = tmpStore()
    dirs.push(dir)
    await new FriendResolver(store, {
      provider: "aad",
      externalId: "someone",
      displayName: "Someone",
      channel: "teams",
    }).resolve()

    const ctx = await new FriendResolver(store, {
      provider: "local",
      externalId: "guest",
      displayName: "guest",
      channel: "cli",
    }).resolve()

    expect(ctx.friend.trustLevel).toBe("stranger")
    expect(ctx.friend.role).toBe("friend")
    expect(ctx.friend.admissionState).toBe("unverified")
  })

  it("an a2a-agent provider creates a kind:'agent' record with agentMeta", async () => {
    const { store, dir } = tmpStore()
    dirs.push(dir)

    const ctx = await new FriendResolver(store, {
      provider: "a2a-agent",
      externalId: "peer-agent-id",
      displayName: "Peer Bot",
      channel: "a2a",
    }).resolve()

    expect(ctx.friend.kind).toBe("agent")
    expect(ctx.friend.role).toBe("agent-peer")
    expect(ctx.friend.trustLevel).toBe("stranger")
    expect(ctx.friend.agentMeta).toBeDefined()
    expect(ctx.friend.agentMeta?.bundleName).toBe("Peer Bot")
    expect(ctx.friend.agentMeta?.a2a?.agentId).toBe("peer-agent-id")
  })

  it("resolves an existing friend by external id without rewriting it", async () => {
    const { store, dir } = tmpStore()
    dirs.push(dir)
    const first = await new FriendResolver(store, {
      provider: "aad",
      externalId: "aad-stable",
      tenantId: "t1",
      displayName: "Stable Name",
      channel: "teams",
    }).resolve()

    // Second resolve with a different display name must NOT overwrite.
    const second = await new FriendResolver(store, {
      provider: "aad",
      externalId: "aad-stable",
      tenantId: "t1",
      displayName: "SYSTEM.PROVIDED.NAME",
      channel: "teams",
    }).resolve()

    expect(second.friend.id).toBe(first.friend.id)
    expect(second.friend.name).toBe("Stable Name")
  })

  it("attaches channel capabilities to the resolved context", async () => {
    const { store, dir } = tmpStore()
    dirs.push(dir)
    const ctx = await new FriendResolver(store, {
      provider: "aad",
      externalId: "aad-cap",
      displayName: "Cap",
      channel: "teams",
    }).resolve()

    expect(ctx.channel.channel).toBe("teams")
    expect(ctx.channel.availableIntegrations).toEqual(["ado", "graph", "github"])
    expect(ctx.channel.supportsRichCards).toBe(true)
  })

  it("marks an auto-created BlueBubbles group stranger so the trust gate can surface it", async () => {
    const { store, dir } = tmpStore()
    dirs.push(dir)
    // Populate so this is not first-imprint.
    await new FriendResolver(store, {
      provider: "aad",
      externalId: "primary",
      displayName: "Primary",
      channel: "teams",
    }).resolve()

    const ctx = await new FriendResolver(store, {
      provider: "imessage-handle",
      externalId: "group:any;+;hash123",
      displayName: "Group Chat",
      channel: "bluebubbles",
    }).resolve()

    expect(ctx.friend.trustLevel).toBe("stranger")
    expect(ctx.friend.notes.autoCreatedGroup).toEqual(
      expect.objectContaining({ value: "true" }),
    )
  })

  describe("machine-owner helpers", () => {
    it("isLocalMachineOwnerIdentity matches the bare owner username", () => {
      expect(isLocalMachineOwnerIdentity("local", "operator", "operator")).toBe(true)
    })
    it("isLocalMachineOwnerIdentity matches user@host for the owner", () => {
      expect(isLocalMachineOwnerIdentity("local", "operator@box", "operator")).toBe(true)
    })
    it("isLocalMachineOwnerIdentity rejects a different user", () => {
      expect(isLocalMachineOwnerIdentity("local", "guest", "operator")).toBe(false)
    })
    it("isLocalMachineOwnerIdentity only applies to the local provider", () => {
      expect(isLocalMachineOwnerIdentity("aad", "operator", "operator")).toBe(false)
    })
    it("isLocalMachineOwnerIdentity is false when the owner is undetectable", () => {
      expect(isLocalMachineOwnerIdentity("local", "operator", null)).toBe(false)
    })
    it("machineOwnerUsername returns the test override", () => {
      _setMachineOwnerUsernameForTest("owner-x")
      expect(machineOwnerUsername()).toBe("owner-x")
    })
    it("machineOwnerUsername returns null when overridden to null", () => {
      _setMachineOwnerUsernameForTest(null)
      expect(machineOwnerUsername()).toBeNull()
    })
    it("machineOwnerUsername falls back to the OS user with no override", () => {
      _setMachineOwnerUsernameForTest(undefined)
      const result = machineOwnerUsername()
      expect(result === null || typeof result === "string").toBe(true)
    })
  })

  describe("resilience", () => {
    it("still resolves (creating new) when findByExternalId throws", async () => {
      const throwingStore = {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        findByExternalId: async (): Promise<FriendRecord | null> => {
          throw new Error("disk error")
        },
        hasAnyFriends: async () => false,
      }
      const ctx = await new FriendResolver(throwingStore, {
        provider: "local",
        externalId: "user",
        displayName: "User",
        channel: "cli",
      }).resolve()
      expect(ctx.friend.name).toBe("User")
    })

    it("treats a hasAnyFriends failure as first-imprint (family)", async () => {
      const store = {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        findByExternalId: async (): Promise<FriendRecord | null> => null,
        hasAnyFriends: async (): Promise<boolean> => {
          throw new Error("index read failed")
        },
      }
      const ctx = await new FriendResolver(store, {
        provider: "aad",
        externalId: "x",
        displayName: "X",
        channel: "teams",
      }).resolve()
      expect(ctx.friend.trustLevel).toBe("family")
    })

    it("still resolves when store.put rejects on a new friend", async () => {
      const store = {
        get: async () => null,
        put: async (): Promise<void> => {
          throw new Error("write error")
        },
        delete: async () => {},
        findByExternalId: async (): Promise<FriendRecord | null> => null,
        hasAnyFriends: async () => false,
      }
      const ctx = await new FriendResolver(store, {
        provider: "local",
        externalId: "user",
        displayName: "User",
        channel: "cli",
      }).resolve()
      expect(ctx.friend.name).toBe("User")
    })

    it("does not auto-populate a name note when displayName is 'Unknown'", async () => {
      const { store, dir } = tmpStore()
      dirs.push(dir)
      const ctx = await new FriendResolver(store, {
        provider: "aad",
        externalId: "unknown-id",
        displayName: "Unknown",
        channel: "teams",
      }).resolve()
      expect(ctx.friend.notes).toEqual({})
    })

    it("returns default capabilities for an unknown channel", async () => {
      const { store, dir } = tmpStore()
      dirs.push(dir)
      const ctx = await new FriendResolver(store, {
        provider: "local",
        externalId: "u",
        displayName: "u",
        channel: "does-not-exist",
      }).resolve()
      expect(ctx.channel.availableIntegrations).toEqual([])
      expect(ctx.channel.supportsStreaming).toBe(false)
    })
  })

  describe("atomic external identity claims", () => {
    it("converges concurrent first contact on the canonical claimed friend", async () => {
      const canonical = makeFriend({
        id: "canonical-friend",
        name: "Alex Wilber",
        externalIds: [{
          provider: "aad",
          externalId: "aad-alex",
          tenantId: "tenant-1",
          linkedAt: NOW,
        }],
      })
      const claimCalls: ExternalIdClaimInput[] = []
      let nextStatus: "created" | "already_claimed" = "created"
      const store: ExternalIdClaimStore = {
        get: async () => null,
        put: async () => {
          throw new Error("plain put path should stay unused for claim stores")
        },
        delete: async () => {},
        findByExternalId: async () => null,
        hasAnyFriends: async () => true,
        claimExternalId: async (input) => {
          claimCalls.push(input)
          const status = nextStatus
          nextStatus = "already_claimed"
          return { ok: true, status, record: canonical }
        },
      }

      expect(isExternalIdClaimStore(store)).toBe(true)

      const [first, second] = await Promise.all([
        new FriendResolver(store, {
          provider: "aad",
          externalId: "aad-alex",
          tenantId: "tenant-1",
          displayName: "Alex Wilber",
          channel: "teams",
        }).resolve(),
        new FriendResolver(store, {
          provider: "aad",
          externalId: "aad-alex",
          tenantId: "tenant-1",
          displayName: "Alex Wilber",
          channel: "teams",
        }).resolve(),
      ])

      expect(claimCalls).toHaveLength(2)
      expect(claimCalls[0]).toEqual({
        externalId: {
          provider: "aad",
          externalId: "aad-alex",
          tenantId: "tenant-1",
          linkedAt: expect.any(String),
        },
        target: {
          kind: "create",
          record: {
            id: expect.any(String),
            name: "Alex Wilber",
          },
        },
      })
      expect(first.friend.id).toBe("canonical-friend")
      expect(second.friend.id).toBe("canonical-friend")
    })

    it("keeps the legacy put path for plain stores", async () => {
      const puts: FriendRecord[] = []
      const store: FriendStore = {
        get: async () => null,
        put: async (_id, record) => {
          puts.push(record)
        },
        delete: async () => {},
        findByExternalId: async () => null,
        hasAnyFriends: async () => false,
      }

      expect(isExternalIdClaimStore(store)).toBe(false)

      const ctx = await new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-first",
        tenantId: "tenant-1",
        displayName: "First Person",
        channel: "teams",
      }).resolve()

      expect(puts).toHaveLength(1)
      expect(puts[0].id).toBe(ctx.friend.id)
      expect(ctx.friend.role).toBe("primary")
      expect(ctx.friend.trustLevel).toBe("family")
      expect(ctx.friend.externalIds).toEqual([{
        provider: "aad",
        externalId: "aad-first",
        tenantId: "tenant-1",
        linkedAt: expect.any(String),
      }])
    })

    it("keeps tenant-scoped claims distinct", async () => {
      const canonicalTenantOne = makeFriend({
        id: "tenant-one-friend",
        name: "Alex Wilber",
        externalIds: [{
          provider: "aad",
          externalId: "aad-alex",
          tenantId: "tenant-1",
          linkedAt: NOW,
        }],
      })
      const canonicalTenantTwo = makeFriend({
        id: "tenant-two-friend",
        name: "Alex Wilber",
        externalIds: [{
          provider: "aad",
          externalId: "aad-alex",
          tenantId: "tenant-2",
          linkedAt: NOW,
        }],
      })
      const claimKeys: string[] = []
      const store: ExternalIdClaimStore = {
        get: async () => null,
        put: async () => {
          throw new Error("plain put path should stay unused for claim stores")
        },
        delete: async () => {},
        findByExternalId: async () => null,
        hasAnyFriends: async () => true,
        claimExternalId: async (input) => {
          claimKeys.push(`${input.externalId.provider}:${input.externalId.externalId}:${input.externalId.tenantId ?? ""}`)
          return {
            ok: true,
            status: "created",
            record: input.externalId.tenantId === "tenant-1" ? canonicalTenantOne : canonicalTenantTwo,
          }
        },
      }

      const first = await new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-alex",
        tenantId: "tenant-1",
        displayName: "Alex Wilber",
        channel: "teams",
      }).resolve()
      const second = await new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-alex",
        tenantId: "tenant-2",
        displayName: "Alex Wilber",
        channel: "teams",
      }).resolve()

      expect(claimKeys).toEqual([
        "aad:aad-alex:tenant-1",
        "aad:aad-alex:tenant-2",
      ])
      expect(first.friend.id).toBe("tenant-one-friend")
      expect(second.friend.id).toBe("tenant-two-friend")
    })

    it("surfaces a rejected claim failure", async () => {
      const store: ExternalIdClaimStore = {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        findByExternalId: async () => null,
        hasAnyFriends: async () => true,
        claimExternalId: async () => {
          throw new Error("claim journal unavailable")
        },
      }

      await expect(new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-alex",
        tenantId: "tenant-1",
        displayName: "Alex Wilber",
        channel: "teams",
      }).resolve()).rejects.toThrow("claim journal unavailable")
    })

    it("returns the store-owned authority fields unchanged", async () => {
      const canonical = makeFriend({
        id: "canonical-friend",
        name: "Alex Wilber",
        role: "friend",
        trustLevel: "acquaintance",
        admissionState: "active",
        relationshipPolicy: {
          version: 1,
          updatedAt: NOW,
          initiative: { allow: false, provenance: "stated" },
        },
        externalIds: [{
          provider: "aad",
          externalId: "aad-alex",
          tenantId: "tenant-1",
          linkedAt: NOW,
        }],
      })
      let capturedClaim: ExternalIdClaimInput | undefined
      const store: ExternalIdClaimStore = {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        findByExternalId: async () => null,
        hasAnyFriends: async () => true,
        claimExternalId: async (input) => {
          capturedClaim = input
          return { ok: true, status: "created", record: canonical }
        },
      }

      const ctx = await new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-alex",
        tenantId: "tenant-1",
        displayName: "Alex Wilber",
        channel: "teams",
      }).resolve()

      expect(capturedClaim?.target).toEqual({
        kind: "create",
        record: {
          id: expect.any(String),
          name: "Alex Wilber",
        },
      })
      expect(capturedClaim?.target).not.toHaveProperty("record.trustLevel")
      expect(capturedClaim?.target).not.toHaveProperty("record.admissionState")
      expect(capturedClaim?.target).not.toHaveProperty("record.relationshipPolicy")
      expect(ctx.friend.role).toBe("friend")
      expect(ctx.friend.trustLevel).toBe("acquaintance")
      expect(ctx.friend.admissionState).toBe("active")
      expect(ctx.friend.relationshipPolicy).toEqual(canonical.relationshipPolicy)
    })

    it("throws when a claim collides with a different canonical friend", async () => {
      const store: ExternalIdClaimStore = {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        findByExternalId: async () => null,
        hasAnyFriends: async () => true,
        claimExternalId: async () => ({
          ok: false,
          status: "collision",
          existingFriendId: "winner-friend",
        }),
      }

      await expect(new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-alex",
        tenantId: "tenant-1",
        displayName: "Alex Wilber",
        channel: "teams",
      }).resolve()).rejects.toThrow("friend resolution claim collision for aad:aad-alex:tenant-1 (existing friend winner-friend)")
    })

    it("throws when a claim target no longer exists", async () => {
      const store: ExternalIdClaimStore = {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        findByExternalId: async () => null,
        hasAnyFriends: async () => true,
        claimExternalId: async () => ({
          ok: false,
          status: "not_found",
        }),
      }

      await expect(new FriendResolver(store, {
        provider: "aad",
        externalId: "aad-alex",
        tenantId: "tenant-1",
        displayName: "Alex Wilber",
        channel: "teams",
      }).resolve()).rejects.toThrow("friend resolution claim target missing for aad:aad-alex:tenant-1")
    })
  })
})

// Bug C — resolver roster-awareness. A cold a2a peer on a DIFFERENT OS user whose
// did is a key-verified member of the owner's pinned roster is recognized as
// family; a non-member stays stranger; no-roster-context is byte-for-byte
// unchanged. The resolver consults the pinned roster via the injected RosterStore
// (the caller seeds putRoster + putPin); it stays core-clean (the Ed25519 verifier
// arrives via the seam — never an a2a-client import in resolver.ts).
describe("FriendResolver — Bug C: roster-aware family", () => {
  const dirs: string[] = []
  afterEach(() => {
    _setMachineOwnerUsernameForTest(undefined)
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const MEMBER_DID = "did:key:zRosterMember"
  const ACCOUNT_ID = "acct-owner"

  async function seededRosterContext(opts: { memberDid?: string; pin?: boolean; tamper?: boolean; pinKeyOverride?: string } = {}) {
    const sodium = await readySodium()
    const kp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL)
    const members = [{ handle: "alice", did: opts.memberDid ?? MEMBER_DID }]
    const body = { accountId: ACCOUNT_ID, members, epoch: 1 }
    const sig = signRoster({ sodium, accountKeyPriv: kp.privateKey, roster: body })
    let roster: AccountRoster = { ...body, sig }
    if (opts.tamper) roster = { ...roster, members: [{ handle: "alice", did: MEMBER_DID }, { handle: "evil", did: "did:key:zEvil" }] }
    const store = new MemoryRosterStore()
    await store.putRoster(roster)
    if (opts.pin !== false) {
      await store.putPin({ accountId: ACCOUNT_ID, rosterKey: opts.pinKeyOverride ?? rosterKey, pinnedAt: "2026-01-01T00:00:00.000Z" })
    }
    return { store, verifier: ed25519RosterVerifier(sodium), candidateDid: MEMBER_DID, accountId: ACCOUNT_ID }
  }

  it("seats family for a roster member on a DIFFERENT OS user", async () => {
    _setMachineOwnerUsernameForTest("alice-os")
    const { store, dir } = tmpStore()
    dirs.push(dir)
    // Populate the bundle so this is NOT the first-imprint family path.
    await new FriendResolver(store, { provider: "local", externalId: "alice-os", displayName: "Owner", channel: "cli" }).resolve()

    const roster = await seededRosterContext()
    const ctx = await new FriendResolver(
      store,
      { provider: "a2a-agent", externalId: MEMBER_DID, displayName: "Sibling Bot", channel: "a2a" },
      roster,
    ).resolve()

    expect(ctx.friend.trustLevel).toBe("family")
    expect(ctx.friend.role).toBe("family")
  })

  it("keeps a non-member cold a2a peer at stranger (roster-awareness does not loosen the default)", async () => {
    const { store, dir } = tmpStore()
    dirs.push(dir)
    const roster = await seededRosterContext()
    const ctx = await new FriendResolver(
      store,
      { provider: "a2a-agent", externalId: "did:key:zNotInRoster", displayName: "Cold Bot", channel: "a2a" },
      { ...roster, candidateDid: "did:key:zNotInRoster" },
    ).resolve()
    expect(ctx.friend.trustLevel).toBe("stranger")
  })

  it("does NOT seat family when the roster fails to verify (tampered)", async () => {
    const { store, dir } = tmpStore()
    dirs.push(dir)
    const roster = await seededRosterContext({ tamper: true })
    const ctx = await new FriendResolver(
      store,
      { provider: "a2a-agent", externalId: MEMBER_DID, displayName: "Bot", channel: "a2a" },
      roster,
    ).resolve()
    expect(ctx.friend.trustLevel).toBe("stranger")
  })

  // finding 7 (LOW): this exercises the `unverified` branch, NOT the
  // `roster_key_mismatch` branch. The resolver reads the pinned key and passes it
  // straight back to evaluateAccountMembership (rosterKey: pin.rosterKey), so the
  // presented key ALWAYS equals the pinned key — the resolver path can never fire the
  // mismatch guard and never re-pins. A wrong pinned key instead makes the roster sig
  // fail to verify under that key → `unverified` → no family. (The true
  // roster_key_mismatch branch is covered directly in account-roster.test.ts, where a
  // caller presents a key that differs from an existing pin.)
  it("does NOT seat family when the pinned key does not match the signing key (verification fails → unverified)", async () => {
    const { store, dir } = tmpStore()
    dirs.push(dir)
    // Pin a DIFFERENT key than the roster was signed with. The resolver passes this
    // pinned key back to the membership check, so the sig fails to verify under it.
    const roster = await seededRosterContext({ pinKeyOverride: "K1-different" })
    const ctx = await new FriendResolver(
      store,
      { provider: "a2a-agent", externalId: MEMBER_DID, displayName: "Bot", channel: "a2a" },
      roster,
    ).resolve()
    expect(ctx.friend.trustLevel).toBe("stranger")
  })

  it("is byte-for-byte unchanged with NO roster context (regression-lock the existing matrix)", async () => {
    // cold a2a ⇒ stranger
    const a = tmpStore(); dirs.push(a.dir)
    const coldA2A = await new FriendResolver(a.store, { provider: "a2a-agent", externalId: "did:key:zCold", displayName: "Cold", channel: "a2a" }).resolve()
    expect(coldA2A.friend.trustLevel).toBe("stranger")

    // first imprint ⇒ family
    const b = tmpStore(); dirs.push(b.dir)
    const imprint = await new FriendResolver(b.store, { provider: "aad", externalId: "first", displayName: "First", channel: "teams" }).resolve()
    expect(imprint.friend.trustLevel).toBe("family")

    // local machine owner ⇒ family
    _setMachineOwnerUsernameForTest("owner")
    const c = tmpStore(); dirs.push(c.dir)
    await new FriendResolver(c.store, { provider: "aad", externalId: "seed", displayName: "Seed", channel: "teams" }).resolve()
    const owner = await new FriendResolver(c.store, { provider: "local", externalId: "owner", displayName: "Owner", channel: "cli" }).resolve()
    expect(owner.friend.trustLevel).toBe("family")

    // ordinary stranger ⇒ stranger
    const d = tmpStore(); dirs.push(d.dir)
    await new FriendResolver(d.store, { provider: "aad", externalId: "seed2", displayName: "Seed", channel: "teams" }).resolve()
    const stranger = await new FriendResolver(d.store, { provider: "aad", externalId: "rando", displayName: "Rando", channel: "teams" }).resolve()
    expect(stranger.friend.trustLevel).toBe("stranger")
  })
})
