// prepareMissionResult (producer) + importMissionResult (consumer) — the result-return
// envelope (gap-2, p11 inc2). The honest north-star DELIVERABLE channel. Structural twin
// of mission-share.ts, re-aimed from a SHARE (outcomes/learnings) at a RESULT (B's actual
// produced artifact, attributed to B, correlated to A's delegation via missionKey +
// requestId). Q1 resolved: a NEW result envelope, NOT a mission_share reuse.
//
// Store-only + transport-agnostic: prepareMissionResult returns an envelope,
// importMissionResult consumes one; the WIRE is the caller's job (the result rides the
// mailbox under kind:"mission_result"). Pure — the only node builtin is `node:crypto`,
// mirroring mission-share.ts. Core-clean (no a2a-client import).
//
// Through-line invariants (every one tested in mission-result.test.ts):
//  - the mission is named by its JOIN KEY (missionKey), NEVER the local UUID;
//  - fromAgentId === the producing self (attributed to B);
//  - the result correlates to A's delegation via requestId;
//  - consent rides the "coordinate" identity-tier scope — a result is B answering A's OWN
//    delegation request (no third-party content), so trust ≥ friend suffices, exactly like
//    coordinate; NO new ShareScope, NO new content grant;
//  - on import the deliverable lands QUARANTINED under importedResults[agentId][requestId],
//    attributed to B + stamped imported, WITHOUT touching first-party;
//  - correlation honesty: a result whose requestId matches NO prior first-party delegation
//    on A is REJECTED (no_delegation) — A only accepts results for work it delegated;
//  - assignee honesty (security-review inc-2 finding 1): a result whose source is NOT the
//    agent A delegated TO (delegation.assignee.agentId !== fromAgentId) is REJECTED
//    (assignee_mismatch), even from a trusted peer with the right requestId; a legacy
//    delegation with no recorded assignee FAILS CLOSED;
//  - NO seeding: an unknown mission → no_mission (a result never creates a mission);
//  - the source agent's trust CAPS acceptance (a stranger/over-trust source writes nothing),
//    checked BEFORE correlation;
//  - non-transitive: status/participants are NEVER recomputed; first-party byte-untouched;
//  - idempotent on replay (same (agentId, requestId) → no double-land).
import { emitNervesEvent } from "./observability"
import type { MissionStore } from "./mission-store"
import type { FriendStore } from "./store"
import type { GrantStore } from "./grant-store"
import type { MissionRecord, MissionResult, MissionResultEnvelope, TrustLevel } from "./types"
import type { ConsentPolicy, ConsentRecipient } from "./consent"
import { DEFAULT_CONSENT_POLICY } from "./consent"
import type { AgentVerifier } from "./verifier"
import { DEFAULT_AGENT_VERIFIER } from "./verifier"

// ── Producer ──

export interface PrepareMissionResultInput {
  /** The LOCAL mission B is returning a result for, by its local UUID id. */
  missionId: string
  /** The recipient agent's join-key agentId — A, the delegator. */
  toAgentId: string
  /** The delegation correlation key (the gap-1 task-spec's requestId). */
  requestId: string
  /** B's deliverable. `requestId`/`provenance` are stamped by the producer. */
  result: { summary: string; artifact?: string; outputs?: Record<string, string> }
  /** This agent's own join-key agentId — the attribution (fromAgentId = B). */
  selfAgentId: string
  /** Optional proof to stamp on the envelope (for a non-TOFU recipient verifier). */
  proof?: string
}

export type PrepareMissionResultStatus = "not_found" | "no_consent"

export type PrepareMissionResultResult =
  | { ok: true; envelope: MissionResultEnvelope }
  | { ok: false; status: PrepareMissionResultStatus }

/**
 * Producer half of the result-return. Resolves the local mission by `missionId`; names
 * it by its `missionKey` (NEVER the local UUID); attributes the result to `selfAgentId`
 * (B); correlates by `requestId`. Consent-gated via the `"coordinate"` identity-tier
 * scope (a result is B answering A's own delegation — trust ≥ friend suffices under the
 * tiered default, ZERO new scope). Records the result first-party on B's own record under
 * `results[requestId]`.
 */
export async function prepareMissionResult(
  missions: MissionStore,
  store: FriendStore,
  grants: GrantStore,
  input: PrepareMissionResultInput,
  consent: ConsentPolicy = DEFAULT_CONSENT_POLICY,
): Promise<PrepareMissionResultResult> {
  const record = await missions.get(input.missionId)
  if (!record) {
    return { ok: false, status: "not_found" }
  }

  // The recipient's trust is read from this agent's own knowledge of it (the a2a-agent
  // friend record for toAgentId). An unknown recipient defaults to stranger.
  const recipientRecord = await store.findByExternalId("a2a-agent", input.toAgentId)
  const recipientTrust: TrustLevel = recipientRecord?.trustLevel ?? "stranger"
  const recipient: ConsentRecipient = { agentId: input.toAgentId, trustLevel: recipientTrust }

  // Consent rides the EXISTING "coordinate" identity-tier scope — a result is B
  // answering A's OWN delegation, so trust ≥ friend suffices under the tiered default,
  // with ZERO change to consent logic and NO new scope.
  const consented = await consent.consents({
    subjectKey: record.missionKey,
    recipient,
    scope: "coordinate",
    grants,
  })
  if (!consented) {
    return { ok: false, status: "no_consent" }
  }

  const now = new Date().toISOString()
  const envelope: MissionResultEnvelope = {
    subject: { missionKey: record.missionKey, title: record.title },
    fromAgentId: input.selfAgentId,
    requestId: input.requestId,
    result: {
      requestId: input.requestId,
      summary: input.result.summary,
      ...(input.result.artifact !== undefined ? { artifact: input.result.artifact } : {}),
      ...(input.result.outputs !== undefined ? { outputs: input.result.outputs } : {}),
    },
    issuedAt: now,
    ...(input.proof !== undefined ? { proof: input.proof } : {}),
  }

  // Record the result first-party on B's own mission under results[requestId].
  const firstPartyResult: MissionResult = { ...envelope.result, provenance: { origin: "first_party" } }
  const updated: MissionRecord = {
    ...record,
    results: { ...(record.results ?? {}), [input.requestId]: firstPartyResult },
    updatedAt: now,
  }
  await missions.put(updated.id, updated)

  emitNervesEvent({
    component: "friends",
    event: "friends.mission_result_prepared",
    message: "prepared mission result envelope",
    meta: { toAgentId: input.toAgentId, requestId: input.requestId, consentPolicy: consent.name },
  })

  return { ok: true, envelope }
}

// ── Consumer ──

const TRUST_RANK: Record<TrustLevel, number> = { family: 4, friend: 3, acquaintance: 2, stranger: 1 }

export interface ImportMissionResultInput {
  envelope: MissionResultEnvelope
  /** The agent the envelope arrived from (its join-key agentId) — B. */
  fromAgentId: string
  /** This agent's resolved trust in the source agent — the cap on acceptance. */
  trustOfSource: TrustLevel
}

export type ImportMissionResultStatus =
  | "imported"
  | "no_mission"
  | "no_delegation"
  | "assignee_mismatch"
  | "untrusted_source"

export type ImportMissionResultResult =
  | { ok: true; status: "imported"; record: MissionRecord }
  | { ok: false; status: "no_mission" | "no_delegation" | "assignee_mismatch" | "untrusted_source" }

export interface ImportMissionResultOptions {
  /** Authentication seam. Defaults to TOFU. Authorization (trust) is still applied
   * regardless of what the verifier says. */
  verifier?: AgentVerifier
  /** Minimum trust a source must hold for its result to be accepted at all.
   * Default `acquaintance`: a stranger source is refused. */
  minTrustToAccept?: TrustLevel
}

/** Land B's deliverable under `importedResults[fromAgentId][requestId]`, returning a NEW
 * namespace (never mutates the input). First-party `results` are NOT passed in and stay
 * physically untouched. Idempotent per (agentId, requestId): an entry that already exists
 * is preserved unchanged (never re-stamped). */
function mergeImportedResult(
  record: MissionRecord,
  result: MissionResult,
  fromAgentId: string,
  now: string,
): NonNullable<MissionRecord["importedResults"]> {
  const existing = record.importedResults ?? {}
  const forAgent = existing[fromAgentId] ?? {}
  if (forAgent[result.requestId]) return existing as NonNullable<MissionRecord["importedResults"]>
  return {
    ...existing,
    [fromAgentId]: {
      ...forAgent,
      [result.requestId]: {
        requestId: result.requestId,
        summary: result.summary,
        ...(result.artifact !== undefined ? { artifact: result.artifact } : {}),
        ...(result.outputs !== undefined ? { outputs: result.outputs } : {}),
        provenance: { origin: "imported", assertedBy: { agentId: fromAgentId }, importedAt: now },
      },
    },
  }
}

/**
 * Consumer half of the result-return — the non-clobbering merge. Order (PINNED):
 *  (1) TOFU verifier + trust cap (both must pass, else `untrusted_source`, write nothing);
 *  (2) unknown mission (no findByMissionKey hit) → `no_mission` (NO seeding — a result
 *      never creates a mission);
 *  (3) the result's `requestId` not present in the record's FIRST-PARTY `delegations`
 *      (A never delegated this) → `no_delegation` — correlation honesty;
 *  (3b) the matched delegation's recorded `assignee` is not the result's source
 *      (`delegation.assignee.agentId !== fromAgentId`) → `assignee_mismatch` — assignee
 *      honesty (security-review inc-2 finding 1). FAILS CLOSED on a legacy delegation with
 *      no recorded assignee. A mismatch writes NOTHING (not even quarantined);
 *  (4) otherwise land under `importedResults[agentId][requestId]` (dedupe on replay),
 *      stamped imported + attributed + importedAt, NEVER touching first-party
 *      `learnings`/`notes`/`status`/`delegations`/`results`, NEVER recomputing
 *      status/participants (non-transitive).
 */
export async function importMissionResult(
  missions: MissionStore,
  input: ImportMissionResultInput,
  options: ImportMissionResultOptions = {},
): Promise<ImportMissionResultResult> {
  const verifier = options.verifier ?? DEFAULT_AGENT_VERIFIER
  const minTrust = options.minTrustToAccept ?? "acquaintance"

  // (1) Authentication (caller's seam) AND authorization (trust ladder) must BOTH pass —
  // checked BEFORE correlation, so a stranger never even learns whether the mission exists.
  const authenticated = verifier.verify(input.fromAgentId, input.envelope.proof)
  const trustedEnough = TRUST_RANK[input.trustOfSource] >= TRUST_RANK[minTrust]
  if (!authenticated || !trustedEnough) {
    emitNervesEvent({
      component: "friends",
      event: "friends.mission_result_refused",
      message: "refused mission result from untrusted source",
      meta: { fromAgentId: input.fromAgentId, trustOfSource: input.trustOfSource, authenticated },
    })
    return { ok: false, status: "untrusted_source" }
  }

  // (2) Unknown mission → no_mission. A result NEVER seeds a mission (distinct from
  // mission-share's friend-seed).
  const existing = await missions.findByMissionKey(input.envelope.subject.missionKey)
  if (!existing) {
    return { ok: false, status: "no_mission" }
  }

  // (3) Correlation honesty — the requestId must name a delegation THIS agent issued
  // first-party (A only accepts results for work it actually delegated).
  const delegation = existing.delegations?.[input.envelope.requestId]
  if (!delegation) {
    return { ok: false, status: "no_delegation" }
  }

  // (3b) Assignee honesty (security-review inc-2 finding 1) — the result's SOURCE must be
  // the very agent A delegated TO. The requestId being delegated is NOT enough: a peer C
  // that A trusts (≥ the cap) who learned a requestId A delegated to a DIFFERENT agent B
  // could otherwise inject a forged result. FAILS CLOSED on a legacy/orphan delegation with
  // no recorded assignee (reject, never land). A mismatch writes NOTHING — not even
  // quarantined.
  if (delegation.assignee?.agentId !== input.fromAgentId) {
    emitNervesEvent({
      component: "friends",
      event: "friends.mission_result_refused",
      message: "refused mission result — source is not the delegation's assignee",
      meta: {
        fromAgentId: input.fromAgentId,
        requestId: input.envelope.requestId,
        expectedAssignee: delegation.assignee?.agentId ?? null,
      },
    })
    return { ok: false, status: "assignee_mismatch" }
  }

  // (4) Land the deliverable quarantined + attributed, never touching first-party, never
  // recomputing status/participants (non-transitive).
  const now = new Date().toISOString()
  const importedResults = mergeImportedResult(existing, input.envelope.result, input.fromAgentId, now)
  const updated: MissionRecord = { ...existing, importedResults, updatedAt: now }
  await missions.put(updated.id, updated)

  emitNervesEvent({
    component: "friends",
    event: "friends.mission_result_imported",
    message: "imported mission result into existing mission",
    meta: { missionId: updated.id, fromAgentId: input.fromAgentId, requestId: input.envelope.requestId },
  })
  return { ok: true, status: "imported", record: updated }
}
