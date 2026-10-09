// prepareProfileShare (producer) + importProfileShare (consumer) — the moat (N12).
//
// Two DIFFERENT agents agreeing a party is the same person AND sharing what they
// know — WITH CONSENT, without first-party knowledge being clobbered. The package
// stays store-only + transport-agnostic: prepareProfileShare returns an envelope,
// importProfileShare consumes one; the WIRE between them is the caller's job.
//
// Through-line invariants (every one is tested):
//  - the party is named by its JOIN KEY (externalIds), NEVER the local UUID;
//  - the share is consent-gated (a ConsentPolicy) and scope-filtered;
//  - imported facts NEVER touch first-party `notes` (a separate `importedNotes`
//    namespace) — first-party always wins, structurally;
//  - the source agent's trust CAPS acceptance (a stranger peer is refused);
//  - imports NEVER change the party's trust level (non-transitive — the key one);
//  - an unknown party may be SEEDED only by a friend/family introducing peer
//    (Fork E), at stranger, with the peer's external ids held as unverified claims
//    (`importedExternalIds`, never indexed); a stranger/acquaintance peer may not.
import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { GrantStore } from "./grant-store"
import type {
  AgentAttribution,
  ExternalId,
  FriendRecord,
  ImportedExternalId,
  ImportedNote,
  RelationshipOutcome,
  ShareScope,
  TrustLevel,
} from "./types"
import { IDENTITY_SCOPES } from "./types"
import type { ConsentPolicy, ConsentRecipient } from "./consent"
import { DEFAULT_CONSENT_POLICY } from "./consent"
import type { AgentVerifier } from "./verifier"
import { DEFAULT_AGENT_VERIFIER } from "./verifier"

// ── Envelope ──

/** A note as carried on the wire: its value plus who FIRST asserted it
 * (`originallyAssertedBy`), so the consumer can attribute it without laundering
 * an imported fact into first-party. */
export interface SharedNote {
  key: string
  value: string
  originallyAssertedBy?: AgentAttribution
}

/** The cross-agent profile-share envelope. Names the subject by JOIN KEY only. */
export interface ProfileShareEnvelope {
  /** The party, named by join key — externalIds + display name, NEVER a local UUID. */
  subject: {
    externalIds: ExternalId[]
    displayName: string
  }
  /** The agent that produced this envelope (its join-key agentId). */
  fromAgentId: string
  scope: ShareScope
  /** Scope-filtered notes (present for `notes:*` scopes). */
  notes?: SharedNote[]
  /** Scope-filtered relationship outcomes (present for the `outcomes` scope). */
  outcomes?: RelationshipOutcome[]
  /** Opaque, verifier-specific proof slot (Fork B). The TOFU verifier ignores it;
   * reserved day one so a stronger verifier needs no envelope change. */
  proof?: string
  issuedAt: string
}

// ── Producer ──

export interface PrepareProfileShareInput {
  /** The local friend to share (UUID or name — resolved via the store). */
  friendId: string
  /** The recipient agent's join-key agentId. */
  toAgentId: string
  scope: ShareScope
  /** This agent's own join-key agentId — the original asserter of first-party
   * facts (so a shared first-party note is attributed to self, not laundered). */
  selfAgentId: string
  /** Optional proof to stamp on the envelope (for a non-TOFU recipient verifier). */
  proof?: string
}

export type PrepareProfileShareStatus = "not_found" | "no_consent" | "no_recipient"

export type PrepareProfileShareResult =
  | { ok: true; envelope: ProfileShareEnvelope }
  | { ok: false; status: PrepareProfileShareStatus }

/** The original asserter of a note: for an imported note, whoever the import
 * recorded as `originallyAssertedBy` (falling back to its `assertedBy`); for a
 * first-party note, this agent itself. Never launders imported → first-party.
 * Always returns an attribution (a shared fact is always attributable). Exported
 * so the mission-share producer reuses it (a MissionLearning is structurally
 * compatible with the inline param type) — single-sourced, tested once. */
export function originalAsserterOf(
  note: { provenance?: { origin?: "first_party" | "imported"; assertedBy?: AgentAttribution } },
  selfAgentId: string,
): AgentAttribution {
  if (note.provenance?.origin === "imported") {
    return note.provenance.assertedBy ?? { agentId: selfAgentId }
  }
  return { agentId: selfAgentId }
}

function buildSharedNotes(record: FriendRecord, scope: ShareScope, selfAgentId: string): SharedNote[] {
  return Object.entries(record.notes)
    .filter(([, note]) => scope === "notes:all" || note.shareable === true)
    .map(([key, note]) => ({
      key,
      value: note.value,
      originallyAssertedBy: originalAsserterOf(note, selfAgentId),
    }))
}

/**
 * Producer half of the moat. Consent-gated (via the injected ConsentPolicy, or
 * the module default), scope-filtered, provenance-preserving. Names the party by
 * join key, never the local UUID. The recipient's trust level — read off this
 * agent's own record for `toAgentId` — is the authorization input the policy
 * uses. Returns `{ ok:true, envelope }` or `{ ok:false, status }`.
 */
export async function prepareProfileShare(
  store: FriendStore,
  grants: GrantStore,
  input: PrepareProfileShareInput,
  consent: ConsentPolicy = DEFAULT_CONSENT_POLICY,
): Promise<PrepareProfileShareResult> {
  const record = await store.get(input.friendId)
  if (!record) {
    return { ok: false, status: "not_found" }
  }

  // The recipient's trust level is read from this agent's own knowledge of it
  // (the a2a-agent record for toAgentId). An unknown recipient defaults to
  // stranger — never trusted by default.
  const recipientRecord = await store.findByExternalId("a2a-agent", input.toAgentId)
  const recipientTrust: TrustLevel = recipientRecord?.trustLevel ?? "stranger"
  const recipient: ConsentRecipient = { agentId: input.toAgentId, trustLevel: recipientTrust }

  const consented = await consent.consents({
    subjectKey: record.id,
    recipient,
    scope: input.scope,
    grants,
  })
  if (!consented) {
    return { ok: false, status: "no_consent" }
  }

  const now = new Date().toISOString()
  const isIdentityScope = IDENTITY_SCOPES.has(input.scope)
  const envelope: ProfileShareEnvelope = {
    subject: {
      // The subject's account handles go out only where the share is meant to identify
      // the person: the identity scope, and the grant-gated content scopes (which need
      // them so the receiver can find the right record). "name" and "coordinate" send
      // the display name alone.
      externalIds: input.scope === "name" || input.scope === "coordinate" ? [] : record.externalIds,
      displayName: record.name,
    },
    fromAgentId: input.selfAgentId,
    scope: input.scope,
    issuedAt: now,
    ...(input.proof !== undefined ? { proof: input.proof } : {}),
    ...(input.scope === "outcomes"
      ? { outcomes: record.agentMeta?.outcomes ?? [] }
      : {}),
    ...(!isIdentityScope && input.scope !== "outcomes"
      ? { notes: buildSharedNotes(record, input.scope, input.selfAgentId) }
      : {}),
  }

  emitNervesEvent({
    component: "friends",
    event: "friends.profile_share_prepared",
    message: "prepared profile share envelope",
    meta: { scope: input.scope, toAgentId: input.toAgentId, consentPolicy: consent.name },
  })

  return { ok: true, envelope }
}

// ── Consumer ──

/** Trust levels a peer must hold to INTRODUCE a previously-unknown party (Fork E).
 * A friend/family peer may seed a new record at stranger; a stranger /
 * acquaintance peer may not. */
const SEEDING_TRUST: ReadonlySet<TrustLevel> = new Set(["family", "friend"])

export interface ImportProfileShareInput {
  envelope: ProfileShareEnvelope
  /** The agent the envelope arrived from (its join-key agentId). */
  fromAgentId: string
  /** This agent's resolved trust in the source agent — the cap on acceptance.
   * A stranger source's facts are refused (see `minTrustToAccept`). */
  trustOfSource: TrustLevel
}

export type ImportProfileShareStatus =
  | "imported"
  | "seeded"
  | "no_party"
  | "untrusted_source"
  | "untrusted_introduction"

export type ImportProfileShareResult =
  | { ok: true; status: "imported" | "seeded"; record: FriendRecord }
  | { ok: false; status: "no_party" | "untrusted_source" | "untrusted_introduction" }

export interface ImportProfileShareOptions {
  /** Authentication seam (Fork B). Defaults to TOFU. Authorization (trust) is
   * still applied regardless of what the verifier says. */
  verifier?: AgentVerifier
  /** Minimum trust a source agent must hold for its facts to be accepted at all.
   * Default `acquaintance`: a stranger source is refused. */
  minTrustToAccept?: TrustLevel
}

const TRUST_RANK: Record<TrustLevel, number> = { family: 4, friend: 3, acquaintance: 2, stranger: 1 }

/** Find the local friend the envelope's subject refers to, by join key — the
 * FIRST of the subject's externalIds that resolves to an existing record. */
async function resolveSubject(
  store: FriendStore,
  envelope: ProfileShareEnvelope,
  fromAgentId: string,
): Promise<FriendRecord | null> {
  for (const ext of envelope.subject.externalIds) {
    const found = await store.findByExternalId(ext.provider, ext.externalId, ext.tenantId)
    if (found) return found
  }
  // A party this same peer introduced before is held with the peer's ids as unverified
  // claims. Match those (and only those from the same peer) so a repeat share updates
  // the seeded record instead of seeding a duplicate. This is import dedupe, never
  // sender resolution.
  if (typeof store.listAll === "function") {
    const all = await store.listAll()
    return all.find((record) => (record.importedExternalIds ?? []).some((claim) =>
      claim.assertedBy.agentId === fromAgentId &&
      envelope.subject.externalIds.some((ext) =>
        ext.provider === claim.provider && ext.externalId === claim.externalId && ext.tenantId === claim.tenantId),
    )) ?? null
  }
  return null
}

function importedNoteFrom(note: SharedNote, fromAgentId: string, now: string): ImportedNote {
  return {
    value: note.value,
    importedAt: now,
    assertedBy: { agentId: fromAgentId },
    ...(note.originallyAssertedBy ? { originallyAssertedBy: note.originallyAssertedBy } : {}),
  }
}

/** Merge the envelope's notes into the record's `importedNotes` namespace under
 * the source agentId. First-party `notes` are NOT passed in and are physically
 * untouched. Within the namespace, the newest import wins on key collision. */
function mergeImportedNotes(
  record: FriendRecord,
  notes: SharedNote[],
  fromAgentId: string,
  now: string,
): FriendRecord["importedNotes"] {
  const existing = record.importedNotes ?? {}
  const forAgent = { ...(existing[fromAgentId] ?? {}) }
  for (const note of notes) {
    forAgent[note.key] = importedNoteFrom(note, fromAgentId, now)
  }
  return { ...existing, [fromAgentId]: forAgent }
}

/** Create a freshly-seeded record for a previously-unknown party (Fork E). Always
 * `stranger` (the level a real first contact gets), kind `human`. The peer's
 * external ids are kept as unverified `importedExternalIds` claims: never in
 * `externalIds`, so they are never indexed and the real person cannot resolve to
 * this record by them. */
function seedRecord(envelope: ProfileShareEnvelope, fromAgentId: string, now: string): FriendRecord {
  return {
    id: randomUUID(),
    name: envelope.subject.displayName,
    role: "stranger",
    trustLevel: "stranger",
    connections: [],
    externalIds: [],
    ...(envelope.subject.externalIds.length > 0
      ? {
          importedExternalIds: envelope.subject.externalIds.map((ext) => ({
            provider: ext.provider,
            externalId: ext.externalId,
            ...(ext.tenantId !== undefined ? { tenantId: ext.tenantId } : {}),
            assertedBy: { agentId: fromAgentId },
            importedAt: now,
          })),
        }
      : {}),
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    kind: "human",
  }
}

/**
 * Consumer half of the moat — the non-clobbering merge. Resolves the party by
 * join key; lands imported facts in the `importedNotes` namespace (origin
 * "imported" + assertedBy + importedAt) WITHOUT ever touching first-party `notes`;
 * the source agent's trust caps acceptance; NEVER changes the party's trust level
 * (the key safety invariant); seeds an unknown party only when a friend/family
 * peer introduces it. Returns `{ ok, status, record }`.
 */
export async function importProfileShare(
  store: FriendStore,
  input: ImportProfileShareInput,
  options: ImportProfileShareOptions = {},
): Promise<ImportProfileShareResult> {
  const verifier = options.verifier ?? DEFAULT_AGENT_VERIFIER
  const minTrust = options.minTrustToAccept ?? "acquaintance"

  // Authentication (caller's seam) AND authorization (trust ladder) must BOTH
  // pass. The verifier authenticates the wire; the trust cap is the package's
  // own gate and applies regardless of what the verifier returns.
  const authenticated = verifier.verify(input.fromAgentId, input.envelope.proof)
  const trustedEnough = TRUST_RANK[input.trustOfSource] >= TRUST_RANK[minTrust]
  if (!authenticated || !trustedEnough) {
    emitNervesEvent({
      component: "friends",
      event: "friends.profile_share_refused",
      message: "refused profile share from untrusted source",
      meta: { fromAgentId: input.fromAgentId, trustOfSource: input.trustOfSource, authenticated },
    })
    return { ok: false, status: "untrusted_source" }
  }

  const now = new Date().toISOString()
  const existing = await resolveSubject(store, input.envelope, input.fromAgentId)

  if (!existing) {
    // Unknown party. Fork E: only a friend/family peer may seed a new record.
    if (!SEEDING_TRUST.has(input.trustOfSource)) {
      return { ok: false, status: "untrusted_introduction" }
    }
    const seeded = seedRecord(input.envelope, input.fromAgentId, now)
    const withNotes = applyEnvelopeToRecord(seeded, input.envelope, input.fromAgentId, now)
    await store.put(withNotes.id, withNotes)
    emitNervesEvent({
      component: "friends",
      event: "friends.profile_share_seeded",
      message: "seeded new party from profile share",
      meta: { friendId: withNotes.id, fromAgentId: input.fromAgentId },
    })
    return { ok: true, status: "seeded", record: withNotes }
  }

  const updated = applyEnvelopeToRecord(existing, input.envelope, input.fromAgentId, now)
  await store.put(updated.id, updated)
  emitNervesEvent({
    component: "friends",
    event: "friends.profile_share_imported",
    message: "imported profile share into existing party",
    meta: { friendId: updated.id, fromAgentId: input.fromAgentId, scope: input.envelope.scope },
  })
  return { ok: true, status: "imported", record: updated }
}

/** One peer may hold at most this many unverified id claims on a record. */
export const MAX_IMPORTED_CLAIMS_PER_PEER = 32

/** Keep the newest claims from the asserting peer and drop its oldest beyond the cap.
 * Other peers' claims are never evicted. */
function capClaimsPerPeer(claims: ImportedExternalId[], agentId: string): ImportedExternalId[] {
  const excess = claims.filter((claim) => claim.assertedBy.agentId === agentId).length - MAX_IMPORTED_CLAIMS_PER_PEER
  if (excess <= 0) return claims
  let toDrop = excess
  return claims.filter((claim) => claim.assertedBy.agentId !== agentId || toDrop-- <= 0)
}

/** Apply an envelope's payload to a record WITHOUT changing its trust level or
 * touching first-party `notes`. Only `importedNotes` (and `updatedAt`) change.
 * `trustLevel` and `role` are copied through verbatim — imports are non-transitive. */
function applyEnvelopeToRecord(
  record: FriendRecord,
  envelope: ProfileShareEnvelope,
  fromAgentId: string,
  now: string,
): FriendRecord {
  const importedNotes =
    envelope.notes && envelope.notes.length > 0
      ? mergeImportedNotes(record, envelope.notes, fromAgentId, now)
      : record.importedNotes

  // Ids this peer names that the record does not already hold (as a real identity or
  // as this peer's earlier claim) are appended as unverified claims.
  const known = (ext: { provider: string; externalId: string; tenantId?: string }) =>
    record.externalIds.some((have) => have.provider === ext.provider && have.externalId === ext.externalId && have.tenantId === ext.tenantId) ||
    (record.importedExternalIds ?? []).some((claim) =>
      claim.assertedBy.agentId === fromAgentId && claim.provider === ext.provider && claim.externalId === ext.externalId && claim.tenantId === ext.tenantId)
  const newClaims = envelope.subject.externalIds.filter((ext) => !known(ext)).map((ext) => ({
    provider: ext.provider,
    externalId: ext.externalId,
    ...(ext.tenantId !== undefined ? { tenantId: ext.tenantId } : {}),
    assertedBy: { agentId: fromAgentId },
    importedAt: now,
  }))
  const importedExternalIds = newClaims.length > 0
    ? capClaimsPerPeer([...(record.importedExternalIds ?? []), ...newClaims], fromAgentId)
    : record.importedExternalIds

  return {
    ...record,
    ...(importedExternalIds ? { importedExternalIds } : {}),
    // trustLevel / role are intentionally NOT recomputed — an import must never
    // change the party's trust (the single most important safety invariant).
    ...(importedNotes ? { importedNotes } : {}),
    updatedAt: now,
  }
}
