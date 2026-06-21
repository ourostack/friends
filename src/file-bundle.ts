// openFileBundle — one-liner wiring of a bundle's friends dir into the two file
// stores, encapsulating the sibling `_grants/` convention. Additive ergonomics;
// the explicit two-store construction stays exported and unchanged.
import { FileFriendStore } from "./store-file"
import { FileGrantStore, grantsDirFor } from "./grant-store-file"
import { emitNervesEvent } from "./observability"

export interface FileBundle {
  store: FileFriendStore
  grants: FileGrantStore
  friendsDir: string
  grantsDir: string
}

export function openFileBundle(friendsDir: string): FileBundle {
  const grantsDir = grantsDirFor(friendsDir)
  emitNervesEvent({ component: "friends", event: "friends.file_bundle_opened", message: "opened file bundle", meta: {} })
  return { store: new FileFriendStore(friendsDir), grants: new FileGrantStore(grantsDir), friendsDir, grantsDir }
}
