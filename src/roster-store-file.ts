// FileRosterStore — filesystem adapter for RosterStore.
//
// Stores the account roster and its pinned key as JSON files in a sibling
// `_rosters/` collection next to the friends directory (one `<accountId>.roster.json`
// and one `<accountId>.pin.json` per account). Mirrors FileGrantStore's structure
// (mkdir on construct, one file per record, guarded reads) so the stores feel
// uniform.
import * as fs from "fs"
import * as fsPromises from "fs/promises"
import * as path from "path"
import { emitNervesEvent } from "./observability"
import type { AccountRoster, RosterPin, RosterStore } from "./roster-store"

/** The sibling rosters directory for a given friends directory:
 * `<friendsDir>/_rosters`. A reserved `_`-prefixed subdir (like `_grants`) so one
 * `--dir` still points the whole substrate at one place. */
export function rostersDirFor(friendsDir: string): string {
  return path.join(friendsDir, "_rosters")
}

export class FileRosterStore implements RosterStore {
  private readonly rostersPath: string

  constructor(rostersPath: string) {
    this.rostersPath = rostersPath
    fs.mkdirSync(rostersPath, { recursive: true })
    emitNervesEvent({
      component: "friends",
      event: "friends.roster_store_init",
      message: "file roster store initialized",
      meta: {},
    })
  }

  // Unit 6a stubs: methods throw so the suite fails behaviorally (not on a missing
  // symbol). Implemented GREEN in Unit 6b. `this.rostersPath`/`fsPromises`/`path`
  // are referenced so the field + imports are wired for the real bodies.
  async getRoster(_accountId: string): Promise<AccountRoster | null> {
    void fsPromises
    void path.join(this.rostersPath, "")
    throw new Error("not implemented")
  }

  async putRoster(_roster: AccountRoster): Promise<void> {
    void this.rostersPath
    throw new Error("not implemented")
  }

  async getPin(_accountId: string): Promise<RosterPin | null> {
    void this.rostersPath
    throw new Error("not implemented")
  }

  async putPin(_pin: RosterPin): Promise<void> {
    void this.rostersPath
    throw new Error("not implemented")
  }
}
