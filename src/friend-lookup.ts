// did-aware friend lookup (p11 Item 2 — the DID re-key).
//
// `did` is the durable cross-agent primary key. This pure helper finds a friend
// record by did WITHOUT changing the FriendStore interface contract: it scans
// `store.listAll?.()` and matches on the record's resolved identity
// (`resolveAgentIdentity(f.agentMeta).did`, which already prefers identity.did and
// migrates a2a.did on read). Additive — `findByExternalId` is untouched. A store
// with no `listAll` yields null (the lookup is best-effort, never a throw).
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { FriendRecord } from "./types"
import { resolveAgentIdentity } from "./identity"

/** Whether `candidate` should replace the current best among duplicate-did records.
 *
 * SECURITY (finding 5, MEDIUM): the tie-break must NOT reward back-dating — the old
 * "lowest createdAt wins" rule let an attacker mint a duplicate-did record with an
 * earlier createdAt to silently shadow a legit one. Instead:
 *  1) Prefer a trust-relevant signal — a record carrying a TOFU-pinned key
 *     (`pinnedKey`) is the verified one and beats an unpinned duplicate.
 *  2) When pinned-status is equal, break the tie by the record `id` (a stable,
 *     non-temporal key) — back-dating `createdAt` no longer gains anything. */
function preferOverBest(candidate: FriendRecord, best: FriendRecord): boolean {
  const candidatePinned = resolveAgentIdentity(candidate.agentMeta).pinnedKey !== undefined
  const bestPinned = resolveAgentIdentity(best.agentMeta).pinnedKey !== undefined
  if (candidatePinned !== bestPinned) return candidatePinned // pinned beats unpinned
  return candidate.id < best.id // stable, non-temporal tie-break
}

/** Find the friend record whose durable identity DID equals `did`. A DUPLICATE did is
 * an anomaly: it emits a loud `friends.duplicate_did` warning and resolves
 * deterministically WITHOUT rewarding back-dating — a pinned/verified record wins, else
 * the lowest record `id` (a stable, non-temporal tie-break) — see {@link preferOverBest}.
 * Returns null when no record matches, the query did is falsy, or the store has no
 * `listAll`. */
export async function findFriendByDid(store: FriendStore, did: string): Promise<FriendRecord | null> {
  // SECURITY (finding 4, MEDIUM): a falsy did query must never match. Without this,
  // findFriendByDid(store, undefined|"") matched the first did-less record (a did-less
  // record resolves to `undefined`, and `undefined !== undefined` is false → match).
  if (!did) return null
  if (typeof store.listAll !== "function") return null
  const all = await store.listAll()
  let best: FriendRecord | null = null
  let matchCount = 0
  for (const f of all) {
    const resolvedDid = resolveAgentIdentity(f.agentMeta).did
    // Skip records whose resolved did is falsy (absent/empty) so they can never match —
    // belt-and-braces with resolveAgentIdentity's own empty-string guard (finding 6).
    if (!resolvedDid || resolvedDid !== did) continue
    matchCount += 1
    if (best === null || preferOverBest(f, best)) best = f
  }
  // SECURITY (finding 5): a duplicate did is itself an anomaly — surface it loudly so a
  // shadowing attempt is visible, rather than silently resolving it away.
  if (matchCount > 1) {
    emitNervesEvent({
      level: "warn",
      component: "friends",
      event: "friends.duplicate_did",
      message: `duplicate did detected across ${matchCount} friend records — resolving to the pinned/lowest-id record (NOT lowest-createdAt); investigate possible record shadowing`,
      meta: { did, matchCount },
    })
  }
  return best
}
