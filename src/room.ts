// resolveRoom — the team / room view (N11). Pure read, NO new persisted state.
//
// A "room" IS its group ExternalId; membership is already materialized on each
// member (every participant carries the group's externalId, via
// upsertGroupContextParticipants). resolveRoom reverse-looks-up every friend
// carrying that group id and composes the per-member trust context that already
// exists — proof N10's shape is right (per-party trust + who-said-what +
// provenance all compose into the room view without any new state).
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { Channel, FriendRecord } from "./types"
import { describeTrustContext } from "./trust-explanation"
import type { TrustExplanation } from "./trust-explanation"

/** How the agent knows a room member:
 * - "direct" — the member carries a per-person identity (a non-group externalId),
 *   so the agent knows them as an individual, not merely as a name in a roster.
 * - "group_only" — the member is known ONLY through this room: the only identities
 *   they carry are group ids. */
export type RoomKnownVia = "direct" | "group_only"

export interface RoomMember {
  friend: FriendRecord
  trust: TrustExplanation
  knownVia: RoomKnownVia
}

export interface RoomView {
  groupExternalId: string
  members: RoomMember[]
}

function isGroupExternalId(externalId: string): boolean {
  return externalId.startsWith("group:")
}

function knownViaFor(friend: FriendRecord): RoomKnownVia {
  const hasNonGroupIdentity = friend.externalIds.some((ext) => !isGroupExternalId(ext.externalId))
  return hasNonGroupIdentity ? "direct" : "group_only"
}

/** Resolve the room identified by `groupExternalId` into its members + each
 * member's trust context + how the agent knows them. `channel` selects the lens
 * for the trust explanation (defaults to the agent-facing "mcp" channel). */
export async function resolveRoom(
  store: FriendStore,
  groupExternalId: string,
  channel: Channel = "mcp",
): Promise<RoomView> {
  const all = typeof store.listAll === "function" ? await store.listAll() : []
  const members: RoomMember[] = all
    .filter((friend) => friend.externalIds.some((ext) => ext.externalId === groupExternalId))
    .map((friend) => ({
      friend,
      trust: describeTrustContext({ friend, channel, isGroupChat: true }),
      knownVia: knownViaFor(friend),
    }))

  emitNervesEvent({
    component: "friends",
    event: "friends.room_resolved",
    message: "resolved room view",
    meta: { groupExternalId, memberCount: members.length },
  })

  return { groupExternalId, members }
}
