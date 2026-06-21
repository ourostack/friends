import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { FileFriendStore } from "../index"
import type { FriendRecord, RelationshipOutcome, NoteProvenance } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

// A NoteProvenance value, typed via the new public export. If `NoteProvenance`
// is not yet exported, this import is a type-only reference; the runtime proof
// that the field is wired is the round-trip + field-read assertions below.
const provenance: NoteProvenance = {
  assertedBy: { agentId: "a1", agentName: "Agent One" },
}

function makeRecord(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "uuid-prov",
    name: "Provenance Person",
    externalIds: [
      { provider: "local", externalId: "prov@example.com", linkedAt: NOW },
    ],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

describe("note value provenance (additive type)", () => {
  it("a note value carries an optional provenance with assertedBy attribution", () => {
    const record = makeRecord({
      notes: {
        role: { value: "PM", savedAt: NOW, provenance },
      },
    })
    expect(record.notes.role.provenance).toBeDefined()
    expect(record.notes.role.provenance?.assertedBy?.agentId).toBe("a1")
    expect(record.notes.role.provenance?.assertedBy?.agentName).toBe("Agent One")
  })

  it("a note value with no provenance is still valid (backward compatible)", () => {
    const record = makeRecord({
      notes: {
        role: { value: "PM", savedAt: NOW },
      },
    })
    expect(record.notes.role.provenance).toBeUndefined()
  })
})

describe("RelationshipOutcome provenance (additive type)", () => {
  it("an outcome carries an optional provenance", () => {
    const outcome: RelationshipOutcome = {
      missionId: "m1",
      result: "success",
      timestamp: NOW,
      note: "went well",
      provenance,
    }
    expect(outcome.provenance?.assertedBy?.agentId).toBe("a1")
  })

  it("an outcome with no provenance is still valid (backward compatible)", () => {
    const outcome: RelationshipOutcome = {
      missionId: "m1",
      result: "success",
      timestamp: NOW,
    }
    expect(outcome.provenance).toBeUndefined()
  })
})

describe("provenance round-trips through FileFriendStore", () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("persists note provenance to disk and reads it back unchanged", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-prov-"))
    const store = new FileFriendStore(join(dir, "friends"))
    await store.put(
      "uuid-prov",
      makeRecord({
        notes: { role: { value: "PM", savedAt: NOW, provenance } },
      }),
    )
    const reloaded = await store.findByExternalId("local", "prov@example.com")
    expect(reloaded?.notes.role.provenance?.assertedBy?.agentId).toBe("a1")
    expect(reloaded?.notes.role.provenance?.assertedBy?.agentName).toBe("Agent One")
  })
})
