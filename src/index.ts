// @ouro.bot/friends — public API barrel.
//
// The who's-who / identity / relationship substrate for agents: a trust ladder
// (family / friend / acquaintance / stranger), multi-party (group) and
// multi-agent (a2a peer) aware, consumed through the FriendStore interface +
// FriendResolver.

// -- Types --
export type {
  FriendRecord,
  FriendConnection,
  ExternalId,
  IdentityProvider,
  Integration,
  Channel,
  TrustLevel,
  AgentMeta,
  AgentAttribution,
  RelationshipOutcome,
  NoteProvenance,
  ImportedNote,
  ShareScope,
  ShareGrant,
  MissionKey,
  MissionLearning,
  ImportedLearning,
  MissionRecord,
  CoordinationIntent,
  CoordinationLogEntry,
  MissionCoordination,
  ChannelCapabilities,
  ResolvedContext,
  SenseType,
} from "./types"

export type { Facing } from "./channel"
export type { TrustExplanation, TrustBasis } from "./trust-explanation"
export type {
  Standing,
  StandingTier,
  StandingTally,
  StandingExplanation,
  StandingRule,
  StandingRuleInput,
} from "./standing"
export type { FriendStore } from "./store"
export type { GrantStore } from "./grant-store"
export type { MissionStore } from "./mission-store"
export type { FriendResolverParams } from "./resolver"
export type {
  GroupContextParticipant,
  GroupContextUpsertResult,
} from "./group-context"
export type { UsageData } from "./tokens"
export type { FriendOpResult, FriendOpStatus } from "./results"
export type { ApplyFriendNoteInput } from "./notes"
export type { RoomView, RoomMember, RoomKnownVia } from "./room"
export type {
  ConsentPolicy,
  ConsentRecipient,
  ConsentDecisionInput,
} from "./consent"
export type { AgentVerifier } from "./verifier"
export type {
  ProfileShareEnvelope,
  SharedNote,
  PrepareProfileShareInput,
  PrepareProfileShareResult,
  PrepareProfileShareStatus,
  ImportProfileShareInput,
  ImportProfileShareOptions,
  ImportProfileShareResult,
  ImportProfileShareStatus,
} from "./share"
export type {
  GrantShareInput,
  RevokeShareResult,
  ListSharesFilter,
  ListedShare,
} from "./grants"

// -- Values --
export {
  TRUSTED_LEVELS,
  IDENTITY_SCOPES,
  isTrustedLevel,
  isIdentityProvider,
  isIntegration,
  isShareScope,
  isCoordinationIntent,
} from "./types"

export { FileFriendStore } from "./store-file"
export { FileGrantStore, grantsDirFor } from "./grant-store-file"
export { FileMissionStore, missionsDirFor } from "./mission-store-file"
export { openFileBundle } from "./file-bundle"
export type { FileBundle } from "./file-bundle"

export {
  FriendResolver,
  machineOwnerUsername,
  isLocalMachineOwnerIdentity,
  _setMachineOwnerUsernameForTest,
} from "./resolver"

export {
  getChannelCapabilities,
  channelToFacing,
  isRemoteChannel,
  getAlwaysOnSenseNames,
} from "./channel"

export { describeTrustContext } from "./trust-explanation"

// -- Earned standing (brick four): advisory, first-party, derived; never writes trust --
export { assessStanding, explainStanding, DEFAULT_STANDING_RULE } from "./standing"

export { upsertGroupContextParticipants } from "./group-context"

export { accumulateFriendTokens } from "./tokens"

export { applyFriendNote } from "./notes"

export { setFriendTrust } from "./trust-mutation"
export type { SetFriendTrustContext } from "./trust-mutation"

// -- Control-plane audit (Bug B): append-only record of trust mutations --
export { MemoryAuditSink, FileAuditSink, auditPathFor } from "./audit"
export type { AuditSink, ControlPlaneAuditRecord } from "./audit"

export { linkExternalId, unlinkExternalId } from "./link-identity"

export { upsertAgentPeer } from "./agent-peer"

// -- Agent identity (p11 Item 2 — DID re-key): durable home + migrate-on-read --
export { resolveAgentIdentity, withMigratedIdentity } from "./identity"
export type { ResolvedAgentIdentity } from "./identity"

// did-aware friend lookup (the durable cross-agent primary key is the DID).
export { findFriendByDid } from "./friend-lookup"

export { recordRelationshipOutcome } from "./outcomes"

export { recordMission } from "./missions"
export type { RecordMissionInput } from "./missions"

export { whoami } from "./whoami"
export type { WhoamiResult } from "./whoami"

export { resolveRoom } from "./room"

// -- Cross-agent moat (N12): consent · share · import --
// The consent posture is a one-line swap: DEFAULT_CONSENT_POLICY in consent.ts
// (the SWAP POINT). strictPolicy / trustImpliedPolicy / tieredPolicy are the
// three selectable postures; tieredPolicy is the default.
export {
  strictPolicy,
  trustImpliedPolicy,
  tieredPolicy,
  DEFAULT_CONSENT_POLICY,
} from "./consent"

export { tofuVerifier, DEFAULT_AGENT_VERIFIER } from "./verifier"

export { prepareProfileShare, importProfileShare } from "./share"

export { prepareMissionShare, importMissionShare } from "./mission-share"
export type {
  MissionShareEnvelope,
  SharedLearning,
  PrepareMissionShareInput,
  PrepareMissionShareResult,
  PrepareMissionShareStatus,
  ImportMissionShareInput,
  ImportMissionShareOptions,
  ImportMissionShareResult,
  ImportMissionShareStatus,
} from "./mission-share"

// -- Coordination / delegation (brick five): negotiate WHO does a mission --
// Five verbs (request/offer/accept/decline/handoff) over kind:"coordination";
// the ONLY persisted effect is the mission's `coordination` sub-object (assignee +
// an append-only log). Trust-gated + consent-gated (the "coordinate" scope),
// first-party-inviolable, non-transitive (a handoff never forces an assignee).
export { prepareCoordination, importCoordination } from "./coordination"
export type {
  CoordinationEnvelope,
  PrepareCoordinationInput,
  PrepareCoordinationResult,
  PrepareCoordinationStatus,
  ImportCoordinationInput,
  ImportCoordinationOptions,
  ImportCoordinationResult,
  ImportCoordinationStatus,
} from "./coordination"

export { grantShare, revokeShare, listShares, isGrantEffective } from "./grants"

// -- Observability seam --
// The package emits structured events through a no-op `emitNervesEvent` by
// default. Pass a real emitter via `setNervesEmitter` to forward them (the
// harness wires its nerves emitter here).
export {
  emitNervesEvent,
  setNervesEmitter,
} from "./observability"
export type { NervesEvent, NervesEmitter, LogLevel } from "./observability"
