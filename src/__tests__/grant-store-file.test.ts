import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import * as fsPromises from "fs/promises"

import { FileGrantStore, grantsDirFor } from "../index"
import type { ShareGrant } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

function grant(overrides: Partial<ShareGrant> = {}): ShareGrant {
  return {
    id: "g-1",
    subjectKey: "f-1",
    recipientAgentId: "agent-2",
    scope: "notes:safe",
    grantedAt: NOW,
    ...overrides,
  }
}

describe("grantsDirFor", () => {
  it("returns the sibling _grants dir under the friends dir", () => {
    expect(grantsDirFor("/bundle/friends")).toBe(join("/bundle/friends", "_grants"))
  })
})

describe("FileGrantStore", () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("mkdirs the grants dir on construction", () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = join(dir, "_grants")
    new FileGrantStore(grantsPath)
    expect(existsSync(grantsPath)).toBe(true)
  })

  it("put then get round-trips a grant", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const store = new FileGrantStore(grantsDirFor(dir))
    await store.put("g-1", grant({ expiresAt: "2027-01-01T00:00:00.000Z" }))
    const loaded = await store.get("g-1")
    expect(loaded?.id).toBe("g-1")
    expect(loaded?.scope).toBe("notes:safe")
    expect(loaded?.expiresAt).toBe("2027-01-01T00:00:00.000Z")
  })

  it("get returns null for a missing grant", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const store = new FileGrantStore(grantsDirFor(dir))
    expect(await store.get("nope")).toBeNull()
  })

  it("listAll returns all grants and ignores non-json files", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = grantsDirFor(dir)
    const store = new FileGrantStore(grantsPath)
    await store.put("g-1", grant({ id: "g-1" }))
    await store.put("g-2", grant({ id: "g-2", scope: "identity" }))
    await fsPromises.writeFile(join(grantsPath, "README.txt"), "not a grant", "utf-8")
    const all = await store.listAll()
    expect(all.map((g) => g.id).sort()).toEqual(["g-1", "g-2"])
  })

  it("listAll skips a file that is not a JSON object", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = grantsDirFor(dir)
    const store = new FileGrantStore(grantsPath)
    await store.put("g-1", grant())
    // A .json file that parses to a non-object (array) is skipped by readJson.
    await fsPromises.writeFile(join(grantsPath, "bad.json"), "[1,2,3]", "utf-8")
    // A .json file that is invalid JSON is skipped too.
    await fsPromises.writeFile(join(grantsPath, "broken.json"), "{not json", "utf-8")
    const all = await store.listAll()
    expect(all.map((g) => g.id)).toEqual(["g-1"])
  })

  it("delete removes a grant; deleting a missing grant is a safe noop", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const store = new FileGrantStore(grantsDirFor(dir))
    await store.put("g-1", grant())
    await store.delete("g-1")
    expect(await store.get("g-1")).toBeNull()
    // Deleting again (ENOENT) must not throw.
    await expect(store.delete("g-1")).resolves.toBeUndefined()
  })

  it("reads a grant with an unknown scope as no grant, so it never unlocks identity (#222)", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = grantsDirFor(dir)
    new FileGrantStore(grantsPath)
    await fsPromises.writeFile(
      join(grantsPath, "g-x.json"),
      JSON.stringify({ id: "g-x", subjectKey: "f", recipientAgentId: "a", scope: "everything", grantedAt: "2026-03-14T18:00:00.000Z" }),
      "utf-8",
    )
    const store = new FileGrantStore(grantsPath)
    expect(await store.get("g-x")).toBeNull()
    expect(await store.listAll()).toEqual([])
  })

  it("fills a missing grantedAt", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = grantsDirFor(dir)
    new FileGrantStore(grantsPath)
    // Hand-write a grant with no grantedAt.
    await fsPromises.writeFile(
      join(grantsPath, "g-x.json"),
      JSON.stringify({ id: "g-x", subjectFriendId: "f", recipientAgentId: "a", scope: "notes:safe" }),
      "utf-8",
    )
    const store = new FileGrantStore(grantsPath)
    const loaded = await store.get("g-x")
    expect(loaded?.scope).toBe("notes:safe")
    expect(typeof loaded?.grantedAt).toBe("string")
  })

  it("Fork D: loads an OLD-format on-disk grant (subjectFriendId, no subjectKey) as subjectKey", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = grantsDirFor(dir)
    new FileGrantStore(grantsPath)
    // Hand-write a schemaVersion-1 grant carrying the OLD field name only.
    await fsPromises.writeFile(
      join(grantsPath, "g-old.json"),
      JSON.stringify({ id: "g-old", subjectFriendId: "f-legacy", recipientAgentId: "a", scope: "notes:safe", grantedAt: NOW }),
      "utf-8",
    )
    const store = new FileGrantStore(grantsPath)
    const loaded = await store.get("g-old")
    // normalize reads `subjectKey ?? subjectFriendId` → the legacy value surfaces under subjectKey.
    expect(loaded?.subjectKey).toBe("f-legacy")
    // listAll reads the same normalize path.
    const all = await store.listAll()
    expect(all.find((g) => g.id === "g-old")?.subjectKey).toBe("f-legacy")
  })

  it("Fork D: a grant with NEITHER subjectKey nor subjectFriendId normalizes to an empty subjectKey", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = grantsDirFor(dir)
    new FileGrantStore(grantsPath)
    // A corrupt on-disk grant missing both subject fields — the `?? ""` third arm.
    await fsPromises.writeFile(
      join(grantsPath, "g-bad.json"),
      JSON.stringify({ id: "g-bad", recipientAgentId: "a", scope: "identity", grantedAt: NOW }),
      "utf-8",
    )
    const store = new FileGrantStore(grantsPath)
    const loaded = await store.get("g-bad")
    expect(loaded?.subjectKey).toBe("")
  })

  it("Fork D: a NEW-format grant (subjectKey) round-trips and persists as subjectKey", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = grantsDirFor(dir)
    const store = new FileGrantStore(grantsPath)
    await store.put("g-1", grant({ subjectKey: "f-new" }))
    const loaded = await store.get("g-1")
    expect(loaded?.subjectKey).toBe("f-new")
    // Read the raw file back: it must persist as `subjectKey`, never `subjectFriendId`.
    const raw = JSON.parse(await fsPromises.readFile(join(grantsPath, "g-1.json"), "utf-8"))
    expect(raw.subjectKey).toBe("f-new")
    expect("subjectFriendId" in raw).toBe(false)
  })

  it("Fork D: re-persisting an OLD-format grant rewrites it forward as subjectKey", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = grantsDirFor(dir)
    new FileGrantStore(grantsPath)
    await fsPromises.writeFile(
      join(grantsPath, "g-mig.json"),
      JSON.stringify({ id: "g-mig", subjectFriendId: "f-legacy", recipientAgentId: "a", scope: "identity", grantedAt: NOW }),
      "utf-8",
    )
    const store = new FileGrantStore(grantsPath)
    const loaded = await store.get("g-mig")
    // Round-trip it through put → it now persists with the new field name only.
    await store.put(loaded!.id, loaded!)
    const raw = JSON.parse(await fsPromises.readFile(join(grantsPath, "g-mig.json"), "utf-8"))
    expect(raw.subjectKey).toBe("f-legacy")
    expect("subjectFriendId" in raw).toBe(false)
  })

  it("preserves a revokedAt tombstone through a round-trip", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const store = new FileGrantStore(grantsDirFor(dir))
    await store.put("g-1", grant({ revokedAt: "2026-04-01T00:00:00.000Z" }))
    const loaded = await store.get("g-1")
    expect(loaded?.revokedAt).toBe("2026-04-01T00:00:00.000Z")
  })

  it("rethrows a non-ENOENT delete error", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const store = new FileGrantStore(grantsDirFor(dir))
    // A folder where the grant file would be: unlink fails with a code other than ENOENT.
    await fsPromises.mkdir(join(grantsDirFor(dir), "blocker.json"))
    await expect(store.delete("blocker")).rejects.toMatchObject({ code: expect.not.stringMatching(/^ENOENT$/) })
  })

  describe("ids that would leave the grants directory (#222)", () => {
    it("get does not read a JSON file outside the grants directory", async () => {
      dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
      const store = new FileGrantStore(grantsDirFor(dir))
      await fsPromises.writeFile(join(dir, "friend-1.json"), JSON.stringify({ id: "friend-1", subjectKey: "s", recipientAgentId: "a", scope: "identity" }))
      expect(await store.get("../friend-1")).toBeNull()
    })

    it("put refuses an id that leaves the grants directory and writes nothing", async () => {
      dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
      const store = new FileGrantStore(grantsDirFor(dir))
      await expect(store.put("../escaped", grant({ id: "../escaped" }))).rejects.toThrow("grant id is invalid")
      expect(existsSync(join(dir, "escaped.json"))).toBe(false)
    })

    it("put refuses a grant whose scope friends doesn't know", async () => {
      dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
      const store = new FileGrantStore(grantsDirFor(dir))
      await expect(store.put("g-1", grant({ scope: "everything" as never }))).rejects.toThrow("grant scope is invalid")
      expect(await store.get("g-1")).toBeNull()
    })

    it("delete refuses an id that leaves the grants directory and removes nothing", async () => {
      dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
      const store = new FileGrantStore(grantsDirFor(dir))
      await fsPromises.writeFile(join(dir, "friend-1.json"), "{}")
      await expect(store.delete("../friend-1")).rejects.toThrow("grant id is invalid")
      expect(existsSync(join(dir, "friend-1.json"))).toBe(true)
    })
  })

  describe("damage reads as less consent, never more (#222 review)", () => {
    async function storeWith(files: Record<string, unknown>): Promise<FileGrantStore> {
      dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
      const grantsPath = grantsDirFor(dir)
      const store = new FileGrantStore(grantsPath)
      for (const [name, body] of Object.entries(files)) await fsPromises.writeFile(join(grantsPath, name), JSON.stringify(body))
      return store
    }
    const base = { subjectKey: "s", recipientAgentId: "a", scope: "identity", grantedAt: "2026-03-14T18:00:00.000Z" }

    it("names a grant by its file, whatever id its contents carry", async () => {
      const store = await storeWith({ "a.json": { ...base, id: "b" } })
      expect((await store.get("a"))?.id).toBe("a")
      expect((await store.listAll()).map((g) => g.id)).toEqual(["a"])
    })

    it("reads any revokedAt as a revocation, and keeps a non-text expiresAt as text", async () => {
      const store = await storeWith({
        "r1.json": { ...base, revokedAt: true },
        "r2.json": { ...base, revokedAt: null },
        "e1.json": { ...base, expiresAt: 1 },
        "e2.json": { ...base, expiresAt: ["2099-01-01"] },
      })
      expect((await store.get("r1"))?.revokedAt).toBe("true")
      expect((await store.get("r2"))?.revokedAt).toBe("null")
      expect((await store.get("e1"))?.expiresAt).toBe("1")
      expect((await store.get("e2"))?.expiresAt).toBe('["2099-01-01"]')
    })

    it("lists no grant from a file whose name isn't a grant id", async () => {
      const store = await storeWith({ ".hidden.json": { ...base, id: "h" }, "ok.json": { ...base, id: "ok" } })
      expect((await store.listAll()).map((g) => g.id)).toEqual(["ok"])
    })
  })
})
