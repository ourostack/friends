import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { applyFriendNote, FileFriendStore } from "../index"
import type { FriendStore, FriendRecord, IdentityProvider, NoteProvenance } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

class MemoryStore implements FriendStore {
  readonly records = new Map<string, FriendRecord>()
  putCalls = 0
  constructor(initial: FriendRecord[] = []) {
    for (const f of initial) this.records.set(f.id, f)
  }
  async get(id: string) {
    return this.records.get(id) ?? null
  }
  async put(id: string, record: FriendRecord) {
    this.putCalls += 1
    this.records.set(id, record)
  }
  async delete(id: string) {
    this.records.delete(id)
  }
  async findByExternalId(provider: string, externalId: string, tenantId?: string) {
    for (const r of this.records.values()) {
      if (
        r.externalIds.find(
          (e) => e.provider === provider && e.externalId === externalId && e.tenantId === tenantId,
        )
      ) {
        return r
      }
    }
    return null
  }
  async hasAnyFriends() {
    return this.records.size > 0
  }
  async listAll() {
    return Array.from(this.records.values())
  }
}

function friend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "f-1",
    name: "Person",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [{ provider: "aad" as IdentityProvider, externalId: "x1", linkedAt: NOW }],
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

const provenance: NoteProvenance = { assertedBy: { agentId: "a1", agentName: "Agent" } }

describe("applyFriendNote — name", () => {
  it("sets the record name and reports saved", async () => {
    const store = new MemoryStore([friend()])
    const result = await applyFriendNote(store, "f-1", { type: "name", content: "Renamed" })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("saved")
    expect(result.record?.name).toBe("Renamed")
    const stored = await store.get("f-1")
    expect(stored?.name).toBe("Renamed")
    expect(stored?.updatedAt).not.toBe(NOW)
  })
})

describe("applyFriendNote — tool_preference", () => {
  it("sets a new tool preference", async () => {
    const store = new MemoryStore([friend()])
    const result = await applyFriendNote(store, "f-1", {
      type: "tool_preference",
      key: "ado",
      content: "use board X",
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("saved")
    expect((await store.get("f-1"))?.toolPreferences.ado).toBe("use board X")
  })

  it("blocks overwrite without override and echoes the existing value, leaving the record untouched", async () => {
    const store = new MemoryStore([friend({ toolPreferences: { ado: "existing" } })])
    const result = await applyFriendNote(store, "f-1", {
      type: "tool_preference",
      key: "ado",
      content: "new value",
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("override_required")
    expect(result.message).toContain("existing")
    expect(store.putCalls).toBe(0)
    expect((await store.get("f-1"))?.toolPreferences.ado).toBe("existing")
  })

  it("overwrites with override:true", async () => {
    const store = new MemoryStore([friend({ toolPreferences: { ado: "existing" } })])
    const result = await applyFriendNote(store, "f-1", {
      type: "tool_preference",
      key: "ado",
      content: "new value",
      override: true,
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("saved")
    expect((await store.get("f-1"))?.toolPreferences.ado).toBe("new value")
  })
})

describe("applyFriendNote — note", () => {
  it("redirects a note with key 'name' to the name field, not notes", async () => {
    const store = new MemoryStore([friend()])
    const result = await applyFriendNote(store, "f-1", {
      type: "note",
      key: "name",
      content: "New Name",
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("redirected_to_name")
    const stored = await store.get("f-1")
    expect(stored?.name).toBe("New Name")
    expect(stored?.notes.name).toBeUndefined()
  })

  it("sets a new note value", async () => {
    const store = new MemoryStore([friend()])
    const result = await applyFriendNote(store, "f-1", {
      type: "note",
      key: "role",
      content: "PM",
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("saved")
    const stored = await store.get("f-1")
    expect(stored?.notes.role.value).toBe("PM")
    expect(stored?.notes.role.savedAt).toBeTruthy()
    expect(stored?.notes.role.provenance).toBeUndefined()
  })

  it("blocks note overwrite without override, echoing existing value, record unchanged", async () => {
    const store = new MemoryStore([
      friend({ notes: { role: { value: "old role", savedAt: NOW } } }),
    ])
    const result = await applyFriendNote(store, "f-1", {
      type: "note",
      key: "role",
      content: "new role",
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("override_required")
    expect(result.message).toContain("old role")
    expect(store.putCalls).toBe(0)
    expect((await store.get("f-1"))?.notes.role.value).toBe("old role")
  })

  it("overwrites a note with override:true", async () => {
    const store = new MemoryStore([
      friend({ notes: { role: { value: "old role", savedAt: NOW } } }),
    ])
    const result = await applyFriendNote(store, "f-1", {
      type: "note",
      key: "role",
      content: "new role",
      override: true,
    })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("saved")
    expect((await store.get("f-1"))?.notes.role.value).toBe("new role")
  })

  it("persists provenance on a note value", async () => {
    const store = new MemoryStore([friend()])
    const result = await applyFriendNote(store, "f-1", {
      type: "note",
      key: "role",
      content: "PM",
      provenance,
    })
    expect(result.ok).toBe(true)
    expect((await store.get("f-1"))?.notes.role.provenance?.assertedBy?.agentId).toBe("a1")
  })
})

describe("applyFriendNote — not found and validation", () => {
  it("returns not_found (no throw) when the friend is missing", async () => {
    const store = new MemoryStore()
    const result = await applyFriendNote(store, "missing", { type: "name", content: "x" })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("not_found")
  })

  it("returns invalid when content is missing", async () => {
    const store = new MemoryStore([friend()])
    const result = await applyFriendNote(store, "f-1", { type: "name", content: "" })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("invalid")
    expect(store.putCalls).toBe(0)
  })

  it("returns invalid when tool_preference is missing a key", async () => {
    const store = new MemoryStore([friend()])
    const result = await applyFriendNote(store, "f-1", { type: "tool_preference", content: "v" })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("invalid")
  })

  it("returns invalid when note is missing a key", async () => {
    const store = new MemoryStore([friend()])
    const result = await applyFriendNote(store, "f-1", { type: "note", content: "v" })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("invalid")
  })
})

describe("applyFriendNote — defensive catch", () => {
  it("returns an error result when the store put throws", async () => {
    const store = new MemoryStore([friend()])
    store.put = async () => {
      throw new Error("disk exploded")
    }
    const result = await applyFriendNote(store, "f-1", { type: "name", content: "x" })
    expect(result.ok).toBe(false)
    expect(result.status).toBe("error")
    expect(result.message).toContain("disk exploded")
  })
})

describe("applyFriendNote — FileFriendStore end-to-end", () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("saves a note (with provenance) and reloads it from disk", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-notes-"))
    const store = new FileFriendStore(join(dir, "friends"))
    await store.put("f-1", friend())
    const result = await applyFriendNote(store, "f-1", {
      type: "note",
      key: "role",
      content: "PM",
      provenance,
    })
    expect(result.ok).toBe(true)
    const reloaded = await store.findByExternalId("aad", "x1")
    expect(reloaded?.notes.role.value).toBe("PM")
    expect(reloaded?.notes.role.provenance?.assertedBy?.agentId).toBe("a1")
  })
})
