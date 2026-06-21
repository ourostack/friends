// recordMission — the first-party mission writer (brick 3).
//
// Upserts a MissionRecord by its cross-agent `missionKey`: creates one with a
// fresh local UUID when the key is unknown, else resolves the existing record via
// `findByMissionKey` and applies the input. First-party learnings land in
// `learnings` (this agent's own knowledge — NEVER in `importedLearnings`);
// participants merge deduped by agentId; outcomes append; status updates when
// provided. The companion to the UNTOUCHED `recordRelationshipOutcome` in
// `outcomes.ts` (that writer owns a friend's denormalized outcome index; this one
// owns the mission record). Pure store ops — no fs / net / env; the only node
// builtin is `node:crypto` (randomUUID), mirroring share.ts.
import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "./observability"
import type { MissionStore } from "./mission-store"
import type { AgentAttribution, MissionLearning, MissionRecord, RelationshipOutcome } from "./types"

export interface RecordMissionInput {
  missionKey: string
  /** Used only when CREATING; ignored on upsert of an existing mission. */
  title?: string
  /** When provided, sets the mission's status (first-party). */
  status?: MissionRecord["status"]
  /** Merged into the mission's participants, deduped by agentId. */
  participants?: AgentAttribution[]
  /** Appended to the first-party `learnings` map (NEVER `importedLearnings`). */
  learnings?: Array<{ key: string; value: string; shareable?: boolean }>
  /** Appended to the mission's outcomes as first-party rows (no `origin:imported`). */
  outcomes?: Array<{ missionId: string; result: RelationshipOutcome["result"]; note?: string }>
}

/** Merge the input participants into the existing list, deduped by agentId. A
 * participant whose agentId already appears is skipped (idempotent). */
function mergeParticipants(existing: AgentAttribution[], incoming: AgentAttribution[]): AgentAttribution[] {
  const seen = new Set(existing.map((p) => p.agentId))
  const merged = [...existing]
  for (const p of incoming) {
    if (!seen.has(p.agentId)) {
      merged.push(p)
      seen.add(p.agentId)
    }
  }
  return merged
}

/** Apply the input's first-party learnings onto the existing learnings map,
 * stamping each with `savedAt` + first-party provenance. */
function applyLearnings(
  existing: Record<string, MissionLearning>,
  incoming: NonNullable<RecordMissionInput["learnings"]>,
  now: string,
): Record<string, MissionLearning> {
  const learnings = { ...existing }
  for (const l of incoming) {
    learnings[l.key] = {
      value: l.value,
      savedAt: now,
      shareable: l.shareable ?? false,
      provenance: { origin: "first_party" },
    }
  }
  return learnings
}

/** Append the input's first-party outcomes, stamping each with a timestamp. */
function applyOutcomes(
  existing: RelationshipOutcome[],
  incoming: NonNullable<RecordMissionInput["outcomes"]>,
  now: string,
): RelationshipOutcome[] {
  const outcomes = [...existing]
  for (const o of incoming) {
    outcomes.push({
      missionId: o.missionId,
      result: o.result,
      timestamp: now,
      ...(o.note ? { note: o.note } : {}),
    })
  }
  return outcomes
}

/**
 * Upsert a mission by its `missionKey`. Creates a fresh record (new local UUID,
 * `status:"active"`, empty namespaces) when the key is unknown; otherwise
 * resolves the existing record and applies the input. First-party learnings are
 * this agent's own — they NEVER touch `importedLearnings`. Returns the persisted
 * record.
 */
export async function recordMission(missions: MissionStore, input: RecordMissionInput): Promise<MissionRecord> {
  const now = new Date().toISOString()
  const found = await missions.findByMissionKey(input.missionKey)

  const base: MissionRecord = found ?? {
    id: randomUUID(),
    missionKey: input.missionKey,
    title: input.title ?? input.missionKey,
    status: input.status ?? "active",
    participants: [],
    outcomes: [],
    learnings: {},
    importedLearnings: {},
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  }

  const updated: MissionRecord = {
    ...base,
    // `status` is set from the input when provided (first-party). On create it is
    // already baked into `base`; this re-applies it on an upsert.
    status: input.status ?? base.status,
    participants: input.participants ? mergeParticipants(base.participants, input.participants) : base.participants,
    outcomes: input.outcomes ? applyOutcomes(base.outcomes, input.outcomes, now) : base.outcomes,
    learnings: input.learnings ? applyLearnings(base.learnings, input.learnings, now) : base.learnings,
    updatedAt: now,
  }

  await missions.put(updated.id, updated)

  emitNervesEvent({
    component: "friends",
    event: "friends.mission_recorded",
    message: "recorded mission",
    meta: { missionKey: input.missionKey, created: found === null, status: updated.status },
  })

  return updated
}
