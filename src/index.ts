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
  ChannelCapabilities,
  ResolvedContext,
  SenseType,
} from "./types"

export type { Facing } from "./channel"
export type { TrustExplanation, TrustBasis } from "./trust-explanation"
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

export { upsertGroupContextParticipants } from "./group-context"

export { accumulateFriendTokens } from "./tokens"

export { applyFriendNote } from "./notes"

export { setFriendTrust } from "./trust-mutation"

export { linkExternalId, unlinkExternalId } from "./link-identity"

export { upsertAgentPeer } from "./agent-peer"

export { recordRelationshipOutcome } from "./outcomes"

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
