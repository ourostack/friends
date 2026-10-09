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
  let orphanExternalIds: ExternalId[] = []
  const mergingOrphan = orphan && orphan.id !== friendId ? orphan : undefined

  if (mergingOrphan) {
    // A link never moves authority. An orphan that holds any is the operator's call.
    if (
      mergingOrphan.capabilityProfileId !== undefined ||
      mergingOrphan.delegationGrant !== undefined ||
      mergingOrphan.admissionState === "active"
    ) {
      emitNervesEvent({
        level: "warn",
        component: "friends",
        event: "friends.identity_link_refused",
        message: "refused to merge a record that holds authority into another record",
        meta: { orphanId: mergingOrphan.id, targetId: friendId },
      })
      return {
        ok: false,
        status: "conflict_requires_operator",
        message: `external id is held by "${mergingOrphan.name}" (${mergingOrphan.id}), which has a capability profile, delegation grant or active admission; it cannot be merged into "${current.name}" (${friendId}) without an operator decision`,
      }
    }
    mergedNotes = { ...mergingOrphan.notes, ...current.notes }
    orphanExternalIds = mergingOrphan.externalIds.filter(
      (ext) => !(ext.provider === input.provider && ext.externalId === input.externalId),
    )
  }

  // The target keeps its own trust. Write the merged target BEFORE deleting the
  // orphan, so a failure between the two steps leaves both records, not neither.
  const updated: FriendRecord = {
    ...current,
    externalIds: [...newExternalIds, ...orphanExternalIds],
    notes: mergedNotes,
    updatedAt: now,
  }
  await store.put(friendId, updated)
  if (mergingOrphan) await store.delete(mergingOrphan.id)

  return { ok: true, status: mergingOrphan ? "merged" : "linked", record: updated }
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
