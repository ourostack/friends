// FileGrantStore — filesystem adapter for GrantStore.
// Stores each ShareGrant as one JSON file in a sibling `_grants/` collection next
// to the friends directory. Mirrors FileFriendStore's structure (mkdir on
// construct, one file per record, guarded reads) so the two stores feel uniform.

import * as fs from "fs"
import * as fsPromises from "fs/promises"
import * as path from "path"
import { emitNervesEvent } from "./observability"
import type { GrantStore } from "./grant-store"
import type { ShareGrant } from "./types"
import { isShareScope } from "./types"

/** The sibling grants directory for a given friends directory: `<friendsDir>/_grants`.
 * The collection lives UNDER the friends dir (a reserved `_`-prefixed subdir) so a
 * single `--dir` still points the whole substrate at one place. */
export function grantsDirFor(friendsDir: string): string {
  return path.join(friendsDir, "_grants")
}

export class FileGrantStore implements GrantStore {
  private readonly grantsPath: string

  constructor(grantsPath: string) {
    this.grantsPath = grantsPath
    fs.mkdirSync(grantsPath, { recursive: true })
    emitNervesEvent({
      component: "friends",
      event: "friends.grant_store_init",
      message: "file grant store initialized",
      meta: {},
    })
  }

  async get(id: string): Promise<ShareGrant | null> {
    const grant = await this.readJson(path.join(this.grantsPath, `${id}.json`))
    return grant ? this.normalize(grant) : null
  }

  async put(id: string, grant: ShareGrant): Promise<void> {
    await fsPromises.writeFile(
      path.join(this.grantsPath, `${id}.json`),
      JSON.stringify(this.normalize(grant), null, 2),
      "utf-8",
    )
  }

  async delete(id: string): Promise<void> {
    try {
      await fsPromises.unlink(path.join(this.grantsPath, `${id}.json`))
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return
      throw err
    }
  }

  async listAll(): Promise<ShareGrant[]> {
    let entries: string[]
    try {
      entries = await fsPromises.readdir(this.grantsPath)
    } catch {
      /* v8 ignore next -- defensive: dir is mkdir'd in the constructor, so readdir
         only throws if it's deleted mid-run; unreachable through the API @preserve */
      return []
    }

    const grants: ShareGrant[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const raw = await this.readJson(path.join(this.grantsPath, entry))
      if (!raw) continue
      grants.push(this.normalize(raw))
    }
    return grants
  }

  private normalize(raw: ShareGrant): ShareGrant {
    return {
      id: raw.id,
      subjectFriendId: raw.subjectFriendId,
      recipientAgentId: raw.recipientAgentId,
      scope: isShareScope(raw.scope) ? raw.scope : "identity",
      grantedAt: typeof raw.grantedAt === "string" ? raw.grantedAt : new Date().toISOString(),
      ...(typeof raw.expiresAt === "string" ? { expiresAt: raw.expiresAt } : {}),
      ...(typeof raw.revokedAt === "string" ? { revokedAt: raw.revokedAt } : {}),
    }
  }

  private async readJson(filePath: string): Promise<ShareGrant | null> {
    try {
      const raw = await fsPromises.readFile(filePath, "utf-8")
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return null
        }
        return parsed as ShareGrant
      } catch {
        return null
      }
    } catch {
      return null
    }
  }
}
