// setFriendTrust — structured-result port of the harness's `friend.update`.
//
// Sets a friend's trust level. Mirrors the harness behavior of writing BOTH
// `trustLevel` and `role` to the same level (so the record's coarse role tracks
// its trust). A missing friend is a normal `not_found` result, never a throw.
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { FriendRecord, TrustLevel } from "./types"
import type { FriendOpResult } from "./results"
import type { AuditSink, ControlPlaneAuditRecord } from "./audit"
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
  ctx?: SetFriendTrustContext,
): Promise<FriendOpResult> {
  emitNervesEvent({
    component: "friends",
    event: "friends.trust_set",
    message: "set friend trust",
    meta: { level },
  })

  const current = await store.get(friendId)
  if (!current) {
    // not_found is an early return BEFORE any mutation — and so writes NO audit
    // record. The control-plane log captures actual standing changes only.
    return { ok: false, status: "not_found", message: "friend record not found" }
  }

  const updatedAt = new Date().toISOString()
  const updated: FriendRecord = {
    ...current,
    trustLevel: level,
    role: level,
    updatedAt,
  }
  await store.put(friendId, updated)

  // Bug B — append one control-plane audit record on the successful mutation. The
  // `targetDid` is derived from the record's DID hint (Unit 5b upgrades this to the
  // identity-aware resolver). `actor` defaults to the literal "unknown" when the
  // caller threads no context. No sink ⇒ a clean no-op.
  if (ctx?.sink) {
    const targetDid = current.agentMeta?.a2a?.did
    const record: ControlPlaneAuditRecord = {
      action: "set_trust",
      targetId: friendId,
      ...(targetDid !== undefined ? { targetDid } : {}),
      level,
      ...(ctx.basis !== undefined ? { basis: ctx.basis } : {}),
      actor: ctx.actor ?? "unknown",
      ...(ctx.originSense !== undefined ? { originSense: ctx.originSense } : {}),
      ts: updatedAt,
    }
    await ctx.sink.append(record)
  }

  return { ok: true, status: "updated", record: updated }
}
