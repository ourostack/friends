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
// outcomes. The scope is the unit a `ShareGrant` consents to.
export type ShareScope = "name" | "identity" | "notes:safe" | "notes:all" | "outcomes"

const SHARE_SCOPES: ReadonlySet<string> = new Set<ShareScope>(["name", "identity", "notes:safe", "notes:all", "outcomes"])

export function isShareScope(value: unknown): value is ShareScope {
  return typeof value === "string" && SHARE_SCOPES.has(value)
}

/** Identity-only scopes expose the join key (externalIds + name), never note
 * content. The tiered consent policy gates these on trust alone. */
export const IDENTITY_SCOPES: ReadonlySet<ShareScope> = new Set(["name", "identity"])

// -- Share Grant --
// An explicit, auditable, revocable consent record: "agent <recipientAgentId>
// may receive scope <scope> of friend <subjectFriendId>". The audit + revoke
// surface (the GDPR / right-to-be-forgotten seam). Lives in its own sibling
// GrantStore collection (`<dir>/_grants/`), NOT on the friend record — grants
// are many-to-many with their own lifecycle.
export interface ShareGrant {
  id: string                    // stable UUID
  subjectFriendId: string       // whose profile may be shared (local friend UUID)
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

// -- Agent Meta --
// Extended metadata for friend records that represent agent peers.
export interface AgentMeta {
  bundleName: string
  familiarity: number
  sharedMissions: string[]
  outcomes: RelationshipOutcome[]
  a2a?: {
    cardUrl?: string
    endpointUrl?: string
    agentId?: string
    protocolVersion?: string
  }
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
