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
import { isSafeRecordId } from "./util/safe-id"

/** A grant as it may appear ON DISK: a current `ShareGrant` whose `subjectKey`
 * may instead be the legacy `subjectFriendId` (Fork D). `normalize` reads both
 * and always emits a current `ShareGrant` with `subjectKey`. */
type LegacyShareGrant = Omit<ShareGrant, "subjectKey"> & {
  subjectKey?: string
  /** Pre-Fork-D field name; schemaVersion-1 grants carry this. */
  subjectFriendId?: string
}

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
    // An id that would leave the grants directory names no grant (#222).
    if (!isSafeRecordId(id)) return null
    const grant = await this.readJson(path.join(this.grantsPath, `${id}.json`))
    return grant ? this.normalize(grant, id) : null
  }

  async put(id: string, grant: ShareGrant): Promise<void> {
    if (!isSafeRecordId(id)) throw new Error("grant id is invalid")
    if (!isShareScope(grant.scope)) throw new Error("grant scope is invalid")
    await fsPromises.writeFile(
      path.join(this.grantsPath, `${id}.json`),
      JSON.stringify(this.normalize(grant, id)!, null, 2),
      "utf-8",
    )
  }

  async delete(id: string): Promise<void> {
    if (!isSafeRecordId(id)) throw new Error("grant id is invalid")
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
      const id = entry.slice(0, -".json".length)
      // A file whose name isn't a grant id is no grant: revoke_share could never reach it.
      if (!entry.endsWith(".json") || !isSafeRecordId(id)) continue
      const raw = await this.readJson(path.join(this.grantsPath, entry))
      if (!raw) continue
      const grant = this.normalize(raw, id)
      if (grant) grants.push(grant)
    }
    return grants
  }

  /** A current ShareGrant from what is on disk, named by its file, or null when its scope isn't one friends knows.
   * Damage reads as less consent, never more (#222): a corrupt scope is no grant, any revokedAt at all is a
   * revocation, and an expiresAt is kept as text even when it isn't one, so isGrantEffective refuses it. */
  private normalize(raw: LegacyShareGrant, id: string): ShareGrant | null {
    if (!isShareScope(raw.scope)) return null
    const revokedAt = raw.revokedAt as unknown
    const expiresAt = raw.expiresAt as unknown
    return {
      id,
      // Fork D compat seam (a): on-disk schemaVersion-1 grants carry the legacy
      // `subjectFriendId`; newer ones carry `subjectKey`. Read both, persist
      // forward as `subjectKey` so the legacy field migrates on the next write.
      subjectKey: raw.subjectKey ?? raw.subjectFriendId ?? "",
      recipientAgentId: raw.recipientAgentId,
      scope: raw.scope,
      grantedAt: typeof raw.grantedAt === "string" ? raw.grantedAt : new Date().toISOString(),
      ...(expiresAt !== undefined ? { expiresAt: typeof expiresAt === "string" ? expiresAt : JSON.stringify(expiresAt) } : {}),
      ...(revokedAt !== undefined ? { revokedAt: String(revokedAt) } : {}),
    }
  }

  private async readJson(filePath: string): Promise<LegacyShareGrant | null> {
    try {
      const raw = await fsPromises.readFile(filePath, "utf-8")
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return null
        }
        return parsed as LegacyShareGrant
      } catch {
        return null
      }
    } catch {
      return null
    }
  }
}
