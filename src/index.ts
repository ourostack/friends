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
  RelationshipOutcome,
  NoteProvenance,
  ChannelCapabilities,
  ResolvedContext,
  SenseType,
} from "./types"

export type { Facing } from "./channel"
export type { TrustExplanation, TrustBasis } from "./trust-explanation"
export type { FriendStore } from "./store"
export type { FriendResolverParams } from "./resolver"
export type {
  GroupContextParticipant,
  GroupContextUpsertResult,
} from "./group-context"
export type { UsageData } from "./tokens"
export type { FriendOpResult, FriendOpStatus } from "./results"
export type { ApplyFriendNoteInput } from "./notes"

// -- Values --
export {
  TRUSTED_LEVELS,
  isTrustedLevel,
  isIdentityProvider,
  isIntegration,
} from "./types"

export { FileFriendStore } from "./store-file"

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

// -- Observability seam --
// The package emits structured events through a no-op `emitNervesEvent` by
// default. Pass a real emitter via `setNervesEmitter` to forward them (the
// harness wires its nerves emitter here).
export {
  emitNervesEvent,
  setNervesEmitter,
} from "./observability"
export type { NervesEvent, NervesEmitter, LogLevel } from "./observability"
