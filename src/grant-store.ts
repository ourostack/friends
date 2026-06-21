// Grant store abstraction.
// Consent state (ShareGrant records) persists through GrantStore — a sibling to
// FriendStore, mirroring its shape. Grants are many-to-many (one subject ↔ many
// recipients ↔ many scopes) with their own lifecycle, so they live in their own
// collection rather than on the friend record. No grant module imports `fs`
// directly except the FileGrantStore adapter.

import type { ShareGrant } from "./types"

// Domain-specific store for share-grant records.
export interface GrantStore {
  get(id: string): Promise<ShareGrant | null>
  put(id: string, grant: ShareGrant): Promise<void>
  delete(id: string): Promise<void>
  listAll(): Promise<ShareGrant[]>
}
