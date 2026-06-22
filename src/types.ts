// Context kernel type definitions.
// FriendRecord (merged identity + notes), channel capabilities, and resolved context.

import { emitNervesEvent } from "./observability"

// -- Identity Provider --
// Closed union: "aad" (Azure AD / Teams), "local" (CLI / OS),
// "teams-conversation" (fallback), "imessage-handle" (BlueBubbles/iMessage)
export type IdentityProvider = "aad" | "local" | "teams-conversation" | "imessage-handle" | "email-address" | "a2a-agent"

const IDENTITY_PROVIDERS: ReadonlySet<string> = new Set<IdentityProvider>(["aad", "local", "teams-conversation", "imessage-handle", "email-address", "a2a-agent"])

export function isIdentityProvider(value: unknown): value is IdentityProvider {
  emitNervesEvent({
    component: "friends",
    event: "friends.identity_provider_check",
    message: "identity provider validation",
    meta: {},
  })
  return typeof value === "string" && IDENTITY_PROVIDERS.has(value)
}

// -- Channel --
// Closed union: which sense/channel a session belongs to
export type Channel = "cli" | "teams" | "bluebubbles" | "mail" | "voice" | "a2a" | "inner" | "mcp"

// -- Integration --
// Closed union: which external service an action targets
export type Integration = "ado" | "github" | "graph"

const INTEGRATIONS: ReadonlySet<string> = new Set<Integration>(["ado", "github", "graph"])

export function isIntegration(value: unknown): value is Integration {
  return typeof value === "string" && INTEGRATIONS.has(value)
}

// -- External ID --
// Links an internal FriendRecord to an external system identity
export interface ExternalId {
  provider: IdentityProvider
  externalId: string
  tenantId?: string
  linkedAt: string // ISO date
}

export type TrustLevel = "family" | "friend" | "acquaintance" | "stranger"

/** Trust levels that grant full tool access and proactive send capability. */
export const TRUSTED_LEVELS: ReadonlySet<TrustLevel> = new Set(["family", "friend"])

/** Whether a trust level grants full access (family or friend). Defaults to "friend" for legacy records. */
export function isTrustedLevel(trustLevel?: TrustLevel): boolean {
  return TRUSTED_LEVELS.has(trustLevel ?? "friend")
}

export interface FriendConnection {
  name: string
  relationship: string
}

// -- Agent Attribution --
// Names an agent that asserted a fact: a join-key-friendly { agentId, agentName }
// pair. Used by both NoteProvenance.assertedBy and the imported-note namespace.
export interface AgentAttribution {
  agentId?: string
  agentName?: string
}

// -- Note Provenance --
// Optional attribution for a fact asserted about a friend: which agent claimed
// it, and whether it is first-party (this agent's own knowledge) or imported
// from a cross-agent share. Additive — records with no provenance remain valid,
// and an absent `origin` is treated as "first_party" everywhere (the safe-merge
// predicate). Attaches inline on a note value and on a RelationshipOutcome so a
// cross-agent assertion can carry who made it (the P2 `assertedBy` slot).
export interface NoteProvenance {
  assertedBy?: AgentAttribution
  /** Provenance origin. Absent ⇒ treat as "first_party". An "imported" fact came
   * from another agent's share and must never be laundered into first-party. */
  origin?: "first_party" | "imported"
  /** ISO timestamp at which an imported fact was accepted. Set only on imports. */
  importedAt?: string
}

// -- Imported Note --
// One fact accepted from another agent's profile share. Lives in the SEPARATE
// `importedNotes` namespace (never in first-party `notes`), so first-party
// knowledge is structurally inviolable: imports physically cannot clobber it.
// Carries who introduced it (`assertedBy`) and — when the share itself relayed a
// fact that originated elsewhere — who FIRST asserted it (`originallyAssertedBy`),
// so an imported fact is never laundered into looking first-party.
export interface ImportedNote {
  value: string
  importedAt: string
  assertedBy?: AgentAttribution
  originallyAssertedBy?: AgentAttribution
}

// -- Share Scope --
// What a profile share is allowed to carry. Identity scopes (`name`/`identity`)
// expose only the JOIN KEY (externalIds + display name) — never note content.
// Content scopes expose notes: `notes:safe` shares only notes explicitly marked
// `shareable`, `notes:all` shares every note, `outcomes` shares relationship
// outcomes. `mission` (brick 3) shares a whole mission artifact (title/status +
// its outcomes + its *shareable* learnings) — like the note scopes it carries
// content, so under the tiered default it always needs an explicit grant.
// `coordinate` (brick 5) consents to a coordination message about a mission —
// just "will you take mission X", named by its join key, carrying no note
// content, so it gates at the IDENTITY tier (trust ≥ friend suffices). The scope
// is the unit a `ShareGrant` consents to.
export type ShareScope = "name" | "identity" | "notes:safe" | "notes:all" | "outcomes" | "mission" | "coordinate"

const SHARE_SCOPES: ReadonlySet<string> = new Set<ShareScope>(["name", "identity", "notes:safe", "notes:all", "outcomes", "mission", "coordinate"])

export function isShareScope(value: unknown): value is ShareScope {
  return typeof value === "string" && SHARE_SCOPES.has(value)
}

/** Identity-only scopes expose the join key (externalIds + name), never note
 * content. The tiered consent policy gates these on trust alone. `coordinate`
 * (brick 5) joins them: a coordination message names a mission by its join key
 * and carries no note content, so trust ≥ friend consents to it — a friend peer
 * may be asked to take a mission without a per-mission content grant. */
export const IDENTITY_SCOPES: ReadonlySet<ShareScope> = new Set(["name", "identity", "coordinate"])

// -- Share Grant --
// An explicit, auditable, revocable consent record: "agent <recipientAgentId>
// may receive scope <scope> of subject <subjectKey>". The audit + revoke
// surface (the GDPR / right-to-be-forgotten seam). Lives in its own sibling
// GrantStore collection (`<dir>/_grants/`), NOT on the friend record — grants
// are many-to-many with their own lifecycle.
//
// `subjectKey` (Fork D, brick 3) is an OPAQUE subject key — a semantic widening
// of the former `subjectFriendId`. For a profile share it is the local friend
// UUID; for a mission share it is the mission's `missionKey`. The on-disk value
// is unchanged, so schemaVersion-1 grants (which carried `subjectFriendId`) read
// clean — `FileGrantStore.normalize` reads `subjectKey ?? subjectFriendId` and
// persists forward as `subjectKey`.
export interface ShareGrant {
  id: string                    // stable UUID
  subjectKey: string            // whose data may be shared (friend UUID, or a missionKey)
  recipientAgentId: string      // the agent that may receive it (join-key agentId)
  scope: ShareScope
  grantedAt: string             // ISO date
  /** Optional ISO expiry. A grant past its expiry no longer consents. */
  expiresAt?: string
  /** Set when the grant has been revoked. A revoked grant no longer consents. */
  revokedAt?: string
}

// -- Relationship Outcome --
// Records the result of a shared mission with an agent peer.
export interface RelationshipOutcome {
  missionId: string
  result: "success" | "partial" | "failed"
  timestamp: string
  note?: string
  provenance?: NoteProvenance
}

// -- Mission Key --
// The cross-agent JOIN KEY for a mission (brick 3): a ticket id / repo+PR / a
// slugged name two agents agree on out of band. The mission's analogue of
// `provider:externalId`. NEVER a local UUID on the wire — the mission is named by
// its `missionKey` in every envelope, so the same mission has a different local
// `id` in each agent's store while sharing one join key.
export type MissionKey = string

// -- Mission Learning --
// One first-party fact about the WORK itself (brick 3) — what two agents
// collectively learned doing a mission together. Mirrors a `notes` value:
// timestamped, optionally attributed, and `shareable` (default false —
// private-by-default) marking it eligible for a `"mission"` share. A first-party
// learning is ALWAYS this agent's own and can never be overwritten by an import.
export interface MissionLearning {
  value: string
  savedAt: string
  provenance?: NoteProvenance
  shareable?: boolean
}

// -- Imported Learning --
// One learning accepted from another agent's mission share. Lives in the SEPARATE
// `importedLearnings` namespace (never in first-party `learnings`), keyed by the
// asserting agentId then by learning key — mirroring `ImportedNote` so first-party
// knowledge is structurally inviolable. Carries who introduced it (`assertedBy`)
// and — when the share relayed a fact that originated elsewhere — who FIRST
// asserted it (`originallyAssertedBy`), so an imported learning is never laundered
// into looking first-party.
export interface ImportedLearning {
  value: string
  importedAt: string
  assertedBy?: AgentAttribution
  originallyAssertedBy?: AgentAttribution
}

// -- Mission Task Spec --
// The structured "what B is being asked to do" carried on a delegation REQUEST
// (gap-1, p11 inc2). A delegation request IS a coordination `request` — so this rides
// the EXISTING CoordinationEnvelope as an optional `task?` field (like `proposedAssignee?`
// rides only `handoff`), reusing the "coordinate" identity-tier scope + the consent gate
// + the trust cap + the append-only log already there. `requestId` is the correlation key
// the eventual result-return (gap-2) matches against — minted by the producer, preserved
// through the import, and echoed on the result envelope. Additive; absent ⇒ a plain
// coordination request exactly as before.
export interface MissionTaskSpec {
  /** Correlation key the result-return matches (PINNED). Minted by the producer. */
  requestId: string
  /** What B is being asked to do (the headline ask). */
  summary: string
  /** Optional longer brief. */
  details?: string
  /** Optional structured inputs. */
  inputs?: Record<string, string>
}

// -- Mission Result --
// B's DELIVERABLE on a delegation (gap-2, p11 inc2) — the honest north-star result-
// return channel. NOT a `mission_share` of outcomes/learnings: this is B's actual
// produced artifact, attributed to B, correlated to A's delegation via `requestId`. A
// result is B answering A's OWN delegation request, so it rides the `"coordinate"`
// identity-tier consent scope (no third-party content; A is the very delegator) — NO new
// ShareScope, NO new content grant. `provenance` is first_party on B's side, imported on
// A's. Additive; lands first-party under `MissionRecord.results[requestId]` on B and
// quarantined under `importedResults[agentId][requestId]` on A.
export interface MissionResult {
  /** Correlates to the gap-1 task-spec's requestId (PINNED) — A only accepts a result
   * for a requestId it actually delegated. */
  requestId: string
  /** The headline deliverable — what B produced. */
  summary: string
  /** Optional larger produced artifact body. */
  artifact?: string
  /** Optional structured outputs. */
  outputs?: Record<string, string>
  /** first_party on B's side; imported (attributed to B) on A's. */
  provenance?: NoteProvenance
}

// -- Mission Result Envelope --
// The cross-agent result-return envelope (gap-2). Names the mission by JOIN KEY
// (`missionKey`) — NEVER a local UUID — and carries B's attribution (`fromAgentId`) + the
// delegation correlation key (`requestId`) + the `MissionResult`. A SIBLING of
// `MissionShareEnvelope`/`CoordinationEnvelope` (per-kind compiler-enforced type safety),
// not a widening. Rides the mailbox under the new `kind:"mission_result"`.
export interface MissionResultEnvelope {
  /** The mission, named by its join key — `missionKey` + a human title. */
  subject: { missionKey: string; title: string }
  /** The agent that produced this result (B's join-key agentId) — the attribution. */
  fromAgentId: string
  /** The delegation correlation key (matches the gap-1 task-spec's requestId). */
  requestId: string
  result: MissionResult
  /** Opaque, verifier-specific proof slot. The TOFU verifier ignores it. */
  proof?: string
  issuedAt: string
}

// -- Coordination Intent --
// The coordination verb set (brick 5) — five leaves of one closed union, mirroring
// how `ShareScope` and the transport `kind` are closed unions with a guard. A
// coordination message negotiates exactly one thing: WHO is doing a mission.
//   request  — "will you take this?"  (ask; no assignment effect)
//   offer    — "I'll take this."      (bid; no assignment effect)
//   accept   — "yes, I'm on it."      (answers request|offer; sets assignee = self)
//   decline  — "no / not me."         (answers request|offer; no effect)
//   handoff  — "it's yours now."      (passes a held assignment; proposes assignee,
//                                      the receiver's own accept confirms — non-transitive)
export type CoordinationIntent = "request" | "offer" | "accept" | "decline" | "handoff"

const COORDINATION_INTENTS: ReadonlySet<string> = new Set<CoordinationIntent>([
  "request",
  "offer",
  "accept",
  "decline",
  "handoff",
])

export function isCoordinationIntent(value: unknown): value is CoordinationIntent {
  return typeof value === "string" && COORDINATION_INTENTS.has(value)
}

// -- Coordination Log Entry --
// One logged negotiation step on a mission (brick 5) — attributed, immutable,
// append-only. Mirrors how an imported learning/outcome carries `provenance` so an
// IMPORTED coordination claim is structurally distinguishable from a first-party
// one (the same laundering firewall, re-aimed from a fact at a negotiation step).
export interface CoordinationLogEntry {
  intent: CoordinationIntent
  fromAgentId: string
  note?: string
  at: string                  // ISO
  provenance?: NoteProvenance // first_party | imported — the firewall, re-aimed
}

// -- Mission Coordination --
// The mission's coordinated state (brick 5): who holds it now + the append-only
// negotiation trail. The ONLY persisted coordination effect — an additive
// sub-object on the EXISTING MissionRecord (never a new store). `assignee` is set
// by exactly one transition (`accept`) and replaced by exactly one (`accept` of a
// handoff); `log` only ever grows. A claimed mission has an `assignee`; an
// unclaimed one doesn't. That is the bounded state model in full — one nullable
// field + an append-only log, no state machine, no scheduler.
export interface MissionCoordination {
  assignee?: AgentAttribution // WHO currently holds the mission (claimed). Absent ⇒ unclaimed.
  assignedAt?: string         // ISO; when the current assignee was set
  log: CoordinationLogEntry[] // append-only; every request/offer/accept/decline/handoff that flowed
}

// -- Mission Record --
// A first-class shared MISSION (brick 3): the facts two agents collectively
// learned doing work together. Where a `FriendRecord` answers "who is this person
// + what do I know about them", a `MissionRecord` answers "what did we do
// together, how did it go, what did we collectively learn." It reuses the brick-1
// import machinery (first-party / imported split, attribution, dedupe) re-aimed
// from a person at a mission. Persisted in its own sibling `MissionStore`
// collection (`<dir>/_missions/`), NOT on a friend record — a mission is
// many-to-many with peers and has its own identity/lifecycle.
export interface MissionRecord {
  id: string                                       // stable local UUID (never on the wire)
  missionKey: MissionKey                           // the cross-agent join key
  title: string
  status: "active" | "succeeded" | "partial" | "failed" | "abandoned"
  participants: AgentAttribution[]
  outcomes: RelationshipOutcome[]                  // reused verbatim from the person path
  // first-party learnings (this agent's own knowledge of the work), keyed by a
  // learning key. NEVER overwritten by an import.
  learnings: Record<string, MissionLearning>
  // learnings accepted from other agents' shares, namespaced by the asserting
  // agentId then by learning key — kept structurally apart from first-party
  // `learnings`. Additive — absent on missions that have never imported anything.
  importedLearnings?: Record<string, Record<string, ImportedLearning>>
  // the mission's coordinated state (brick 5): who holds it now + the append-only
  // negotiation trail. Additive — absent on missions that have never been
  // coordinated (so schemaVersion stays 1 and every legacy mission reads clean:
  // absent ⇒ unclaimed). The ONLY persisted coordination effect; never load-bearing
  // under status/learnings/trust.
  coordination?: MissionCoordination
  // first-party delegations this agent ISSUED on this mission (gap-1, p11 inc2),
  // keyed by the minted `requestId`. Each is the task-spec A asked B to do, the
  // delegated-TO agent (`assignee`), plus its first-party provenance. This is the
  // correlation anchor for the result-return: when A later imports B's result, the
  // result's `requestId` must be present HERE AND the result's source must equal this
  // delegation's `assignee` (A only accepts a result for work it actually delegated, and
  // only from the very agent it delegated TO — see importMissionResult's assignee check,
  // security-review inc-2 finding 1). `assignee` is additive + back-tolerant: a legacy
  // delegation record written before this field existed has no `assignee` and the importer
  // FAILS CLOSED on it (a result for an assignee-less delegation is rejected, never landed).
  // Additive overall — absent ⇒ no delegations issued (schemaVersion stays 1; legacy
  // records read clean). NEVER touched by an import.
  delegations?: Record<string, { task: MissionTaskSpec; assignee?: AgentAttribution; provenance: NoteProvenance }>
  // delegation task-specs IMPORTED from a peer's coordination request (gap-1), in a
  // QUARANTINED namespace keyed by the asserting agentId then by `requestId` (mirroring
  // `importedLearnings`). Stamped origin:"imported" + assertedBy + importedAt. Kept
  // structurally apart from first-party `delegations` so an import can never masquerade as
  // a delegation THIS agent issued. Additive — absent until something is imported.
  importedDelegations?: Record<string, Record<string, { task: MissionTaskSpec; provenance: NoteProvenance }>>
  // first-party results this agent PRODUCED on this mission (gap-2, p11 inc2), keyed by
  // the delegation `requestId`. B's own deliverables, stamped first_party. Additive —
  // absent until this agent produces a result. NEVER touched by an import.
  results?: Record<string, MissionResult>
  // results IMPORTED from a peer (gap-2) — B's deliverable landing on A — in a
  // QUARANTINED namespace keyed by the asserting agentId then by `requestId` (mirroring
  // `importedLearnings`). Stamped origin:"imported" + assertedBy + importedAt. Kept
  // structurally apart from first-party `results` so an imported deliverable can never
  // masquerade as one this agent produced. Additive — absent until something is imported.
  importedResults?: Record<string, Record<string, MissionResult>>
  createdAt: string                                // ISO date
  updatedAt: string
  schemaVersion: number
}

// -- Agent Meta --
// Extended metadata for friend records that represent agent peers.
export interface AgentMeta {
  bundleName: string
  familiarity: number
  sharedMissions: string[]
  outcomes: RelationshipOutcome[]
  /** The durable identity home (p11 Item 2 — the DID re-key). `did` is the
   * cross-agent primary key; `pinnedKey` is its TOFU-pinned Ed25519 public key.
   * Additive + optional: legacy records carry only `a2a.did` (or nothing) and
   * migrate-on-read into this shape via `resolveAgentIdentity`. schemaVersion
   * stays 1. */
  identity?: {
    did: string
    pinnedKey?: string
    handle?: string
    pinnedAt?: string
  }
  a2a?: {
    cardUrl?: string
    endpointUrl?: string
    agentId?: string
    protocolVersion?: string
    /** Optional friends-relay coordinates (phase 8). When a peer has no directly
     * reachable A2A `endpointUrl`, the host delivers via the UNTRUSTED relay at
     * `url`, addressing the peer by its opaque `handle`. The relay carries only
     * ciphertext (the E2E sign-then-seal overlay) — it never sees content. Absent
     * on peers reachable directly or only via the git-mailbox fallback. */
    relay?: { url: string; handle: string }
    /** The peer's pinned DID (phase 8 — `did:key:…` or `did:web:…`). `agentId ===
     * did` (the DID is the cross-agent identity primary key); pinned on first
     * contact (TOFU) and verified on every use thereafter. Absent until the peer
     * presents a DID-bearing proof. */
    did?: string
  }
  /** Optional git-mailbox FALLBACK coordinates (the demoted no-endpoint transport;
   * see src/mailbox/). The mailbox is a dedicated PRIVATE repo holding only
   * in-flight envelopes; `selfOutboxAgentId` is the dir THIS peer writes its outbox
   * under. Top-level since phase 8's demote (was nested under `a2a` in alpha.4 —
   * legacy records migrate-on-read). Absent on peers that don't use the fallback. */
  mailbox?: { repo: string; selfOutboxAgentId: string }
}

// -- Friend Record --
// The single merged type for a person the agent interacts with.
// Combines identity (who they are) and notes (what the agent has written about them).
// Stored as a unified JSON record in bundle `friends/`.
export interface FriendRecord {
  id: string                              // stable UUID
  name: string
  role?: string
  trustLevel?: TrustLevel
  connections?: FriendConnection[]
  externalIds: ExternalId[]               // PII
  tenantMemberships: string[]             // PII
  toolPreferences: Record<string, string> // keyed by integration name
  // general friend knowledge (timestamped). `shareable` (default false —
  // private-by-default) marks a note as eligible for `notes:safe` shares; first-
  // party notes are ALWAYS this agent's own and can never be overwritten by an import.
  notes: Record<string, { value: string, savedAt: string, provenance?: NoteProvenance, shareable?: boolean }>
  // facts accepted from other agents' shares, namespaced by the asserting agentId
  // then by note key. Kept structurally apart from first-party `notes` so an
  // import can never clobber first-party knowledge. Additive — absent on records
  // that have never imported anything.
  importedNotes?: Record<string, Record<string, ImportedNote>>
  totalTokens: number                     // cumulative token usage across all turns
  createdAt: string                       // ISO date
  updatedAt: string
  schemaVersion: number
  kind?: "human" | "agent"
  agentMeta?: AgentMeta
}

// -- Sense Type --
// Classifies how a channel is exposed to the outside world.
// "open" = anyone can reach the agent (e.g. iMessage/BlueBubbles)
// "closed" = org-gated, only authenticated users (e.g. Teams)
// "local" = direct terminal access (CLI)
// "internal" = agent-internal (inner dialog)
export type SenseType = "open" | "closed" | "local" | "internal"

// -- Channel Capabilities --
// What a channel supports: integrations, formatting, streaming, message limits
export interface ChannelCapabilities {
  channel: Channel
  senseType: SenseType
  availableIntegrations: Integration[]
  supportsMarkdown: boolean
  supportsStreaming: boolean
  supportsRichCards: boolean
  maxMessageLength: number
}

// -- Resolved Context --
// The per-request bundle resolved by the FriendResolver.
export interface ResolvedContext {
  readonly friend: FriendRecord
  readonly channel: ChannelCapabilities
  /** Whether the current conversation is a group chat (vs 1:1). Default false. */
  readonly isGroupChat?: boolean
}
