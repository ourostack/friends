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

  async getRoster(accountId: string): Promise<AccountRoster | null> {
    const raw = await this.readJson(path.join(this.rostersPath, `${accountId}.roster.json`))
    return raw as AccountRoster | null
  }

  async putRoster(roster: AccountRoster): Promise<void> {
    await fsPromises.writeFile(
      path.join(this.rostersPath, `${roster.accountId}.roster.json`),
      JSON.stringify(roster, null, 2),
      "utf-8",
    )
  }

  async getPin(accountId: string): Promise<RosterPin | null> {
    const raw = await this.readJson(path.join(this.rostersPath, `${accountId}.pin.json`))
    return raw as RosterPin | null
  }

  async putPin(pin: RosterPin): Promise<void> {
    await fsPromises.writeFile(
      path.join(this.rostersPath, `${pin.accountId}.pin.json`),
      JSON.stringify(pin, null, 2),
      "utf-8",
    )
  }

  /** Read + parse a JSON file, returning null on a missing file, invalid JSON, or a
   * non-object payload (guarded; mirrors FileGrantStore.readJson). */
  private async readJson(filePath: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = await fsPromises.readFile(filePath, "utf-8")
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
        return parsed as Record<string, unknown>
      } catch {
        return null
      }
    } catch {
      return null
    }
  }
}
