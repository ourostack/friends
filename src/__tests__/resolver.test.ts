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
} from "../index"
import type { FriendRecord } from "../index"

function tmpStore(): { store: FileFriendStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "friends-resolver-"))
  return { store: new FileFriendStore(join(dir, "friends")), dir }
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

  it("first contact AFTER the bundle is populated resolves to stranger", async () => {
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
    expect(ctx.friend.role).toBe("stranger")
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

  it("keeps a non-owner local identity at stranger on a populated bundle", async () => {
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
    expect(ctx.friend.role).toBe("stranger")
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
})
