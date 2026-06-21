// Consent-grant lifecycle — grantShare / revokeShare / listShares.
//
// The audit + revoke surface over a GrantStore (the GDPR / right-to-be-forgotten
// seam). `grantShare` mints an explicit ShareGrant; `revokeShare` tombstones one
// (sets `revokedAt` rather than deleting, so the audit trail survives);
// `listShares` returns grants with their effective state for inspection. The
// consent policies in `consent.ts` read these grants to decide whether a share is
// permitted — this module owns their CRUD, not the permission decision.
import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "./observability"
import type { GrantStore } from "./grant-store"
import type { ShareGrant, ShareScope } from "./types"

/** Whether a grant currently consents: not revoked, and not past its expiry as
 * of `now`. The single source of truth for "effective", shared by the consent
 * policies and the audit listing. */
export function isGrantEffective(grant: ShareGrant, now: Date = new Date()): boolean {
  if (grant.revokedAt) return false
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now.getTime()) return false
  return true
}

export interface GrantShareInput {
  subjectFriendId: string
  recipientAgentId: string
  scope: ShareScope
  /** Optional ISO expiry; absent ⇒ the grant never expires. */
  expiresAt?: string
}

/** Mint an explicit share grant. Returns the persisted ShareGrant. */
export async function grantShare(grants: GrantStore, input: GrantShareInput): Promise<ShareGrant> {
  const now = new Date().toISOString()
  const grant: ShareGrant = {
    id: randomUUID(),
    subjectFriendId: input.subjectFriendId,
    recipientAgentId: input.recipientAgentId,
    scope: input.scope,
    grantedAt: now,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  }
  await grants.put(grant.id, grant)
  emitNervesEvent({
    component: "friends",
    event: "friends.share_granted",
    message: "granted profile share",
    meta: { subjectFriendId: input.subjectFriendId, recipientAgentId: input.recipientAgentId, scope: input.scope },
  })
  return grant
}

export interface RevokeShareResult {
  ok: boolean
  status: "revoked" | "not_found" | "noop"
  grant?: ShareGrant
}

/** Revoke a grant by id. Tombstones it (sets `revokedAt`) rather than deleting,
 * so the audit trail survives. Re-revoking an already-revoked grant is a noop. */
export async function revokeShare(grants: GrantStore, grantId: string): Promise<RevokeShareResult> {
  const grant = await grants.get(grantId)
  if (!grant) {
    return { ok: false, status: "not_found" }
  }
  if (grant.revokedAt) {
    return { ok: true, status: "noop", grant }
  }
  const revoked: ShareGrant = { ...grant, revokedAt: new Date().toISOString() }
  await grants.put(revoked.id, revoked)
  emitNervesEvent({
    component: "friends",
    event: "friends.share_revoked",
    message: "revoked profile share",
    meta: { grantId },
  })
  return { ok: true, status: "revoked", grant: revoked }
}

export interface ListSharesFilter {
  subjectFriendId?: string
  recipientAgentId?: string
  /** When true, only grants that currently consent (effective) are returned. */
  effectiveOnly?: boolean
}

export interface ListedShare extends ShareGrant {
  /** Whether this grant currently consents (not revoked, not expired). */
  effective: boolean
}

/** List grants with their effective state, optionally filtered by subject /
 * recipient / effectiveness. The inspect-and-revoke surface. */
export async function listShares(grants: GrantStore, filter: ListSharesFilter = {}): Promise<ListedShare[]> {
  const all = await grants.listAll()
  const now = new Date()
  const listed = all
    .filter((g) => filter.subjectFriendId === undefined || g.subjectFriendId === filter.subjectFriendId)
    .filter((g) => filter.recipientAgentId === undefined || g.recipientAgentId === filter.recipientAgentId)
    .map((g) => ({ ...g, effective: isGrantEffective(g, now) }))
    .filter((g) => filter.effectiveOnly !== true || g.effective)

  emitNervesEvent({
    component: "friends",
    event: "friends.shares_listed",
    message: "listed profile shares",
    meta: { count: listed.length },
  })
  return listed
}
