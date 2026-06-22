// Agent identity migrate-on-read (p11 Item 2 — the DID re-key).
//
// The durable identity home is `AgentMeta.identity` ({ did, pinnedKey?, handle?,
// pinnedAt? }). Legacy records carry only the optional `a2a.did` hint (or nothing).
// `resolveAgentIdentity` reads either, preferring the durable home and lifting
// `a2a.did` on a miss (migrate-on-read), mirroring FileGrantStore.normalize's
// legacy-field handling. `withMigratedIdentity` backfills `identity.did` from
// `a2a.did` so the next `put` persists it forward (migrate-on-write), matching the
// resolver's local-id migration + the grant subjectFriendId→subjectKey pattern.
import { emitNervesEvent } from "./observability"
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
export function resolveAgentIdentity(meta: AgentMeta | undefined): ResolvedAgentIdentity {
  if (!meta) return {}
  // Durable home wins (authoritative). Spread only the present optional fields so
  // a partial identity ({ did } only) doesn't surface undefined keys. SECURITY
  // (finding 6, LOW): an empty-string did is NOT a did — omit it so it can never be a
  // matchable identity key (ties to findFriendByDid's falsy-did guard, finding 4).
  if (meta.identity) {
    const { did, pinnedKey, handle, pinnedAt } = meta.identity
    return {
      ...(did ? { did } : {}),
      ...(pinnedKey !== undefined ? { pinnedKey } : {}),
      ...(handle !== undefined ? { handle } : {}),
      ...(pinnedAt !== undefined ? { pinnedAt } : {}),
    }
  }
  // Migrate-on-read: lift the legacy a2a.did hint when the durable home is absent.
  // A falsy (absent or empty-string) hint is treated as no-did.
  if (meta.a2a?.did) return { did: meta.a2a.did }
  return {}
}

/** Return a meta whose `identity.did` is backfilled from `a2a.did` when the durable
 * home is absent (migrate-on-write); a meta already carrying `identity` is returned
 * unchanged (no clobber). Absent meta is returned as-is. (Unit 4a stub.) */
export function withMigratedIdentity(meta: AgentMeta | undefined): AgentMeta | undefined {
  if (!meta) return undefined
  // Already carries the durable home → no clobber.
  if (meta.identity) return meta
  // Nothing to migrate from → unchanged. A falsy (absent or empty-string) a2a.did is
  // not a real did to backfill (finding 6).
  if (!meta.a2a?.did) return meta
  // Backfill identity.did from the legacy a2a.did so the next put persists forward.
  emitNervesEvent({
    component: "friends",
    event: "friends.identity_migrated",
    message: "backfilled AgentMeta.identity.did from legacy a2a.did",
    meta: { did: meta.a2a.did },
  })
  return { ...meta, identity: { did: meta.a2a.did } }
}
