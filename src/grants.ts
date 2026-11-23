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
import { isSafeRecordId } from "./util/safe-id"

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,9})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d))?$/

/** Whether text is an ISO 8601 date, or date and time with a zone, that names a real moment. Date.parse alone takes
 * "2099", "1" or "foo 2099" (#222 review). */
export function isIsoDate(text: string): boolean {
  return ISO_DATE.test(text) && !Number.isNaN(Date.parse(text))
}

/** Whether a grant currently consents: not revoked, and not past its expiry as
 * of `now`. The single source of truth for "effective", shared by the consent
 * policies and the audit listing. */
export function isGrantEffective(grant: ShareGrant, now: Date = new Date()): boolean {
  // Any revokedAt revokes, even an empty one, and an expiry that isn't a date can't be honoured, so either way the
  // grant consents to nothing (#222).
  if (grant.revokedAt !== undefined) return false
  if (grant.expiresAt !== undefined) {
    if (!isIsoDate(grant.expiresAt) || Date.parse(grant.expiresAt) <= now.getTime()) return false
  }
  return true
}

export interface GrantShareInput {
  /** The subject whose data may be shared — a friend UUID, or a missionKey
   * (Fork D: opaque subject key). */
  subjectKey: string
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
    subjectKey: input.subjectKey,
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
    meta: { subjectKey: input.subjectKey, recipientAgentId: input.recipientAgentId, scope: input.scope },
  })
  return grant
}

export interface RevokeShareResult {
  ok: boolean
  status: "revoked" | "not_found" | "noop" | "invalid"
  grant?: ShareGrant
  message?: string
}

/** Revoke a grant by id. Tombstones it (sets `revokedAt`) rather than deleting,
 * so the audit trail survives. Re-revoking an already-revoked grant is a noop. */
export async function revokeShare(grants: GrantStore, grantId: string): Promise<RevokeShareResult> {
  if (!isSafeRecordId(grantId)) {
    return { ok: false, status: "invalid", message: "a grant id is one grant_share or list_shares gave: letters, digits, dots, underscores and hyphens, starting with a letter or digit" }
  }
  const grant = await grants.get(grantId)
  if (!grant) {
    return { ok: false, status: "not_found" }
  }
  if (grant.revokedAt !== undefined) {
    return { ok: true, status: "noop", grant }
  }
  // The tombstone goes back where the grant was found, whatever id its contents carry.
  const revoked: ShareGrant = { ...grant, id: grantId, revokedAt: new Date().toISOString() }
  await grants.put(grantId, revoked)
  emitNervesEvent({
    component: "friends",
    event: "friends.share_revoked",
    message: "revoked profile share",
    meta: { grantId },
  })
  return { ok: true, status: "revoked", grant: revoked }
}

export interface ListSharesFilter {
  /** Filter to one subject (a friend UUID, or a missionKey). */
  subjectKey?: string
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
    .filter((g) => filter.subjectKey === undefined || g.subjectKey === filter.subjectKey)
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
