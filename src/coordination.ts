// prepareCoordination (producer) + importCoordination (consumer) — the shared-work
// assignment ledger (brick 5). Structural twins of mission-share.ts's mission
// producer / consumer, re-aimed from a FACT (a learning / an outcome) at an
// ASSIGNMENT (who is doing this mission).
//
// Coordination is a tiny, append-only set of mission-coordination messages (five
// verbs: request / offer / accept / decline / handoff) that ride the brick-2
// mailbox under a new `kind:"coordination"`, gated by trust (brick 1) + consent
// (the existing grant stack, new `"coordinate"` scope), whose ONLY persisted effect
// is one bounded sub-object on the mission a participant already shares — its
// `coordination` (assignee + an append-only log). Store-only + transport-agnostic:
// prepareCoordination returns an envelope, importCoordination consumes one; the
// WIRE is the caller's job. Pure — the only node builtin is `node:crypto`.
//
// Through-line invariants (every one is tested in coordination.test.ts):
//  - the mission is named by its JOIN KEY (`missionKey`), NEVER the local UUID;
//  - the message is consent-gated (subject = the missionKey, scope = "coordinate");
//  - imported intents NEVER touch first-party `learnings`/`notes`/`status` (they
//    only append to `coordination.log` and, for an `accept`, set `assignee`);
//  - the source agent's trust CAPS acceptance (a stranger peer is refused);
//  - `status` / `participants` / `trustLevel` / `standing` are NEVER recomputed
//    from a coordination message (non-transitive);
//  - a `handoff` NEVER forces an `assignee` onto the receiver — only the receiver's
//    own `accept` sets it (non-transitive handoff);
//  - the ONE producer-side precondition: you must HOLD the assignment to hand it off;
//  - assignee-conflict is last-writer-wins by `issuedAt` (the mailbox's total order);
//  - an unknown mission may be SEEDED only by a friend/family introducing peer.
import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "./observability"
import type { MissionStore } from "./mission-store"
import type { FriendStore } from "./store"
import type { GrantStore } from "./grant-store"
import type {
  AgentAttribution,
  CoordinationIntent,
  CoordinationLogEntry,
  MissionCoordination,
  MissionRecord,
  MissionTaskSpec,
  TrustLevel,
} from "./types"
import type { ConsentPolicy, ConsentRecipient } from "./consent"
import { DEFAULT_CONSENT_POLICY } from "./consent"
import type { AgentVerifier } from "./verifier"
import { DEFAULT_AGENT_VERIFIER } from "./verifier"

// ── Envelope ──

/** The cross-agent coordination envelope (brick 5). Names the subject by JOIN KEY
 * (`missionKey`) + title only — NEVER a local UUID. A SIBLING of
 * `MissionShareEnvelope` (Fork A — per-kind compiler-enforced type safety), not a
 * widening: a coordination message is always *about* a mission both agents can name
 * out of band. */
export interface CoordinationEnvelope {
  /** The mission, named by its join key — `missionKey` + a human title. */
  subject: {
    missionKey: string
    title: string
  }
  /** The agent that produced this envelope (its join-key agentId). */
  fromAgentId: string
  /** The verb (one of the five coordination intents). */
  intent: CoordinationIntent
  /** Optional free text ("can you take the API side?"). */
  note?: string
  /** The handoff target, present ONLY on intent:"handoff": the agent the sender
   * PROPOSES as the new assignee (named by join-key agentId). The receiver's own
   * accept is what actually sets it — a handoff never forces an assignment. */
  proposedAssignee?: AgentAttribution
  /** The delegation task-spec, meaningful ONLY on intent:"request" (gap-1, p11 inc2):
   * the structured "what B is being asked to do", carrying the minted `requestId` the
   * result-return correlates against. Present only when the producer was given a task on
   * a request; a plain coordination request omits it (back-compat). Mirrors how
   * `proposedAssignee` rides only `handoff`. */
  task?: MissionTaskSpec
  /** Opaque, verifier-specific proof slot. The TOFU verifier ignores it. */
  proof?: string
  issuedAt: string
}

/** Append a log entry to a mission's coordination sub-object (creating the
 * sub-object if absent), returning a NEW MissionCoordination (never mutates the
 * input). The log is append-only — this only ever ADDS one step. */
function appendLog(
  existing: MissionCoordination | undefined,
  entry: CoordinationLogEntry,
): MissionCoordination {
  const base: MissionCoordination = existing ?? { log: [] }
  return { ...base, log: [...base.log, entry] }
}

// ── Producer ──

export interface PrepareCoordinationInput {
  /** The LOCAL mission to coordinate, by its local UUID id (resolved via the store). */
  missionId: string
  /** The recipient agent's join-key agentId. */
  toAgentId: string
  /** The coordination verb. */
  intent: CoordinationIntent
  /** Optional free text carried on the envelope + logged. */
  note?: string
  /** The proposed new assignee — meaningful ONLY on intent:"handoff". */
  proposedAssignee?: AgentAttribution
  /** This agent's own join-key agentId — the asserter of the first-party log entry
   * (and, on an `accept`, the assignee it claims for itself). */
  selfAgentId: string
  /** Optional delegation task-spec (gap-1, p11 inc2), meaningful ONLY on
   * intent:"request". When provided on a request, the producer MINTS a `requestId`,
   * stamps the full `MissionTaskSpec` on the envelope's `task`, and records it first-party
   * under the mission's `delegations[requestId]`. Ignored on any non-request intent.
   * Absent ⇒ a plain coordination request, byte-identical to today (back-compat). */
  task?: { summary: string; details?: string; inputs?: Record<string, string> }
  /** Optional proof to stamp on the envelope (for a non-TOFU recipient verifier). */
  proof?: string
}

export type PrepareCoordinationStatus = "not_found" | "no_consent" | "not_assignee"

export type PrepareCoordinationResult =
  | { ok: true; envelope: CoordinationEnvelope }
  | { ok: false; status: PrepareCoordinationStatus }

/** Whether this agent currently HOLDS the mission's assignment — the one
 * producer-side precondition (you can only hand off what you hold). A one-line
 * equality check, not a state machine. */
function holdsAssignment(record: MissionRecord, selfAgentId: string): boolean {
  return record.coordination?.assignee?.agentId === selfAgentId
}

/** Apply the OUTGOING intent to the producer's own mission record as a first-party
 * step: always append the intent to `coordination.log`; on an `accept`, also claim
 * the assignment for self (the accepter is taking it). No other intent moves the
 * producer's `assignee`. When a `taskSpec` is supplied (a request carrying a task,
 * gap-1), ALSO record it first-party under `delegations[requestId]` — the correlation
 * anchor the result-return matches against. Mirrors how recordMission stamps
 * first-party provenance. */
function applyOutgoingIntent(
  record: MissionRecord,
  input: PrepareCoordinationInput,
  now: string,
  taskSpec: MissionTaskSpec | undefined,
): MissionRecord {
  const entry: CoordinationLogEntry = {
    intent: input.intent,
    fromAgentId: input.selfAgentId,
    at: now,
    provenance: { origin: "first_party" },
    ...(input.note !== undefined ? { note: input.note } : {}),
  }
  const withLog = appendLog(record.coordination, entry)
  const coordination: MissionCoordination =
    input.intent === "accept"
      ? { ...withLog, assignee: { agentId: input.selfAgentId }, assignedAt: now }
      : withLog
  // gap-1: record the issued delegation first-party under delegations[requestId].
  const delegations: MissionRecord["delegations"] = taskSpec
    ? { ...(record.delegations ?? {}), [taskSpec.requestId]: { task: taskSpec, provenance: { origin: "first_party" } } }
    : record.delegations
  return {
    ...record,
    coordination,
    ...(delegations ? { delegations } : {}),
    updatedAt: now,
  }
}

/** Build the MissionTaskSpec for a request carrying a task (gap-1): mint the
 * `requestId` and carry the optional details/inputs only when present. Returns undefined
 * when there is no task to attach, or the intent is not a request (a task on any other
 * intent is ignored). */
function buildTaskSpec(input: PrepareCoordinationInput): MissionTaskSpec | undefined {
  if (input.intent !== "request" || input.task === undefined) return undefined
  return {
    requestId: randomUUID(),
    summary: input.task.summary,
    ...(input.task.details !== undefined ? { details: input.task.details } : {}),
    ...(input.task.inputs !== undefined ? { inputs: input.task.inputs } : {}),
  }
}

/**
 * Producer half of the coordination primitive. Consent-gated (subject = the
 * mission's `missionKey`, scope = `"coordinate"`), names the mission by its join
 * key (never the local UUID). The recipient's trust — read off this agent's own
 * friend record for `toAgentId` — is the authorization input the policy uses. The
 * ONLY precondition: `handoff` requires this agent to hold the assignment. Also
 * records the outgoing intent on the local mission as a first-party log step.
 */
export async function prepareCoordination(
  missions: MissionStore,
  store: FriendStore,
  grants: GrantStore,
  input: PrepareCoordinationInput,
  consent: ConsentPolicy = DEFAULT_CONSENT_POLICY,
): Promise<PrepareCoordinationResult> {
  const record = await missions.get(input.missionId)
  if (!record) {
    return { ok: false, status: "not_found" }
  }

  // The recipient's trust is read from this agent's own knowledge of it (the
  // a2a-agent friend record for toAgentId). An unknown recipient defaults to
  // stranger — never trusted by default.
  const recipientRecord = await store.findByExternalId("a2a-agent", input.toAgentId)
  const recipientTrust: TrustLevel = recipientRecord?.trustLevel ?? "stranger"
  const recipient: ConsentRecipient = { agentId: input.toAgentId, trustLevel: recipientTrust }

  // The subject is the mission, keyed by its missionKey. A coordination message
  // consents through the EXISTING grant machinery via the new identity-tier
  // `"coordinate"` scope — so trust ≥ friend suffices under the tiered default,
  // with ZERO change to consent-policy logic (only the scope set grew).
  const consented = await consent.consents({
    subjectKey: record.missionKey,
    recipient,
    scope: "coordinate",
    grants,
  })
  if (!consented) {
    return { ok: false, status: "no_consent" }
  }

  // The ONE producer-side state check: you must HOLD the assignment to hand it off.
  if (input.intent === "handoff" && !holdsAssignment(record, input.selfAgentId)) {
    return { ok: false, status: "not_assignee" }
  }

  const now = new Date().toISOString()
  // gap-1: a request carrying a task mints a requestId + a MissionTaskSpec (undefined on
  // any non-request intent, or when no task was given). Minted ONCE so the envelope's
  // task and the first-party delegations[requestId] share the same correlation key.
  const taskSpec = buildTaskSpec(input)
  const envelope: CoordinationEnvelope = {
    subject: { missionKey: record.missionKey, title: record.title },
    fromAgentId: input.selfAgentId,
    intent: input.intent,
    issuedAt: now,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.intent === "handoff" && input.proposedAssignee !== undefined
      ? { proposedAssignee: input.proposedAssignee }
      : {}),
    ...(taskSpec ? { task: taskSpec } : {}),
    ...(input.proof !== undefined ? { proof: input.proof } : {}),
  }

  // Record the outgoing intent on the producer's own mission (first-party), so the
  // sender's record reflects "I asked / I offered / I accepted" — and, for a request
  // with a task, the issued delegation under delegations[requestId].
  const updated = applyOutgoingIntent(record, input, now, taskSpec)
  await missions.put(updated.id, updated)

  emitNervesEvent({
    component: "friends",
    event: "friends.coordination_prepared",
    message: "prepared coordination envelope",
    meta: { intent: input.intent, toAgentId: input.toAgentId, consentPolicy: consent.name },
  })

  return { ok: true, envelope }
}

// ── Consumer ──

/** Trust levels a peer must hold to INTRODUCE a previously-unknown mission via a
 * coordination message. A friend/family peer may seed a new mission; a stranger /
 * acquaintance peer may not (mirrors the mission-share SEEDING_TRUST). */
const SEEDING_TRUST: ReadonlySet<TrustLevel> = new Set(["family", "friend"])

const TRUST_RANK: Record<TrustLevel, number> = { family: 4, friend: 3, acquaintance: 2, stranger: 1 }

export interface ImportCoordinationInput {
  envelope: CoordinationEnvelope
  /** The agent the envelope arrived from (its join-key agentId). */
  fromAgentId: string
  /** This agent's resolved trust in the source agent — the cap on acceptance. */
  trustOfSource: TrustLevel
}

export type ImportCoordinationStatus =
  | "logged"
  | "assigned"
  | "seeded"
  | "no_mission"
  | "untrusted_source"
  | "untrusted_introduction"

export type ImportCoordinationResult =
  | { ok: true; status: "logged" | "assigned" | "seeded"; record: MissionRecord }
  | { ok: false; status: "no_mission" | "untrusted_source" | "untrusted_introduction" }

export interface ImportCoordinationOptions {
  /** Authentication seam. Defaults to TOFU. Authorization (trust) is still applied
   * regardless of what the verifier says. */
  verifier?: AgentVerifier
  /** Minimum trust a source must hold for its messages to be accepted at all.
   * Default `acquaintance`: a stranger source is refused. */
  minTrustToAccept?: TrustLevel
}

/** Whether an incoming intent is already in the log under the same identity-tuple
 * `(intent, fromAgentId, issuedAt)` — the same idempotency technique
 * mergeImportedOutcomes uses, so a replayed coordination message is a no-op on the
 * log. `issuedAt` is matched against the entry's `at` (imports stamp `at = issuedAt`). */
function alreadyLogged(coordination: MissionCoordination | undefined, intent: CoordinationIntent, fromAgentId: string, issuedAt: string): boolean {
  if (!coordination) return false
  return coordination.log.some(
    (e) => e.intent === intent && e.fromAgentId === fromAgentId && e.at === issuedAt,
  )
}

/** Apply an INCOMING coordination envelope to a mission record. Appends the intent
 * to `coordination.log` stamped `origin:imported` + attributed (never first-party,
 * never duplicated). Applies the assignee effect — the ONLY mutation beyond the
 * log, and tightly bounded:
 *   - `accept`  → set assignee = the sender (the accepter is claiming it), with
 *     last-writer-wins by `issuedAt`: a later accept overrides an earlier one, an
 *     earlier accept never clobbers a later holder.
 *   - everything else (request/offer/decline/handoff) → log only; a `handoff`
 *     NEVER sets assignee on receipt (non-transitive — only a self-accept does).
 * NEVER recomputes status/participants/trustLevel/standing (non-transitive). */
function applyIncomingIntent(
  record: MissionRecord,
  envelope: CoordinationEnvelope,
  fromAgentId: string,
  now: string,
): { record: MissionRecord; assigned: boolean } {
  // Replay/idempotency: a message already in the log adds nothing (and can't move
  // the assignee a second time).
  if (alreadyLogged(record.coordination, envelope.intent, fromAgentId, envelope.issuedAt)) {
    return { record, assigned: false }
  }

  const entry: CoordinationLogEntry = {
    intent: envelope.intent,
    fromAgentId,
    at: envelope.issuedAt,
    provenance: { origin: "imported", assertedBy: { agentId: fromAgentId }, importedAt: now },
    ...(envelope.note !== undefined ? { note: envelope.note } : {}),
  }
  const withLog = appendLog(record.coordination, entry)

  if (envelope.intent === "accept") {
    // Last-writer-wins by issuedAt: the accept with the later issuedAt is the
    // effective assignee. An earlier-issued accept arriving after a later one does
    // NOT clobber the later holder (both stay in the append-only log either way).
    const currentAssignedAt = record.coordination?.assignedAt
    const isLater = currentAssignedAt === undefined || envelope.issuedAt >= currentAssignedAt
    const coordination: MissionCoordination = isLater
      ? { ...withLog, assignee: { agentId: fromAgentId }, assignedAt: envelope.issuedAt }
      : withLog
    return { record: { ...record, coordination, updatedAt: now }, assigned: isLater }
  }

  // request / offer / decline / handoff → log only; assignee untouched.
  return { record: { ...record, coordination: withLog, updatedAt: now }, assigned: false }
}

/** Create a freshly-seeded mission for a previously-unknown key, carrying the
 * subject's join key + title, `status:"active"`, empty first-party `learnings`. The
 * coordination sub-object starts with an empty log (the incoming intent is applied
 * by the caller). */
function seedMission(envelope: CoordinationEnvelope, now: string): MissionRecord {
  return {
    id: randomUUID(),
    missionKey: envelope.subject.missionKey,
    title: envelope.subject.title,
    status: "active",
    participants: [],
    outcomes: [],
    learnings: {},
    importedLearnings: {},
    coordination: { log: [] },
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  }
}

/**
 * Consumer half of the coordination primitive — the non-clobbering merge. Resolves
 * the mission by `findByMissionKey`; appends the incoming intent to
 * `coordination.log` stamped `origin:imported` WITHOUT touching first-party
 * `learnings`/`notes`/`status`; applies the bounded assignee effect (only `accept`
 * sets it; a `handoff` never forces it; conflicts are last-writer-wins by
 * `issuedAt`); NEVER recomputes status / participants / trust / standing; the
 * source agent's trust caps acceptance; seeds an unknown mission only when a
 * friend/family peer introduces it.
 */
export async function importCoordination(
  missions: MissionStore,
  input: ImportCoordinationInput,
  options: ImportCoordinationOptions = {},
): Promise<ImportCoordinationResult> {
  const verifier = options.verifier ?? DEFAULT_AGENT_VERIFIER
  const minTrust = options.minTrustToAccept ?? "acquaintance"

  // Authentication (caller's seam) AND authorization (trust ladder) must BOTH pass.
  const authenticated = verifier.verify(input.fromAgentId, input.envelope.proof)
  const trustedEnough = TRUST_RANK[input.trustOfSource] >= TRUST_RANK[minTrust]
  if (!authenticated || !trustedEnough) {
    emitNervesEvent({
      component: "friends",
      event: "friends.coordination_refused",
      message: "refused coordination from untrusted source",
      meta: { fromAgentId: input.fromAgentId, trustOfSource: input.trustOfSource, authenticated },
    })
    return { ok: false, status: "untrusted_source" }
  }

  const now = new Date().toISOString()
  const existing = await missions.findByMissionKey(input.envelope.subject.missionKey)

  if (!existing) {
    // Unknown mission. Only a friend/family peer may seed a new one.
    if (!SEEDING_TRUST.has(input.trustOfSource)) {
      return { ok: false, status: "untrusted_introduction" }
    }
    const seeded = seedMission(input.envelope, now)
    const { record: withIntent, assigned } = applyIncomingIntent(seeded, input.envelope, input.fromAgentId, now)
    await missions.put(withIntent.id, withIntent)
    emitNervesEvent({
      component: "friends",
      event: "friends.coordination_seeded",
      message: "seeded new mission from coordination",
      meta: { missionId: withIntent.id, fromAgentId: input.fromAgentId, intent: input.envelope.intent },
    })
    // A seeded mission reports `seeded` even when the intent was an accept (the
    // record creation is the salient fact); `assigned` is reflected in the record.
    void assigned
    return { ok: true, status: "seeded", record: withIntent }
  }

  const { record: updated, assigned } = applyIncomingIntent(existing, input.envelope, input.fromAgentId, now)
  await missions.put(updated.id, updated)
  emitNervesEvent({
    component: "friends",
    event: "friends.coordination_imported",
    message: "imported coordination into existing mission",
    meta: { missionId: updated.id, fromAgentId: input.fromAgentId, intent: input.envelope.intent, assigned },
  })
  return { ok: true, status: assigned ? "assigned" : "logged", record: updated }
}
