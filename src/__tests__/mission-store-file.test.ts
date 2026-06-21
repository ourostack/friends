import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import * as fsPromises from "fs/promises"

import { FileMissionStore, missionsDirFor } from "../index"
import type { MissionRecord, MissionStore } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

/** In-file MissionStore fake, mirroring the MemoryGrantStore/MemoryStore idiom:
 * a public Map, constructor `initial: T[] = []`, `?? null` on misses,
 * `Array.from(map.values())` for listAll, a `findByMissionKey` scan. Re-declared
 * in each test file that needs it (the project's in-file-fake convention). */
export class MemoryMissionStore implements MissionStore {
  readonly missions = new Map<string, MissionRecord>()
  constructor(initial: MissionRecord[] = []) {
    for (const m of initial) this.missions.set(m.id, m)
  }
  async get(id: string) {
    return this.missions.get(id) ?? null
  }
  async put(id: string, mission: MissionRecord) {
    this.missions.set(id, mission)
  }
  async delete(id: string) {
    this.missions.delete(id)
  }
  async findByMissionKey(missionKey: string) {
    for (const m of this.missions.values()) {
      if (m.missionKey === missionKey) return m
    }
    return null
  }
  async listAll() {
    return Array.from(this.missions.values())
  }
}

function mission(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: "m-1",
    missionKey: "PROJ-1234",
    title: "Ship the ledger",
    status: "active",
    participants: [{ agentId: "agent-a" }],
    outcomes: [],
    learnings: {},
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

describe("missionsDirFor", () => {
  it("returns the sibling _missions dir under the friends dir", () => {
    expect(missionsDirFor("/bundle/friends")).toBe(join("/bundle/friends", "_missions"))
  })
})

describe("FileMissionStore", () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("mkdirs the missions dir on construction", () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const missionsPath = join(dir, "_missions")
    new FileMissionStore(missionsPath)
    expect(existsSync(missionsPath)).toBe(true)
  })

  it("put then get round-trips a mission (one JSON per mission, filename <id>.json)", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const missionsPath = missionsDirFor(dir)
    const store = new FileMissionStore(missionsPath)
    await store.put("m-1", mission({ learnings: { gotcha: { value: "rebase", savedAt: NOW } } }))
    const loaded = await store.get("m-1")
    expect(loaded?.id).toBe("m-1")
    expect(loaded?.missionKey).toBe("PROJ-1234")
    expect(loaded?.learnings.gotcha.value).toBe("rebase")
    // The file is named by the record id.
    expect(existsSync(join(missionsPath, "m-1.json"))).toBe(true)
  })

  it("get returns null for a missing mission", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const store = new FileMissionStore(missionsDirFor(dir))
    expect(await store.get("nope")).toBeNull()
  })

  it("listAll returns all missions and ignores non-json files", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const missionsPath = missionsDirFor(dir)
    const store = new FileMissionStore(missionsPath)
    await store.put("m-1", mission({ id: "m-1", missionKey: "K1" }))
    await store.put("m-2", mission({ id: "m-2", missionKey: "K2" }))
    await fsPromises.writeFile(join(missionsPath, "README.txt"), "not a mission", "utf-8")
    const all = await store.listAll()
    expect(all.map((m) => m.id).sort()).toEqual(["m-1", "m-2"])
  })

  it("listAll skips a file that is not a JSON object", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const missionsPath = missionsDirFor(dir)
    const store = new FileMissionStore(missionsPath)
    await store.put("m-1", mission())
    await fsPromises.writeFile(join(missionsPath, "bad.json"), "[1,2,3]", "utf-8")
    await fsPromises.writeFile(join(missionsPath, "broken.json"), "{not json", "utf-8")
    const all = await store.listAll()
    expect(all.map((m) => m.id)).toEqual(["m-1"])
  })

  it("findByMissionKey returns the record whose missionKey matches, and null when none", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const store = new FileMissionStore(missionsDirFor(dir))
    await store.put("m-1", mission({ id: "m-1", missionKey: "PROJ-1234" }))
    await store.put("m-2", mission({ id: "m-2", missionKey: "repo#42" }))
    const found = await store.findByMissionKey("repo#42")
    expect(found?.id).toBe("m-2")
    expect(await store.findByMissionKey("does-not-exist")).toBeNull()
  })

  it("delete removes a mission; deleting a missing mission is a safe noop (ENOENT)", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const store = new FileMissionStore(missionsDirFor(dir))
    await store.put("m-1", mission())
    await store.delete("m-1")
    expect(await store.get("m-1")).toBeNull()
    await expect(store.delete("m-1")).resolves.toBeUndefined()
  })

  it("rethrows a non-ENOENT delete error", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const store = new FileMissionStore(missionsDirFor(dir))
    await store.put("blocker", mission({ id: "blocker" }))
    await expect(store.delete(join("blocker.json", "child"))).rejects.toThrow()
  })

  it("normalize: defaults a missing status to 'active' and a missing schemaVersion to 1", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const missionsPath = missionsDirFor(dir)
    new FileMissionStore(missionsPath)
    // Hand-write a malformed mission missing status + schemaVersion.
    await fsPromises.writeFile(
      join(missionsPath, "m-x.json"),
      JSON.stringify({ id: "m-x", missionKey: "K", title: "T", participants: [], outcomes: [], learnings: {}, createdAt: NOW, updatedAt: NOW }),
      "utf-8",
    )
    const store = new FileMissionStore(missionsPath)
    const loaded = await store.get("m-x")
    expect(loaded?.status).toBe("active")
    expect(loaded?.schemaVersion).toBe(1)
  })

  it("normalize: defaults a missing title to the missionKey and empty collections", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const missionsPath = missionsDirFor(dir)
    new FileMissionStore(missionsPath)
    await fsPromises.writeFile(
      join(missionsPath, "m-y.json"),
      JSON.stringify({ id: "m-y", missionKey: "PROJ-9", createdAt: NOW, updatedAt: NOW }),
      "utf-8",
    )
    const store = new FileMissionStore(missionsPath)
    const loaded = await store.get("m-y")
    expect(loaded?.title).toBe("PROJ-9")
    expect(loaded?.participants).toEqual([])
    expect(loaded?.outcomes).toEqual([])
    expect(loaded?.learnings).toEqual({})
  })

  it("normalize: preserves importedLearnings through a round-trip", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-missions-"))
    const store = new FileMissionStore(missionsDirFor(dir))
    await store.put(
      "m-1",
      mission({ importedLearnings: { "agent-b": { fact: { value: "theirs", importedAt: NOW } } } }),
    )
    const loaded = await store.get("m-1")
    expect(loaded?.importedLearnings?.["agent-b"].fact.value).toBe("theirs")
  })
})
