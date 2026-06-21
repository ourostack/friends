// applyFriendNote — structured-result port of the harness's `save_friend_note`.
//
// Writes a friend's name, a tool preference, or a general note. Returns a
// FriendOpResult instead of the harness's English strings so the MCP layer can
// serialize and branch on the outcome. The override-conflict case stays
// distinguishable (`status: "override_required"`, `ok: false`) from a real
// write, and a missing friend is a normal `not_found` result — never a throw.
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { FriendRecord, NoteProvenance } from "./types"
import type { FriendOpResult } from "./results"

export interface ApplyFriendNoteInput {
  type: "name" | "tool_preference" | "note"
  key?: string
  content: string
  override?: boolean
  provenance?: NoteProvenance
}

export async function applyFriendNote(
  store: FriendStore,
  friendId: string,
  input: ApplyFriendNoteInput,
): Promise<FriendOpResult> {
  emitNervesEvent({
    component: "friends",
    event: "friends.note_applied",
    message: "applied friend note",
    meta: { type: input.type },
  })

  const { type, key, content, override, provenance } = input

  // Validate inputs up front so the helper is self-contained (the harness
  // returned English here; we return a structured `invalid` result).
  if (!content) {
    return { ok: false, status: "invalid", message: "a content value is required" }
  }
  if ((type === "tool_preference" || type === "note") && !key) {
    return { ok: false, status: "invalid", message: "a key is required for tool_preference or note" }
  }

  try {
    const record = await store.get(friendId)
    if (!record) {
      return { ok: false, status: "not_found", message: "friend record not found" }
    }
    const now = new Date().toISOString()

    if (type === "name") {
      const updated: FriendRecord = { ...record, name: content, updatedAt: now }
      await store.put(friendId, updated)
      return { ok: true, status: "saved", record: updated }
    }

    if (type === "tool_preference") {
      const existing = record.toolPreferences[key!]
      if (existing && !override) {
        return {
          ok: false,
          status: "override_required",
          message: `a tool preference already exists for '${key}': "${existing}"`,
        }
      }
      const updated: FriendRecord = {
        ...record,
        toolPreferences: { ...record.toolPreferences, [key!]: content },
        updatedAt: now,
      }
      await store.put(friendId, updated)
      return { ok: true, status: "saved", record: updated }
    }

    // type === "note"
    // Redirect a "name" key to the name field rather than storing it as a note.
    if (key === "name") {
      const updated: FriendRecord = { ...record, name: content, updatedAt: now }
      await store.put(friendId, updated)
      return { ok: true, status: "redirected_to_name", record: updated }
    }

    const existing = record.notes[key!]
    if (existing && !override) {
      return {
        ok: false,
        status: "override_required",
        message: `a note already exists for '${key}': "${existing.value}"`,
      }
    }
    const updated: FriendRecord = {
      ...record,
      notes: {
        ...record.notes,
        [key!]: { value: content, savedAt: now, ...(provenance ? { provenance } : {}) },
      },
      updatedAt: now,
    }
    await store.put(friendId, updated)
    return { ok: true, status: "saved", record: updated }
  } catch (err) {
    return {
      ok: false,
      status: "error",
      /* v8 ignore next -- defensive: non-Error throw is unreachable in tests; we inject an Error @preserve */
      message: err instanceof Error ? err.message : String(err),
    }
  }
}
