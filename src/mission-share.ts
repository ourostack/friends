// prepareMissionShare (producer) + importMissionShare (consumer) — the shared
// mission ledger (brick 3). Structural twins of share.ts's profile producer /
// consumer, re-aimed from a PERSON at a MISSION.
//
// Two DIFFERENT agents agreeing they did the SAME mission (by `missionKey`) AND
// sharing what they collectively learned — WITH CONSENT, without first-party
// learnings being clobbered. Store-only + transport-agnostic: prepareMissionShare
// returns an envelope, importMissionShare consumes one; the WIRE is the caller's
// job. Pure — the only node builtin is `node:crypto`, mirroring share.ts.
//
// Through-line invariants (every one is tested in mission-share.test.ts):
//  - the mission is named by its JOIN KEY (`missionKey`), NEVER the local UUID;
//  - the share is consent-gated (subject = the missionKey) and scope-filtered;
//  - imported learnings NEVER touch first-party `learnings` (a separate
//    `importedLearnings` namespace) — first-party always wins, structurally;
//  - the source agent's trust CAPS acceptance (a stranger peer is refused);
//  - `status` / `participants` are NEVER recomputed from an import (non-transitive);
//  - imported outcomes are append-merged, stamped `origin:imported`, and deduped
//    by (missionId, timestamp, assertedBy.agentId) — same peer idempotent,
//    different peers coexist;
//  - an unknown mission may be SEEDED only by a friend/family introducing peer.
import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "./observability"
import type { MissionStore } from "./mission-store"
import type { FriendStore } from "./store"
import type { GrantStore } from "./grant-store"
import type {
  AgentAttribution,
  ImportedLearning,
  MissionRecord,
  RelationshipOutcome,
  TrustLevel,
} from "./types"
import type { ConsentPolicy, ConsentRecipient } from "./consent"
import { DEFAULT_CONSENT_POLICY } from "./consent"
import type { AgentVerifier } from "./verifier"
import { DEFAULT_AGENT_VERIFIER } from "./verifier"
import { originalAsserterOf } from "./share"

// ── Envelope ──

/** A learning as carried on the wire: its value plus who FIRST asserted it
 * (`originallyAssertedBy`), so the consumer can attribute it without laundering
 * an imported fact into first-party. The mission analogue of `SharedNote`. */
export interface SharedLearning {
  key: string
  value: string
  originallyAssertedBy?: AgentAttribution
}

/** The cross-agent mission-share envelope. Names the subject by JOIN KEY
 * (`missionKey`) + title only — NEVER a local UUID. A SIBLING of
 * `ProfileShareEnvelope` (Fork A), not a widening. */
export interface MissionShareEnvelope {
  /** The mission, named by its join key — `missionKey` + a human title. */
  subject: {
    missionKey: string
    title: string
  }
  /** The agent that produced this envelope (its join-key agentId). */
  fromAgentId: string
  scope: "mission" | "outcomes"
  /** Scope-filtered relationship outcomes (present for the `outcomes` scope). */
  outcomes?: RelationshipOutcome[]
  /** Scope-filtered shareable learnings (present for the `mission` scope). */
  learnings?: SharedLearning[]
  /** Opaque, verifier-specific proof slot. The TOFU verifier ignores it. */
  proof?: string
  issuedAt: string
}

// ── Producer ──

export interface PrepareMissionShareInput {
  /** The LOCAL mission to share, by its local UUID id (resolved via the store). */
  missionId: string
  /** The recipient agent's join-key agentId. */
  toAgentId: string
  scope: "mission" | "outcomes"
  /** This agent's own join-key agentId — the original asserter of first-party
   * learnings (so a shared first-party learning is attributed to self). */
  selfAgentId: string
  /** Optional proof to stamp on the envelope (for a non-TOFU recipient verifier). */
  proof?: string
}

export type PrepareMissionShareStatus = "not_found" | "no_consent" | "no_recipient"

export type PrepareMissionShareResult =
  | { ok: true; envelope: MissionShareEnvelope }
  | { ok: false; status: PrepareMissionShareStatus }

/** Build the scope-filtered shared learnings: only `shareable` learnings, each
 * attributed to its original asserter (self for a first-party learning, the
 * recorded original asserter for a relayed import). Reuses `originalAsserterOf`
 * from share.ts — single-sourced, no duplicate coverage surface. */
function buildSharedLearnings(record: MissionRecord, selfAgentId: string): SharedLearning[] {
  return Object.entries(record.learnings)
    .filter(([, learning]) => learning.shareable === true)
    .map(([key, learning]) => ({
      key,
      value: learning.value,
      originallyAssertedBy: originalAsserterOf(learning, selfAgentId),
    }))
}

/**
 * Producer half of the mission ledger. Consent-gated (subject = the mission's
 * `missionKey`), scope-filtered, provenance-preserving. Names the mission by its
 * join key, never the local UUID. The recipient's trust — read off this agent's
 * own friend record for `toAgentId` — is the authorization input the policy uses.
 */
export async function prepareMissionShare(
  missions: MissionStore,
  store: FriendStore,
  grants: GrantStore,
  input: PrepareMissionShareInput,
  consent: ConsentPolicy = DEFAULT_CONSENT_POLICY,
): Promise<PrepareMissionShareResult> {
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

  // The subject is the mission, keyed by its missionKey (a mission is just
  // another grant subject under the Fork-D opaque subject key).
  const consented = await consent.consents({
    subjectKey: record.missionKey,
    recipient,
    scope: input.scope,
    grants,
  })
  if (!consented) {
    return { ok: false, status: "no_consent" }
  }

  const now = new Date().toISOString()
  const envelope: MissionShareEnvelope = {
    subject: { missionKey: record.missionKey, title: record.title },
    fromAgentId: input.selfAgentId,
    scope: input.scope,
    issuedAt: now,
    ...(input.proof !== undefined ? { proof: input.proof } : {}),
    ...(input.scope === "outcomes"
      ? { outcomes: record.outcomes }
      : { learnings: buildSharedLearnings(record, input.selfAgentId) }),
  }

  emitNervesEvent({
    component: "friends",
    event: "friends.mission_share_prepared",
    message: "prepared mission share envelope",
    meta: { scope: input.scope, toAgentId: input.toAgentId, consentPolicy: consent.name },
  })

  return { ok: true, envelope }
}

// ── Consumer ──

/** Trust levels a peer must hold to INTRODUCE a previously-unknown mission. A
 * friend/family peer may seed a new mission; a stranger / acquaintance peer may
 * not (mirrors the person path's SEEDING_TRUST). */
const SEEDING_TRUST: ReadonlySet<TrustLevel> = new Set(["family", "friend"])

const TRUST_RANK: Record<TrustLevel, number> = { family: 4, friend: 3, acquaintance: 2, stranger: 1 }

export interface ImportMissionShareInput {
  envelope: MissionShareEnvelope
  /** The agent the envelope arrived from (its join-key agentId). */
  fromAgentId: string
  /** This agent's resolved trust in the source agent — the cap on acceptance. */
  trustOfSource: TrustLevel
}

export type ImportMissionShareStatus =
  | "imported"
  | "seeded"
  | "no_mission"
  | "untrusted_source"
  | "untrusted_introduction"

export type ImportMissionShareResult =
  | { ok: true; status: "imported" | "seeded"; record: MissionRecord }
  | { ok: false; status: "no_mission" | "untrusted_source" | "untrusted_introduction" }

export interface ImportMissionShareOptions {
  /** Authentication seam. Defaults to TOFU. Authorization (trust) is still
   * applied regardless of what the verifier says. */
  verifier?: AgentVerifier
  /** Minimum trust a source must hold for its facts to be accepted at all.
   * Default `acquaintance`: a stranger source is refused. */
  minTrustToAccept?: TrustLevel
}

function importedLearningFrom(learning: SharedLearning, fromAgentId: string, now: string): ImportedLearning {
  return {
    value: learning.value,
    importedAt: now,
    assertedBy: { agentId: fromAgentId },
    ...(learning.originallyAssertedBy ? { originallyAssertedBy: learning.originallyAssertedBy } : {}),
  }
}

/** Merge the envelope's learnings into the record's `importedLearnings` namespace
 * under the source agentId. First-party `learnings` are NOT passed in and are
 * physically untouched. Within the namespace, the newest import wins per key. */
function mergeImportedLearnings(
  record: MissionRecord,
  learnings: SharedLearning[],
  fromAgentId: string,
  now: string,
): MissionRecord["importedLearnings"] {
  const existing = record.importedLearnings ?? {}
  const forAgent = { ...(existing[fromAgentId] ?? {}) }
  for (const learning of learnings) {
    forAgent[learning.key] = importedLearningFrom(learning, fromAgentId, now)
  }
  return { ...existing, [fromAgentId]: forAgent }
}

/** Append the envelope's outcomes to the record's outcomes, stamping each with
 * `origin:imported` + the source attribution + importedAt, and DEDUPING by
 * (missionId, timestamp, assertedBy.agentId): a row whose identity already exists
 * is skipped (same peer idempotent); a row from a different peer with the same
 * (missionId, timestamp) coexists. The existing rows' `assertedBy?.agentId` is
 * read defensively — a first-party outcome may carry no provenance, and must
 * never be spuriously matched. This outcome-merge is genuinely NEW logic (the
 * person path's import never merged outcomes). */
function mergeImportedOutcomes(
  existing: RelationshipOutcome[],
  incoming: RelationshipOutcome[],
  fromAgentId: string,
  now: string,
): RelationshipOutcome[] {
  const identityOf = (o: RelationshipOutcome, assertedAgentId: string | undefined): string =>
    JSON.stringify([o.missionId, o.timestamp, assertedAgentId])
  const seen = new Set(existing.map((o) => identityOf(o, o.provenance?.assertedBy?.agentId)))
  const merged = [...existing]
  for (const o of incoming) {
    const identity = identityOf(o, fromAgentId)
    if (seen.has(identity)) continue
    seen.add(identity)
    merged.push({
      missionId: o.missionId,
      result: o.result,
      timestamp: o.timestamp,
      ...(o.note ? { note: o.note } : {}),
      provenance: { origin: "imported", assertedBy: { agentId: fromAgentId }, importedAt: now },
    })
  }
  return merged
}

/** Create a freshly-seeded mission for a previously-unknown key. Always
 * `status:"active"`, empty first-party `learnings`, carrying the subject's join
 * key + title. */
function seedMission(envelope: MissionShareEnvelope, now: string): MissionRecord {
  return {
    id: randomUUID(),
    missionKey: envelope.subject.missionKey,
    title: envelope.subject.title,
    status: "active",
    participants: [],
    outcomes: [],
    learnings: {},
    importedLearnings: {},
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  }
}

/** Apply an envelope's payload to a mission record WITHOUT recomputing its
 * `status` or `participants` (non-transitive) and WITHOUT touching first-party
 * `learnings`. Only `importedLearnings`, `outcomes`, and `updatedAt` change. */
function applyEnvelopeToMission(
  record: MissionRecord,
  envelope: MissionShareEnvelope,
  fromAgentId: string,
  now: string,
): MissionRecord {
  const importedLearnings =
    envelope.learnings && envelope.learnings.length > 0
      ? mergeImportedLearnings(record, envelope.learnings, fromAgentId, now)
      : record.importedLearnings

  const outcomes =
    envelope.outcomes && envelope.outcomes.length > 0
      ? mergeImportedOutcomes(record.outcomes, envelope.outcomes, fromAgentId, now)
      : record.outcomes

  return {
    ...record,
    // status / participants are intentionally NOT recomputed — an import must
    // never flip the mission's status (the non-transitive invariant).
    ...(importedLearnings ? { importedLearnings } : {}),
    outcomes,
    updatedAt: now,
  }
}

/**
 * Consumer half of the mission ledger — the non-clobbering merge. Resolves the
 * mission by `findByMissionKey`; lands imported learnings in the
 * `importedLearnings` namespace WITHOUT touching first-party `learnings`;
 * append-merges + dedupes imported outcomes; NEVER recomputes status /
 * participants; the source agent's trust caps acceptance; seeds an unknown
 * mission only when a friend/family peer introduces it.
 */
export async function importMissionShare(
  missions: MissionStore,
  input: ImportMissionShareInput,
  options: ImportMissionShareOptions = {},
): Promise<ImportMissionShareResult> {
  const verifier = options.verifier ?? DEFAULT_AGENT_VERIFIER
  const minTrust = options.minTrustToAccept ?? "acquaintance"

  // Authentication (caller's seam) AND authorization (trust ladder) must BOTH
  // pass. The verifier authenticates the wire; the trust cap is the package's own
  // gate and applies regardless of what the verifier returns.
  const authenticated = verifier.verify(input.fromAgentId, input.envelope.proof)
  const trustedEnough = TRUST_RANK[input.trustOfSource] >= TRUST_RANK[minTrust]
  if (!authenticated || !trustedEnough) {
    emitNervesEvent({
      component: "friends",
      event: "friends.mission_share_refused",
      message: "refused mission share from untrusted source",
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
    const withPayload = applyEnvelopeToMission(seeded, input.envelope, input.fromAgentId, now)
    await missions.put(withPayload.id, withPayload)
    emitNervesEvent({
      component: "friends",
      event: "friends.mission_share_seeded",
      message: "seeded new mission from mission share",
      meta: { missionId: withPayload.id, fromAgentId: input.fromAgentId },
    })
    return { ok: true, status: "seeded", record: withPayload }
  }

  const updated = applyEnvelopeToMission(existing, input.envelope, input.fromAgentId, now)
  await missions.put(updated.id, updated)
  emitNervesEvent({
    component: "friends",
    event: "friends.mission_share_imported",
    message: "imported mission share into existing mission",
    meta: { missionId: updated.id, fromAgentId: input.fromAgentId, scope: input.envelope.scope },
  })
  return { ok: true, status: "imported", record: updated }
}
