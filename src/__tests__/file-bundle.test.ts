import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { openFileBundle, FileFriendStore, FileGrantStore, grantsDirFor } from "../index"
import type { FileBundle } from "../index"
import type { FriendRecord, ShareGrant } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

function friend(): FriendRecord {
  return {
    id: "f-1",
    name: "Jordan",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [{ provider: "aad", externalId: "aad-1", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  }
}

function grant(): ShareGrant {
  return {
    id: "g-1",
    subjectFriendId: "f-1",
    recipientAgentId: "agent-b",
    scope: "notes:safe",
    grantedAt: NOW,
  }
}

describe("openFileBundle", () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("wires a store + grants rooted at the bundle dir and its sibling _grants/", () => {
    dir = mkdtempSync(join(tmpdir(), "friends-bundle-"))
    const friendsDir = join(dir, "friends")
    const bundle: FileBundle = openFileBundle(friendsDir)

    expect(bundle.store).toBeInstanceOf(FileFriendStore)
    expect(bundle.grants).toBeInstanceOf(FileGrantStore)
    expect(bundle.friendsDir).toBe(friendsDir)
    expect(bundle.grantsDir).toBe(grantsDirFor(friendsDir))
    // Both directories are created on construction.
    expect(existsSync(bundle.friendsDir)).toBe(true)
    expect(existsSync(bundle.grantsDir)).toBe(true)
  })

  it("round-trips a friend through .store and a grant through .grants", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-bundle-"))
    const bundle = openFileBundle(join(dir, "friends"))

    await bundle.store.put("f-1", friend())
    expect((await bundle.store.get("f-1"))?.name).toBe("Jordan")

    await bundle.grants.put("g-1", grant())
    expect((await bundle.grants.get("g-1"))?.scope).toBe("notes:safe")
  })
})
