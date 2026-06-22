// FileMissionStore — filesystem adapter for MissionStore (brick 3).
// Stores each MissionRecord as one JSON file in a sibling `_missions/` collection
// next to the friends directory. Mirrors FileGrantStore's structure (mkdir on
// construct, one file per record, guarded reads, a `normalize` for round-trip
// discipline) so the three stores feel uniform.

import * as fs from "fs"
import * as fsPromises from "fs/promises"
import * as path from "path"
import { emitNervesEvent } from "./observability"
import type { MissionStore } from "./mission-store"
import type { MissionRecord } from "./types"

/** A mission as it may appear ON DISK: any of its fields may be missing on a
 * malformed/legacy record. `normalize` fills the defaults and always emits a
 * complete MissionRecord. */
type RawMissionRecord = Partial<MissionRecord> & { id: string; missionKey: string }

const MISSION_STATUSES: ReadonlySet<string> = new Set<MissionRecord["status"]>([
  "active",
  "succeeded",
  "partial",
  "failed",
  "abandoned",
])

/** The sibling missions directory for a given friends directory:
 * `<friendsDir>/_missions`. The collection lives UNDER the friends dir (a
 * reserved `_`-prefixed subdir) so a single `--dir` still points the whole
 * substrate at one place. */
export function missionsDirFor(friendsDir: string): string {
  return path.join(friendsDir, "_missions")
}

export class FileMissionStore implements MissionStore {
  private readonly missionsPath: string

  constructor(missionsPath: string) {
    this.missionsPath = missionsPath
    fs.mkdirSync(missionsPath, { recursive: true })
    emitNervesEvent({
      component: "friends",
      event: "friends.mission_store_init",
      message: "file mission store initialized",
      meta: {},
    })
  }

  async get(id: string): Promise<MissionRecord | null> {
    const mission = await this.readJson(path.join(this.missionsPath, `${id}.json`))
    return mission ? this.normalize(mission) : null
  }

  async put(id: string, mission: MissionRecord): Promise<void> {
    await fsPromises.writeFile(
      path.join(this.missionsPath, `${id}.json`),
      JSON.stringify(this.normalize(mission), null, 2),
      "utf-8",
    )
  }

  async delete(id: string): Promise<void> {
    try {
      await fsPromises.unlink(path.join(this.missionsPath, `${id}.json`))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return
      throw err
    }
  }

  async findByMissionKey(missionKey: string): Promise<MissionRecord | null> {
    const all = await this.listAll()
    return all.find((m) => m.missionKey === missionKey) ?? null
  }

  async listAll(): Promise<MissionRecord[]> {
    let entries: string[]
    try {
      entries = await fsPromises.readdir(this.missionsPath)
    } catch {
      /* v8 ignore next -- defensive: dir is mkdir'd in the constructor, so readdir
         only throws if it's deleted mid-run; unreachable through the API @preserve */
      return []
    }

    const missions: MissionRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const raw = await this.readJson(path.join(this.missionsPath, entry))
      if (!raw) continue
      missions.push(this.normalize(raw))
    }
    return missions
  }

  private normalize(raw: RawMissionRecord): MissionRecord {
    return {
      id: raw.id,
      missionKey: raw.missionKey,
      title: typeof raw.title === "string" ? raw.title : raw.missionKey,
      status: typeof raw.status === "string" && MISSION_STATUSES.has(raw.status) ? raw.status : "active",
      participants: Array.isArray(raw.participants) ? raw.participants : [],
      outcomes: Array.isArray(raw.outcomes) ? raw.outcomes : [],
      learnings: raw.learnings && typeof raw.learnings === "object" ? raw.learnings : {},
      ...(raw.importedLearnings && typeof raw.importedLearnings === "object" ? { importedLearnings: raw.importedLearnings } : {}),
      // The coordination sub-object (brick 5) passes through like importedLearnings:
      // present iff the record carries one, so a legacy mission with no coordination
      // round-trips unchanged (absent ⇒ unclaimed).
      ...(raw.coordination && typeof raw.coordination === "object" ? { coordination: raw.coordination } : {}),
      // The delegation/result namespaces (gap-1 + gap-2, p11 inc2) pass through the same
      // way: present iff the record carries one, so a legacy mission round-trips unchanged
      // (absent ⇒ none). Without these, a FILE-backed store would silently drop them,
      // breaking the result-return correlation (which reads first-party `delegations`).
      ...(raw.delegations && typeof raw.delegations === "object" ? { delegations: raw.delegations } : {}),
      ...(raw.importedDelegations && typeof raw.importedDelegations === "object" ? { importedDelegations: raw.importedDelegations } : {}),
      ...(raw.results && typeof raw.results === "object" ? { results: raw.results } : {}),
      ...(raw.importedResults && typeof raw.importedResults === "object" ? { importedResults: raw.importedResults } : {}),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
    }
  }

  private async readJson(filePath: string): Promise<RawMissionRecord | null> {
    try {
      const raw = await fsPromises.readFile(filePath, "utf-8")
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return null
        }
        return parsed as RawMissionRecord
      } catch {
        return null
      }
    } catch {
      return null
    }
  }
}
