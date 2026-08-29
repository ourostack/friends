// Friend store abstraction.
// All friend persistence goes through FriendStore -- no friend module imports `fs` directly.

import type { ExternalId, FriendRecord } from "./types"

/** Untrusted create request. The store constructs every persisted field other
 * than the stable ID and display label; callers cannot seed relationship or
 * authority state through identity admission. */
export type ExternalIdCreateCandidate = Pick<FriendRecord, "id" | "name">

export type ExternalIdClaimTarget =
  | { kind: "create"; record: ExternalIdCreateCandidate }
  | { kind: "link"; friendId: string }

export interface ExternalIdClaimInput {
  externalId: ExternalId
  target: ExternalIdClaimTarget
}

export type ExternalIdClaimResult =
  | { ok: true; status: "created" | "linked" | "already_claimed"; record: FriendRecord }
  | { ok: false; status: "collision"; existingFriendId: string }
  | { ok: false; status: "not_found" }

// Domain-specific store for friend records.
// Implementations store unified friend records.
export interface FriendStore {
  get(id: string): Promise<FriendRecord | null>
  put(id: string, record: FriendRecord): Promise<void>
  delete(id: string): Promise<void>
  findByExternalId(provider: string, externalId: string, tenantId?: string): Promise<FriendRecord | null>
  hasAnyFriends?(): Promise<boolean>
  listAll?(): Promise<FriendRecord[]>
}

export interface ExternalIdClaimStore extends FriendStore {
  claimExternalId(input: ExternalIdClaimInput): Promise<ExternalIdClaimResult>
}
