// linkExternalId / unlinkExternalId — structured-result port of the harness's
// `friend.link` / `friend.unlink`.
//
// Linking is the cross-channel unification mechanic: when another friend record
// (an "orphan") already holds the external id being linked, the two records are
// merged into the target — the target's notes win on key collision, the higher
// trust level is kept, the orphan's other external ids are folded in, and the
// orphan is deleted. A missing friend is a normal `not_found` result.
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { ExternalId, FriendRecord, IdentityProvider, TrustLevel } from "./types"
import type { FriendOpResult } from "./results"

const TRUST_RANK: Record<string, number> = { family: 4, friend: 3, acquaintance: 2, stranger: 1 }

/* v8 ignore start -- defensive: ?? fallbacks are unreachable when inputs are valid TrustLevel values @preserve */
function higherTrust(a?: TrustLevel, b?: TrustLevel): TrustLevel {
  const rankA = TRUST_RANK[a ?? "stranger"] ?? 1
  const rankB = TRUST_RANK[b ?? "stranger"] ?? 1
  return rankA >= rankB ? (a ?? "stranger") : (b ?? "stranger")
}
/* v8 ignore stop */

export interface LinkExternalIdInput {
  provider: IdentityProvider
  externalId: string
  tenantId?: string
}

export async function linkExternalId(
  store: FriendStore,
  friendId: string,
  input: LinkExternalIdInput,
): Promise<FriendOpResult> {
  emitNervesEvent({
    component: "friends",
    event: "friends.identity_linked",
    message: "linked external identity",
    meta: { provider: input.provider },
  })

  const current = await store.get(friendId)
  if (!current) {
    return { ok: false, status: "not_found", message: "friend record not found" }
  }

  const alreadyLinked = current.externalIds.some(
    (ext) => ext.provider === input.provider && ext.externalId === input.externalId,
  )
  if (alreadyLinked) {
    return { ok: true, status: "noop", message: "identity already linked", record: current }
  }

  const now = new Date().toISOString()
  const linked: ExternalId = {
    provider: input.provider,
    externalId: input.externalId,
    linkedAt: now,
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
  }
  const newExternalIds = [...current.externalIds, linked]

  // Orphan cleanup: find another friend holding this external id. Matched
  // WITHOUT tenantId (D4) so orphan-merge fires across tenant-unqualified
  // records even when this link carries a tenantId.
  const orphan = await store.findByExternalId(input.provider, input.externalId)
  let mergedNotes: FriendRecord["notes"] = { ...current.notes }
  let mergedTrust = current.trustLevel
  let orphanExternalIds: ExternalId[] = []
  let merged = false

  if (orphan && orphan.id !== friendId) {
    mergedNotes = { ...orphan.notes, ...current.notes }
    mergedTrust = higherTrust(current.trustLevel, orphan.trustLevel)
    orphanExternalIds = orphan.externalIds.filter(
      (ext) => !(ext.provider === input.provider && ext.externalId === input.externalId),
    )
    await store.delete(orphan.id)
    merged = true
  }

  const updated: FriendRecord = {
    ...current,
    externalIds: [...newExternalIds, ...orphanExternalIds],
    notes: mergedNotes,
    trustLevel: mergedTrust,
    updatedAt: now,
  }
  await store.put(friendId, updated)

  return { ok: true, status: merged ? "merged" : "linked", record: updated }
}

export interface UnlinkExternalIdInput {
  provider: IdentityProvider
  externalId: string
}

export async function unlinkExternalId(
  store: FriendStore,
  friendId: string,
  input: UnlinkExternalIdInput,
): Promise<FriendOpResult> {
  emitNervesEvent({
    component: "friends",
    event: "friends.identity_unlinked",
    message: "unlinked external identity",
    meta: { provider: input.provider },
  })

  const current = await store.get(friendId)
  if (!current) {
    return { ok: false, status: "not_found", message: "friend record not found" }
  }

  const idx = current.externalIds.findIndex(
    (ext) => ext.provider === input.provider && ext.externalId === input.externalId,
  )
  if (idx === -1) {
    return { ok: false, status: "noop", message: "identity not linked" }
  }

  const filtered = current.externalIds.filter((_, i) => i !== idx)
  const updated: FriendRecord = { ...current, externalIds: filtered, updatedAt: new Date().toISOString() }
  await store.put(friendId, updated)

  return { ok: true, status: "unlinked", record: updated }
}
