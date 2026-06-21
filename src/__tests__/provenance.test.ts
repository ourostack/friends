import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { FileFriendStore } from "../index"
import type { FriendRecord, RelationshipOutcome, NoteProvenance, ImportedNote } from "../index"

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

describe("N10 data-model additions (provenance origin, shareable, importedNotes)", () => {
  it("a note provenance carries an optional origin + importedAt; absent origin is first-party by convention", () => {
    const imported: NoteProvenance = { origin: "imported", importedAt: NOW, assertedBy: { agentId: "a1" } }
    expect(imported.origin).toBe("imported")
    expect(imported.importedAt).toBe(NOW)
    // A first-party provenance simply omits origin (treated as first_party).
    const firstParty: NoteProvenance = { assertedBy: { agentId: "self" } }
    expect(firstParty.origin).toBeUndefined()
  })

  it("a note value carries an optional shareable flag (default-false private-by-default)", () => {
    const record = makeRecord({
      notes: {
        pub: { value: "ok to share", savedAt: NOW, shareable: true },
        priv: { value: "private", savedAt: NOW },
      },
    })
    expect(record.notes.pub.shareable).toBe(true)
    expect(record.notes.priv.shareable).toBeUndefined()
  })

  it("an ImportedNote models a fact from another agent's share", () => {
    const note: ImportedNote = {
      value: "from peer",
      importedAt: NOW,
      assertedBy: { agentId: "peer" },
      originallyAssertedBy: { agentId: "origin" },
    }
    expect(note.value).toBe("from peer")
    expect(note.originallyAssertedBy?.agentId).toBe("origin")
  })

  it("round-trips importedNotes and the shareable flag through FileFriendStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-imported-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      await store.put(
        "uuid-prov",
        makeRecord({
          notes: { role: { value: "PM", savedAt: NOW, shareable: true } },
          importedNotes: {
            "peer-agent": {
              city: { value: "Seattle", importedAt: NOW, assertedBy: { agentId: "peer-agent" } },
            },
          },
        }),
      )
      const reloaded = await store.findByExternalId("local", "prov@example.com")
      expect(reloaded?.notes.role.shareable).toBe(true)
      expect(reloaded?.importedNotes?.["peer-agent"].city.value).toBe("Seattle")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a record that never imported anything has no importedNotes after a round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-noimport-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      await store.put("uuid-prov", makeRecord())
      const reloaded = await store.findByExternalId("local", "prov@example.com")
      expect(reloaded?.importedNotes).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
