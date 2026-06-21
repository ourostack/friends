// setFriendTrust — structured-result port of the harness's `friend.update`.
//
// Sets a friend's trust level. Mirrors the harness behavior of writing BOTH
// `trustLevel` and `role` to the same level (so the record's coarse role tracks
// its trust). A missing friend is a normal `not_found` result, never a throw.
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { FriendRecord, TrustLevel } from "./types"
import type { FriendOpResult } from "./results"

export async function setFriendTrust(
  store: FriendStore,
  friendId: string,
  level: TrustLevel,
): Promise<FriendOpResult> {
  emitNervesEvent({
    component: "friends",
    event: "friends.trust_set",
    message: "set friend trust",
    meta: { level },
  })

  const current = await store.get(friendId)
  if (!current) {
    return { ok: false, status: "not_found", message: "friend record not found" }
  }

  const updated: FriendRecord = {
    ...current,
    trustLevel: level,
    role: level,
    updatedAt: new Date().toISOString(),
  }
  await store.put(friendId, updated)
  return { ok: true, status: "updated", record: updated }
}
