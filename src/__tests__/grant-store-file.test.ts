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

  it("normalizes an unknown scope to identity and fills a missing grantedAt", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-grants-"))
    const grantsPath = grantsDirFor(dir)
    new FileGrantStore(grantsPath)
    // Hand-write a grant with a bogus scope and no grantedAt.
    await fsPromises.writeFile(
      join(grantsPath, "g-x.json"),
      JSON.stringify({ id: "g-x", subjectFriendId: "f", recipientAgentId: "a", scope: "bogus" }),
      "utf-8",
    )
    const store = new FileGrantStore(grantsPath)
    const loaded = await store.get("g-x")
    expect(loaded?.scope).toBe("identity")
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
    // Point delete at a path whose parent is a file → unlink yields ENOTDIR, not ENOENT.
    const blocker = join(grantsDirFor(dir), "blocker.json")
    await store.put("blocker", grant({ id: "blocker" }))
    await expect(
      // id with a path separator forces unlink under a non-dir segment
      store.delete(join("blocker.json", "child")),
    ).rejects.toThrow()
  })
})
