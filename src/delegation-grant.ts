// PinnedDelegationGrant — the shape a host keeps in its OWN trusted store (outside
// agent-writable storage) to authorise delegated principal commands from one DID.
// It never touches `FriendRecord`; the friend-record `DelegationGrant` is a record of
// intent only and is never authority.

export interface PinnedDelegationGrant {
  scope: "principal_commands"
  /** The sender DID this grant is pinned to. */
  did: string
  grantedAt: string
  source: string
  /** ISO time after which the grant no longer holds. A non-finite value counts as expired. */
  expiresAt?: string
}

export type PinnedDelegationGrantCheck =
  | { ok: true }
  | { ok: false; reason: "malformed" | "did_mismatch" | "expired" }

const GRANT_KEYS = new Set(["scope", "did", "grantedAt", "source", "expiresAt"])
const REQUIRED_KEYS = ["scope", "did", "grantedAt", "source"]

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}

/** Check one pinned grant against the signer DID and the current time. Exact-key shape
 * validation (anything else is `malformed`), then DID, then expiry. Fails closed. */
export function checkPinnedDelegationGrant(
  grant: unknown,
  input: { did: string; now: Date | number },
): PinnedDelegationGrantCheck {
  if (!grant || typeof grant !== "object" || Array.isArray(grant)) return { ok: false, reason: "malformed" }
  const g = grant as Record<string, unknown>
  const keys = Object.keys(g)
  if (keys.some((key) => !GRANT_KEYS.has(key)) || REQUIRED_KEYS.some((key) => !keys.includes(key))) {
    return { ok: false, reason: "malformed" }
  }
  if (
    g.scope !== "principal_commands"
    || !nonBlank(g.did)
    || !nonBlank(g.source)
    || typeof g.grantedAt !== "string" || Number.isNaN(Date.parse(g.grantedAt))
    || (g.expiresAt !== undefined && typeof g.expiresAt !== "string")
  ) {
    return { ok: false, reason: "malformed" }
  }
  if (g.did !== input.did) return { ok: false, reason: "did_mismatch" }
  if (g.expiresAt !== undefined) {
    const expires = Date.parse(g.expiresAt as string)
    const now = typeof input.now === "number" ? input.now : input.now.getTime()
    if (!Number.isFinite(expires) || !Number.isFinite(now) || now >= expires) return { ok: false, reason: "expired" }
  }
  return { ok: true }
}
