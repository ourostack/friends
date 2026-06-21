// Mission store abstraction (brick 3).
// MissionRecord state persists through MissionStore — a sibling to FriendStore /
// GrantStore, mirroring their shape. A mission is many-to-many with peers and has
// its own identity/lifecycle, so it lives in its own collection rather than on a
// friend record. Adds `findByMissionKey` (the cross-agent join-key lookup the
// consumer resolves on) over the get/put/delete/listAll quartet. No mission
// module imports `fs` directly except the FileMissionStore adapter.

import type { MissionRecord } from "./types"

// Domain-specific store for mission records.
export interface MissionStore {
  get(id: string): Promise<MissionRecord | null>
  put(id: string, mission: MissionRecord): Promise<void>
  delete(id: string): Promise<void>
  /** Resolve a mission by its cross-agent join key (the name on the wire), not
   * the local UUID. Returns null when no mission carries that key. */
  findByMissionKey(missionKey: string): Promise<MissionRecord | null>
  listAll(): Promise<MissionRecord[]>
}
