import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { openFileBundle, FileFriendStore, FileGrantStore, FileMissionStore, FileAuditSink, grantsDirFor, missionsDirFor, auditPathFor } from "../index"
import type { FileBundle } from "../index"
import type { FriendRecord, ShareGrant, MissionRecord } from "../index"

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
    subjectKey: "f-1",
    recipientAgentId: "agent-b",
    scope: "notes:safe",
    grantedAt: NOW,
  }
}

function mission(): MissionRecord {
  return {
    id: "m-1",
    missionKey: "PROJ-1234",
    title: "Ship it",
    status: "active",
    participants: [],
    outcomes: [],
    learnings: {},
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  }
}

describe("openFileBundle", () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("wires a store + grants + missions rooted at the bundle dir and its sibling _grants/ + _missions/", () => {
    dir = mkdtempSync(join(tmpdir(), "friends-bundle-"))
    const friendsDir = join(dir, "friends")
    const bundle: FileBundle = openFileBundle(friendsDir)

    expect(bundle.store).toBeInstanceOf(FileFriendStore)
    expect(bundle.grants).toBeInstanceOf(FileGrantStore)
    expect(bundle.missions).toBeInstanceOf(FileMissionStore)
    // finding 3: the bundle also wires the control-plane audit sink so the live MCP
    // path can write Bug B records end-to-end.
    expect(bundle.audit).toBeInstanceOf(FileAuditSink)
    expect(bundle.friendsDir).toBe(friendsDir)
    expect(bundle.grantsDir).toBe(grantsDirFor(friendsDir))
    expect(bundle.missionsDir).toBe(missionsDirFor(friendsDir))
    expect(bundle.auditPath).toBe(auditPathFor(friendsDir))
    // All directories are created on construction (the audit sink mkdirs _audit/).
    expect(existsSync(bundle.friendsDir)).toBe(true)
    expect(existsSync(bundle.grantsDir)).toBe(true)
    expect(existsSync(bundle.missionsDir)).toBe(true)
    expect(existsSync(join(friendsDir, "_audit"))).toBe(true)
  })

  it("round-trips a friend through .store, a grant through .grants, a mission through .missions", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-bundle-"))
    const bundle = openFileBundle(join(dir, "friends"))

    await bundle.store.put("f-1", friend())
    expect((await bundle.store.get("f-1"))?.name).toBe("Jordan")

    await bundle.grants.put("g-1", grant())
    expect((await bundle.grants.get("g-1"))?.scope).toBe("notes:safe")

    await bundle.missions.put("m-1", mission())
    expect((await bundle.missions.get("m-1"))?.missionKey).toBe("PROJ-1234")
  })
})
