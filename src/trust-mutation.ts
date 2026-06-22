// setFriendTrust — structured-result port of the harness's `friend.update`.
//
// Sets a friend's trust level. Mirrors the harness behavior of writing BOTH
// `trustLevel` and `role` to the same level (so the record's coarse role tracks
// its trust). A missing friend is a normal `not_found` result, never a throw.
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { FriendRecord, TrustLevel } from "./types"
import type { FriendOpResult } from "./results"
import type { AuditSink } from "./audit"
import type { TrustBasis } from "./trust-explanation"

/** Optional control-plane context for a trust mutation (Bug B). When a `sink` is
 * supplied, a successful mutation appends one append-only control-plane audit
 * record carrying WHO (`actor`), the `basis` and `originSense`, and WHEN. All
 * fields are optional so the existing 3-arg callers are unaffected. */
export interface SetFriendTrustContext {
  actor?: string
  originSense?: string
  basis?: TrustBasis
  sink?: AuditSink
}

export async function setFriendTrust(
  store: FriendStore,
  friendId: string,
  level: TrustLevel,
  // RED stub (Unit 2a): the param exists so tests compile, but the audit write is
  // not wired yet (that lands GREEN in Unit 2b). Prefixed `_` to satisfy
  // noUnusedParameters until then.
  _ctx?: SetFriendTrustContext,
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
