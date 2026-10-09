// linkExternalId / unlinkExternalId — structured-result port of the harness's
// `friend.link` / `friend.unlink`.
//
// Linking is the cross-channel unification mechanic: when another friend record
// (an "orphan") already holds the external id being linked, the two records are
// merged into the target — the target's notes win on key collision, the target
// keeps its own trust (a link never raises it), the orphan's other external ids
// are folded in, and the orphan is deleted after the target is written. An orphan
// holding a capability profile, delegation grant or active admission is refused
// (`conflict_requires_operator`). A missing friend is a normal `not_found` result.
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { ExternalId, FriendRecord, IdentityProvider } from "./types"
import type { FriendOpResult } from "./results"

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

  const holds = (record: FriendRecord): boolean =>
    record.externalIds.some((ext) => ext.provider === input.provider && ext.externalId === input.externalId)

  const alreadyLinked = holds(current)

  // Other records holding this external id (matched WITHOUT tenantId, D4, so the merge
  // fires across tenant-unqualified records). When the target already holds the id, a
  // previous merge may have been interrupted before the orphan was deleted: find it
  // again so a retry finishes the job.
  let orphans: FriendRecord[]
  if (alreadyLinked) {
    orphans = typeof store.listAll === "function"
      ? (await store.listAll()).filter((record) => record.id !== friendId && holds(record))
      : []
    if (orphans.length === 0) {
      return { ok: true, status: "noop", message: "identity already linked", record: current }
    }
  } else {
    const orphan = await store.findByExternalId(input.provider, input.externalId)
    orphans = orphan && orphan.id !== friendId ? [orphan] : []
  }

  // A link never moves authority or identity between different standings. An orphan
  // that holds any authority, was revoked, or sits at a different trust level than the
  // target is the operator's call.
  const currentTrust = current.trustLevel ?? "stranger"
  for (const orphan of orphans) {
    if (
      orphan.capabilityProfileId !== undefined ||
      orphan.delegationGrant !== undefined ||
      orphan.admissionState === "active" ||
      orphan.admissionState === "revoked" ||
      (orphan.trustLevel ?? "stranger") !== currentTrust
    ) {
      emitNervesEvent({
        level: "warn",
        component: "friends",
        event: "friends.identity_link_refused",
        message: "refused to merge a record with a different standing into another record",
        meta: { orphanId: orphan.id, targetId: friendId },
      })
      return {
        ok: false,
        status: "conflict_requires_operator",
        message: `external id is held by "${orphan.name}" (${orphan.id}), which has a capability profile, delegation grant, active or revoked admission, or a different trust level than "${current.name}" (${friendId}); it cannot be merged without an operator decision`,
      }
    }
  }

  const now = new Date().toISOString()
  const linked: ExternalId = {
    provider: input.provider,
    externalId: input.externalId,
    linkedAt: now,
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
  }
  const key = (ext: ExternalId) => JSON.stringify([ext.provider, ext.externalId, ext.tenantId ?? null])
  const mergedIds: ExternalId[] = alreadyLinked ? [...current.externalIds] : [...current.externalIds, linked]
  let mergedNotes: FriendRecord["notes"] = { ...current.notes }
  for (const orphan of orphans) {
    mergedNotes = { ...orphan.notes, ...mergedNotes }
    for (const ext of orphan.externalIds) {
      if (ext.provider === input.provider && ext.externalId === input.externalId) continue
      if (!mergedIds.some((have) => key(have) === key(ext))) mergedIds.push(ext)
    }
  }

  // The target keeps its own trust. Write the merged target BEFORE deleting the
  // orphans, so a failure between the two steps leaves both records, not neither.
  const updated: FriendRecord = { ...current, externalIds: mergedIds, notes: mergedNotes, updatedAt: now }
  await store.put(friendId, updated)
  for (const orphan of orphans) await store.delete(orphan.id)

  return { ok: true, status: orphans.length > 0 ? "merged" : "linked", record: updated }
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
  // Drop the claim-journal entry first: if the record write then fails, the id is
  // still on the record and a retry works; the reverse order lets the journal
  // bring the id back on the next read.
  await store.releaseExternalId?.(friendId, current.externalIds[idx])
  const updated: FriendRecord = { ...current, externalIds: filtered, updatedAt: new Date().toISOString() }
  await store.put(friendId, updated)

  return { ok: true, status: "unlinked", record: updated }
}
