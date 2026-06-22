// did-aware friend lookup (p11 Item 2 — the DID re-key).
//
// `did` is the durable cross-agent primary key. This pure helper finds a friend
// record by did WITHOUT changing the FriendStore interface contract: it scans
// `store.listAll?.()` and matches on the record's resolved identity
// (`resolveAgentIdentity(f.agentMeta).did`, which already prefers identity.did and
// migrates a2a.did on read). Additive — `findByExternalId` is untouched. A store
// with no `listAll` yields null (the lookup is best-effort, never a throw).
import type { FriendStore } from "./store"
import type { FriendRecord } from "./types"
import { resolveAgentIdentity } from "./identity"

/** Find the friend record whose durable identity DID equals `did`. On a duplicate
 * did, the match is deterministic: the record with the LOWEST `createdAt` wins
 * (stable, not storage-order-dependent). Returns null when no record matches or the
 * store has no `listAll`. (Unit 5a stub — not implemented.) */
export async function findFriendByDid(store: FriendStore, did: string): Promise<FriendRecord | null> {
  if (typeof store.listAll !== "function") return null
  const all = await store.listAll()
  let best: FriendRecord | null = null
  for (const f of all) {
    if (resolveAgentIdentity(f.agentMeta).did !== did) continue
    // Deterministic tie-break on a duplicate did: keep the record with the LOWEST
    // createdAt (stable, independent of storage iteration order).
    if (best === null || f.createdAt < best.createdAt) best = f
  }
  return best
}
