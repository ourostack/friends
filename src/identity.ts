// Agent identity migrate-on-read (p11 Item 2 — the DID re-key).
//
// The durable identity home is `AgentMeta.identity` ({ did, pinnedKey?, handle?,
// pinnedAt? }). Legacy records carry only the optional `a2a.did` hint (or nothing).
// `resolveAgentIdentity` reads either, preferring the durable home and lifting
// `a2a.did` on a miss (migrate-on-read), mirroring FileGrantStore.normalize's
// legacy-field handling. `withMigratedIdentity` backfills `identity.did` from
// `a2a.did` so the next `put` persists it forward (migrate-on-write), matching the
// resolver's local-id migration + the grant subjectFriendId→subjectKey pattern.
import type { AgentMeta } from "./types"

/** The resolved durable identity of an agent peer — independent of which on-disk
 * shape carried it. All fields optional: a did-less legacy record reads clean. */
export interface ResolvedAgentIdentity {
  did?: string
  pinnedKey?: string
  handle?: string
  pinnedAt?: string
}

/** Read an agent's durable identity, preferring `meta.identity` and lifting the
 * legacy `meta.a2a.did` on a miss (migrate-on-read). Returns `{}` for a did-less
 * or absent meta. (Unit 4a stub — not implemented.) */
export function resolveAgentIdentity(_meta: AgentMeta | undefined): ResolvedAgentIdentity {
  // RED stub: deliberately wrong (always empty) so the suite fails behaviorally,
  // not on a missing symbol. Implemented GREEN in Unit 4b.
  return {}
}

/** Return a meta whose `identity.did` is backfilled from `a2a.did` when the durable
 * home is absent (migrate-on-write); a meta already carrying `identity` is returned
 * unchanged (no clobber). Absent meta is returned as-is. (Unit 4a stub.) */
export function withMigratedIdentity(meta: AgentMeta | undefined): AgentMeta | undefined {
  // RED stub: identity-passthrough (no backfill) so the backfill test fails.
  return meta
}
