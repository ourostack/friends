import { describe, it, expect } from "vitest"

import { recordMission } from "../index"
import type { MissionStore, MissionRecord } from "../index"

/** In-file MissionStore fake (the project's in-file-fake idiom). */
class MemoryMissionStore implements MissionStore {
  readonly missions = new Map<string, MissionRecord>()
  putCalls = 0
  constructor(initial: MissionRecord[] = []) {
    for (const m of initial) this.missions.set(m.id, m)
  }
  async get(id: string) {
    return this.missions.get(id) ?? null
  }
  async put(id: string, mission: MissionRecord) {
    this.putCalls += 1
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

const NOW = "2026-03-14T18:00:00.000Z"

function existing(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: "m-existing",
    missionKey: "PROJ-1234",
    title: "Original title",
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("recordMission — create (unknown missionKey)", () => {
  it("creates a fresh MissionRecord with a UUID id, timestamps, schemaVersion 1, default status active", async () => {
    const missions = new MemoryMissionStore()
    const record = await recordMission(missions, { missionKey: "PROJ-1234" })
    expect(record.id).toMatch(UUID_RE)
    expect(record.missionKey).toBe("PROJ-1234")
    expect(record.status).toBe("active")
    expect(record.schemaVersion).toBe(1)
    expect(record.createdAt).toBeTruthy()
    expect(record.updatedAt).toBeTruthy()
    expect(record.learnings).toEqual({})
    expect(record.importedLearnings).toEqual({})
    expect(record.outcomes).toEqual([])
    expect(record.participants).toEqual([])
    // It persisted under its own id.
    expect((await missions.get(record.id))?.missionKey).toBe("PROJ-1234")
    expect(missions.putCalls).toBe(1)
  })

  it("defaults title to the missionKey when omitted, honors an explicit title", async () => {
    const missions = new MemoryMissionStore()
    const defaulted = await recordMission(missions, { missionKey: "repo#42" })
    expect(defaulted.title).toBe("repo#42")
    const titled = await recordMission(new MemoryMissionStore(), { missionKey: "repo#42", title: "Fix the bug" })
    expect(titled.title).toBe("Fix the bug")
  })

  it("applies an explicit status on create", async () => {
    const missions = new MemoryMissionStore()
    const record = await recordMission(missions, { missionKey: "K", status: "succeeded" })
    expect(record.status).toBe("succeeded")
  })

  it("applies first-party learnings into `learnings` (stamped savedAt + first_party provenance + shareable)", async () => {
    const missions = new MemoryMissionStore()
    const record = await recordMission(missions, {
      missionKey: "K",
      learnings: [
        { key: "gotcha", value: "rebase not merge", shareable: true },
        { key: "secret", value: "private detail" },
      ],
    })
    expect(record.learnings.gotcha.value).toBe("rebase not merge")
    expect(record.learnings.gotcha.shareable).toBe(true)
    expect(record.learnings.gotcha.savedAt).toBeTruthy()
    expect(record.learnings.gotcha.provenance?.origin).toBe("first_party")
    // shareable defaults to false (private-by-default) when omitted.
    expect(record.learnings.secret.shareable).toBe(false)
    // First-party learnings are NEVER written to importedLearnings.
    expect(record.importedLearnings).toEqual({})
  })

  it("applies participants and outcomes on create (outcomes stamped timestamp, no imported origin)", async () => {
    const missions = new MemoryMissionStore()
    const record = await recordMission(missions, {
      missionKey: "K",
      participants: [{ agentId: "agent-a" }, { agentId: "agent-b", agentName: "B" }],
      outcomes: [{ missionId: "ext-mission", result: "success", note: "done" }],
    })
    expect(record.participants.map((p) => p.agentId)).toEqual(["agent-a", "agent-b"])
    expect(record.outcomes).toHaveLength(1)
    expect(record.outcomes[0].result).toBe("success")
    expect(record.outcomes[0].note).toBe("done")
    expect(record.outcomes[0].timestamp).toBeTruthy()
    // A first-party outcome carries no imported provenance.
    expect(record.outcomes[0].provenance?.origin).not.toBe("imported")
  })
})

describe("recordMission — upsert (existing missionKey resolved via findByMissionKey)", () => {
  it("resolves the existing mission by key and keeps its id (no new record)", async () => {
    const missions = new MemoryMissionStore([existing()])
    const record = await recordMission(missions, { missionKey: "PROJ-1234", learnings: [{ key: "k", value: "v" }] })
    expect(record.id).toBe("m-existing")
    expect(missions.missions.size).toBe(1)
  })

  it("ignores `title` on upsert of an existing mission", async () => {
    const missions = new MemoryMissionStore([existing({ title: "Original title" })])
    const record = await recordMission(missions, { missionKey: "PROJ-1234", title: "Renamed (ignored)" })
    expect(record.title).toBe("Original title")
  })

  it("appends first-party learnings into `learnings`, never importedLearnings", async () => {
    const missions = new MemoryMissionStore([
      existing({ learnings: { old: { value: "OLD", savedAt: NOW, provenance: { origin: "first_party" } } } }),
    ])
    const record = await recordMission(missions, { missionKey: "PROJ-1234", learnings: [{ key: "new", value: "NEW" }] })
    expect(record.learnings.old.value).toBe("OLD")
    expect(record.learnings.new.value).toBe("NEW")
    expect(record.importedLearnings ?? {}).toEqual({})
  })

  it("merges participants, deduped by agentId (hit + miss)", async () => {
    const missions = new MemoryMissionStore([existing({ participants: [{ agentId: "agent-a" }] })])
    const record = await recordMission(missions, {
      missionKey: "PROJ-1234",
      participants: [{ agentId: "agent-a" }, { agentId: "agent-b" }], // agent-a is a dup
    })
    expect(record.participants.map((p) => p.agentId).sort()).toEqual(["agent-a", "agent-b"])
  })

  it("appends outcomes to the existing list", async () => {
    const missions = new MemoryMissionStore([
      existing({ outcomes: [{ missionId: "m0", result: "partial", timestamp: NOW }] }),
    ])
    const record = await recordMission(missions, {
      missionKey: "PROJ-1234",
      outcomes: [{ missionId: "m1", result: "success" }],
    })
    expect(record.outcomes.map((o) => o.missionId)).toEqual(["m0", "m1"])
  })

  it("updates status when provided, leaves it when omitted", async () => {
    const missions = new MemoryMissionStore([existing({ status: "active" })])
    const updated = await recordMission(missions, { missionKey: "PROJ-1234", status: "succeeded" })
    expect(updated.status).toBe("succeeded")

    const missions2 = new MemoryMissionStore([existing({ status: "partial" })])
    const unchanged = await recordMission(missions2, { missionKey: "PROJ-1234", learnings: [{ key: "k", value: "v" }] })
    expect(unchanged.status).toBe("partial")
  })

  it("bumps updatedAt and returns the persisted record", async () => {
    const missions = new MemoryMissionStore([existing({ updatedAt: "2020-01-01T00:00:00.000Z" })])
    const record = await recordMission(missions, { missionKey: "PROJ-1234", learnings: [{ key: "k", value: "v" }] })
    expect(record.updatedAt).not.toBe("2020-01-01T00:00:00.000Z")
    expect(await missions.get("m-existing")).toEqual(record)
  })

  it("an upsert with no optional fields just bumps updatedAt (every optional-field-absent branch)", async () => {
    const missions = new MemoryMissionStore([existing({ updatedAt: "2020-01-01T00:00:00.000Z" })])
    const record = await recordMission(missions, { missionKey: "PROJ-1234" })
    expect(record.id).toBe("m-existing")
    expect(record.learnings).toEqual({})
    expect(record.participants).toEqual([{ agentId: "agent-a" }])
    expect(record.outcomes).toEqual([])
    expect(record.updatedAt).not.toBe("2020-01-01T00:00:00.000Z")
  })
})
