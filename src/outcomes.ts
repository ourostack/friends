// recordRelationshipOutcome — appends a shared-mission outcome to a friend's
// agentMeta, dedupes the mission into sharedMissions, and bumps familiarity.
//
// D3: if the record has no `agentMeta` (e.g. a human record), it is
// auto-initialized so the helper is usable on any friendId. The record's `kind`
// is intentionally NOT flipped to "agent". CAVEAT: `FileFriendStore.normalize`
// drops `agentMeta` on read when `kind !== "agent"`, so on a human record the
// outcome persists in-process and round-trips through a MemoryStore, but a
// FileFriendStore reload normalizes it away. For an agent record it persists in
// full. Returns the updated record, or null when the friend is missing.
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { AgentMeta, FriendRecord, NoteProvenance, RelationshipOutcome } from "./types"

export interface RecordOutcomeInput {
  missionId: string
  result: "success" | "partial" | "failed"
  note?: string
  provenance?: NoteProvenance
}

export async function recordRelationshipOutcome(
  store: FriendStore,
  friendId: string,
  input: RecordOutcomeInput,
  familiarityDelta?: number,
): Promise<FriendRecord | null> {
  const record = await store.get(friendId)
  if (!record) return null

  const meta: AgentMeta = record.agentMeta ?? {
    bundleName: record.name,
    familiarity: 0,
    sharedMissions: [],
    outcomes: [],
  }

  const now = new Date().toISOString()
  const outcome: RelationshipOutcome = {
    missionId: input.missionId,
    result: input.result,
    timestamp: now,
    ...(input.note ? { note: input.note } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  }

  const outcomes = [...meta.outcomes, outcome]
  const sharedMissions = meta.sharedMissions.includes(input.missionId)
    ? meta.sharedMissions
    : [...meta.sharedMissions, input.missionId]
  const familiarity = meta.familiarity + (familiarityDelta ?? 1)

  const updated: FriendRecord = {
    ...record,
    agentMeta: { ...meta, outcomes, sharedMissions, familiarity },
    updatedAt: now,
  }
  await store.put(friendId, updated)

  emitNervesEvent({
    component: "friends",
    event: "friends.outcome_recorded",
    message: "recorded relationship outcome",
    meta: { friendId, result: input.result },
  })

  return updated
}
