import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, rmdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { FileFriendStore } from "../index"
import type { FriendRecord } from "../index"

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "friends-store-"))
}

function makeRecord(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "rec-1",
    name: "Jordan",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [{ provider: "aad", externalId: "aad-1", tenantId: "t1", linkedAt: "2026-01-01T00:00:00.000Z" }],
    tenantMemberships: ["t1"],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

describe("FileFriendStore", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function store(): { store: FileFriendStore; friendsPath: string } {
    const dir = freshDir()
    dirs.push(dir)
    const friendsPath = join(dir, "friends")
    return { store: new FileFriendStore(friendsPath), friendsPath }
  }

  it("creates the friends directory on construction", () => {
    const { friendsPath } = store()
    // mkdirSync(recursive) means a subsequent read works without throwing.
    expect(() => readFileSync(join(friendsPath, "nope.json"))).toThrow()
  })

  it("round-trips a record by id (put → get)", async () => {
    const { store: s } = store()
    await s.put("rec-1", makeRecord())
    const got = await s.get("rec-1")
    expect(got?.id).toBe("rec-1")
    expect(got?.name).toBe("Jordan")
  })

  it("returns null for a missing id", async () => {
    const { store: s } = store()
    expect(await s.get("missing")).toBeNull()
  })

  it("findByExternalId resolves on provider + externalId", async () => {
    const { store: s } = store()
    await s.put("rec-1", makeRecord())
    const found = await s.findByExternalId("aad", "aad-1")
    expect(found?.id).toBe("rec-1")
  })

  it("findByExternalId honors the optional tenantId filter", async () => {
    const { store: s } = store()
    await s.put("rec-1", makeRecord())
    expect(await s.findByExternalId("aad", "aad-1", "t1")).not.toBeNull()
    expect(await s.findByExternalId("aad", "aad-1", "wrong-tenant")).toBeNull()
  })

  it("findByExternalId returns null when no record matches", async () => {
    const { store: s } = store()
    await s.put("rec-1", makeRecord())
    expect(await s.findByExternalId("aad", "nobody")).toBeNull()
  })

  it("findByExternalId returns null when the directory is empty", async () => {
    const { store: s } = store()
    expect(await s.findByExternalId("aad", "aad-1")).toBeNull()
  })

  it("hasAnyFriends reflects directory contents", async () => {
    const { store: s } = store()
    expect(await s.hasAnyFriends()).toBe(false)
    await s.put("rec-1", makeRecord())
    expect(await s.hasAnyFriends()).toBe(true)
  })

  it("listAll returns every persisted record", async () => {
    const { store: s } = store()
    await s.put("rec-1", makeRecord({ id: "rec-1", externalIds: [] }))
    await s.put("rec-2", makeRecord({ id: "rec-2", name: "Sam", externalIds: [] }))
    const all = await s.listAll()
    expect(all.map((r) => r.id).sort()).toEqual(["rec-1", "rec-2"])
  })

  it("listAll returns an empty array for an empty store", async () => {
    const { store: s } = store()
    expect(await s.listAll()).toEqual([])
  })

  it("delete removes a record and is idempotent", async () => {
    const { store: s } = store()
    await s.put("rec-1", makeRecord())
    await s.delete("rec-1")
    expect(await s.get("rec-1")).toBeNull()
    // Deleting again must not throw (ENOENT swallowed).
    await expect(s.delete("rec-1")).resolves.toBeUndefined()
  })

  it("normalizes legacy records: bad trust level → friend, missing arrays → []", async () => {
    const { store: s, friendsPath } = store()
    // Write a raw, partially-malformed record straight to disk.
    writeFileSync(
      join(friendsPath, "legacy.json"),
      JSON.stringify({
        id: "legacy",
        name: "Legacy",
        trustLevel: "bogus",
        // externalIds / tenantMemberships / toolPreferences / notes all absent
      }),
    )
    const got = await s.get("legacy")
    expect(got?.trustLevel).toBe("friend")
    expect(got?.role).toBe("friend")
    expect(got?.externalIds).toEqual([])
    expect(got?.tenantMemberships).toEqual([])
    expect(got?.toolPreferences).toEqual({})
    expect(got?.notes).toEqual({})
    expect(got?.kind).toBe("human")
    expect(got?.totalTokens).toBe(0)
    expect(got?.schemaVersion).toBe(1)
  })

  it("filters malformed connection entries during normalize", async () => {
    const { store: s, friendsPath } = store()
    writeFileSync(
      join(friendsPath, "conns.json"),
      JSON.stringify({
        id: "conns",
        name: "Conns",
        connections: [
          { name: "Real", relationship: "teammate" },
          { name: "NoRel" },
          "garbage",
          null,
        ],
      }),
    )
    const got = await s.get("conns")
    expect(got?.connections).toEqual([{ name: "Real", relationship: "teammate" }])
  })

  it("normalizes agent records and drops agentMeta without a bundleName", async () => {
    const { store: s, friendsPath } = store()
    writeFileSync(
      join(friendsPath, "agent.json"),
      JSON.stringify({
        id: "agent",
        name: "Bot",
        kind: "agent",
        agentMeta: {
          bundleName: "bot-bundle",
          familiarity: 3,
          sharedMissions: ["m1"],
          outcomes: [],
          a2a: { agentId: "a-1", cardUrl: "https://card" },
        },
      }),
    )
    const got = await s.get("agent")
    expect(got?.kind).toBe("agent")
    expect(got?.agentMeta?.bundleName).toBe("bot-bundle")
    expect(got?.agentMeta?.familiarity).toBe(3)
    expect(got?.agentMeta?.a2a).toEqual({ agentId: "a-1", cardUrl: "https://card" })

    // Agent record with malformed agentMeta → agentMeta undefined.
    writeFileSync(
      join(friendsPath, "agent2.json"),
      JSON.stringify({ id: "agent2", name: "Bot2", kind: "agent", agentMeta: { familiarity: 1 } }),
    )
    const got2 = await s.get("agent2")
    expect(got2?.kind).toBe("agent")
    expect(got2?.agentMeta).toBeUndefined()
  })

  it("defaults malformed agentMeta fields and drops an empty a2a block", async () => {
    const { store: s, friendsPath } = store()
    // bundleName present, but familiarity/sharedMissions/outcomes are wrong-typed
    // and a2a has no usable string fields → a2a omitted, others defaulted.
    writeFileSync(
      join(friendsPath, "agent.json"),
      JSON.stringify({
        id: "agent",
        name: "Bot",
        kind: "agent",
        agentMeta: {
          bundleName: "b",
          familiarity: "not-a-number",
          sharedMissions: "nope",
          outcomes: "nope",
          a2a: { cardUrl: 123, endpointUrl: null },
        },
      }),
    )
    const got = await s.get("agent")
    expect(got?.agentMeta).toEqual({
      bundleName: "b",
      familiarity: 0,
      sharedMissions: [],
      outcomes: [],
    })
    expect(got?.agentMeta?.a2a).toBeUndefined()
  })

  it("keeps only the well-typed a2a fields (endpointUrl/agentId/protocolVersion)", async () => {
    const { store: s, friendsPath } = store()
    writeFileSync(
      join(friendsPath, "agent.json"),
      JSON.stringify({
        id: "agent",
        name: "Bot",
        kind: "agent",
        agentMeta: {
          bundleName: "b",
          a2a: { endpointUrl: "https://ep", agentId: "a-9", protocolVersion: "1.0", cardUrl: 5 },
        },
      }),
    )
    const got = await s.get("agent")
    expect(got?.agentMeta?.a2a).toEqual({
      endpointUrl: "https://ep",
      agentId: "a-9",
      protocolVersion: "1.0",
    })
  })

  it("preserves a well-formed a2a.mailbox on round-trip (put → reload)", async () => {
    const { store: s } = store()
    await s.put(
      "rec-1",
      makeRecord({
        id: "rec-1",
        kind: "agent",
        externalIds: [{ provider: "a2a-agent", externalId: "peer-mbx", linkedAt: "2026-01-01T00:00:00.000Z" }],
        agentMeta: {
          bundleName: "b",
          familiarity: 0,
          sharedMissions: [],
          outcomes: [],
          a2a: { agentId: "peer-mbx", mailbox: { repo: "/m/mailbox", selfOutboxAgentId: "agent-a" } },
        },
      }),
    )
    const reloaded = await s.findByExternalId("a2a-agent", "peer-mbx")
    expect(reloaded?.agentMeta?.a2a?.mailbox).toEqual({ repo: "/m/mailbox", selfOutboxAgentId: "agent-a" })
    expect(reloaded?.agentMeta?.a2a?.agentId).toBe("peer-mbx")
  })

  it("drops a malformed a2a.mailbox on round-trip but keeps the rest of a2a", async () => {
    const { store: s, friendsPath } = store()
    // mailbox.repo is a number → mailbox dropped; the other a2a fields survive.
    writeFileSync(
      join(friendsPath, "agent.json"),
      JSON.stringify({
        id: "agent",
        name: "Bot",
        kind: "agent",
        agentMeta: {
          bundleName: "b",
          a2a: { agentId: "a-9", mailbox: { repo: 123, selfOutboxAgentId: "agent-a" } },
        },
      }),
    )
    const got = await s.get("agent")
    expect(got?.agentMeta?.a2a?.agentId).toBe("a-9")
    expect(got?.agentMeta?.a2a?.mailbox).toBeUndefined()
  })

  it("drops an a2a.mailbox missing selfOutboxAgentId, and a non-object mailbox", async () => {
    const { store: s, friendsPath } = store()
    // repo present (string) but selfOutboxAgentId absent → the second guard fires.
    writeFileSync(
      join(friendsPath, "agent.json"),
      JSON.stringify({
        id: "agent",
        name: "Bot",
        kind: "agent",
        agentMeta: { bundleName: "b", a2a: { agentId: "a-1", mailbox: { repo: "/m" } } },
      }),
    )
    expect((await s.get("agent"))?.agentMeta?.a2a?.mailbox).toBeUndefined()

    // mailbox is a non-object (string) → the type guard fires.
    writeFileSync(
      join(friendsPath, "agent2.json"),
      JSON.stringify({
        id: "agent2",
        name: "Bot2",
        kind: "agent",
        agentMeta: { bundleName: "b", a2a: { agentId: "a-2", mailbox: "not-an-object" } },
      }),
    )
    const got2 = await s.get("agent2")
    expect(got2?.agentMeta?.a2a?.agentId).toBe("a-2")
    expect(got2?.agentMeta?.a2a?.mailbox).toBeUndefined()
  })

  it("normalizes a non-object agentMeta on an agent record to undefined", async () => {
    const { store: s, friendsPath } = store()
    writeFileSync(
      join(friendsPath, "agent.json"),
      JSON.stringify({ id: "agent", name: "Bot", kind: "agent", agentMeta: ["array-not-object"] }),
    )
    expect((await s.get("agent"))?.agentMeta).toBeUndefined()
  })

  it("drops a non-object a2a block but keeps the rest of agentMeta", async () => {
    const { store: s, friendsPath } = store()
    writeFileSync(
      join(friendsPath, "agent.json"),
      JSON.stringify({
        id: "agent",
        name: "Bot",
        kind: "agent",
        agentMeta: { bundleName: "b", familiarity: 2, sharedMissions: [], outcomes: [], a2a: "not-an-object" },
      }),
    )
    const got = await s.get("agent")
    expect(got?.agentMeta?.bundleName).toBe("b")
    expect(got?.agentMeta?.familiarity).toBe(2)
    expect(got?.agentMeta?.a2a).toBeUndefined()
  })

  it("ignores non-JSON and array-shaped files in the directory", async () => {
    const { store: s, friendsPath } = store()
    await s.put("rec-1", makeRecord())
    writeFileSync(join(friendsPath, "notjson.json"), "{ this is not json")
    writeFileSync(join(friendsPath, "array.json"), "[1,2,3]")
    writeFileSync(join(friendsPath, "ignored.txt"), "irrelevant")
    const all = await s.listAll()
    expect(all.map((r) => r.id)).toEqual(["rec-1"])
    expect(await s.findByExternalId("aad", "aad-1")).not.toBeNull()
  })

  it("caps long note values on write", async () => {
    const { store: s } = store()
    const huge = "x".repeat(300 * 1024) // > EVENT_CONTENT_MAX_CHARS (256KiB)
    await s.put("rec-1", makeRecord({ notes: { bio: { value: huge, savedAt: "2026-01-01T00:00:00.000Z" } } }))
    const got = await s.get("rec-1")
    const stored = got?.notes.bio.value ?? ""
    expect(stored.length).toBeLessThan(huge.length)
    expect(stored).toContain("[truncated")
  })

  it("does not cap short note values", async () => {
    const { store: s } = store()
    await s.put("rec-1", makeRecord({ notes: { bio: { value: "short bio", savedAt: "2026-01-01T00:00:00.000Z" } } }))
    const got = await s.get("rec-1")
    expect(got?.notes.bio.value).toBe("short bio")
  })

  it("two stores over the same dir see each other's writes", async () => {
    const dir = freshDir()
    dirs.push(dir)
    const friendsPath = join(dir, "friends")
    mkdirSync(friendsPath, { recursive: true })
    const a = new FileFriendStore(friendsPath)
    await a.put("rec-1", makeRecord())
    const b = new FileFriendStore(friendsPath)
    expect((await b.get("rec-1"))?.name).toBe("Jordan")
  })

  describe("when the friends directory becomes unreadable", () => {
    // Construct the store (which mkdir's the path), then swap the directory for a
    // regular file so directory reads/unlinks fail with ENOTDIR — exercising the
    // defensive catch branches.
    function storeOverClobberedDir(): FileFriendStore {
      const dir = freshDir()
      dirs.push(dir)
      const friendsPath = join(dir, "friends")
      const s = new FileFriendStore(friendsPath)
      rmdirSync(friendsPath)
      writeFileSync(friendsPath, "not a directory")
      return s
    }

    it("findByExternalId returns null", async () => {
      expect(await storeOverClobberedDir().findByExternalId("aad", "x")).toBeNull()
    })

    it("hasAnyFriends returns false", async () => {
      expect(await storeOverClobberedDir().hasAnyFriends()).toBe(false)
    })

    it("listAll returns an empty array", async () => {
      expect(await storeOverClobberedDir().listAll()).toEqual([])
    })

    it("delete rethrows a non-ENOENT error", async () => {
      // unlink of `${friendsPath}/rec.json` where friendsPath is a file → ENOTDIR.
      await expect(storeOverClobberedDir().delete("rec")).rejects.toMatchObject({
        code: "ENOTDIR",
      })
    })
  })
})
