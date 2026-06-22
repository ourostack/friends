// openFileBundle — one-liner wiring of a bundle's friends dir into the two file
// stores, encapsulating the sibling `_grants/` convention. Additive ergonomics;
// the explicit two-store construction stays exported and unchanged.
import { FileFriendStore } from "./store-file"
import { FileGrantStore, grantsDirFor } from "./grant-store-file"
import { FileMissionStore, missionsDirFor } from "./mission-store-file"
import { FileAuditSink, auditPathFor } from "./audit"
import { emitNervesEvent } from "./observability"

export interface FileBundle {
  store: FileFriendStore
  grants: FileGrantStore
  missions: FileMissionStore
  /** Control-plane audit sink (Bug B, finding 3) over the sibling `_audit/control.jsonl`,
   * so the live MCP `set_trust` / `onboard_agent` trust seat write audit records. */
  audit: FileAuditSink
  friendsDir: string
  grantsDir: string
  missionsDir: string
  auditPath: string
}

export function openFileBundle(friendsDir: string): FileBundle {
  const grantsDir = grantsDirFor(friendsDir)
  const missionsDir = missionsDirFor(friendsDir)
  const auditPath = auditPathFor(friendsDir)
  emitNervesEvent({ component: "friends", event: "friends.file_bundle_opened", message: "opened file bundle", meta: {} })
  return {
    store: new FileFriendStore(friendsDir),
    grants: new FileGrantStore(grantsDir),
    missions: new FileMissionStore(missionsDir),
    audit: new FileAuditSink(auditPath),
    friendsDir,
    grantsDir,
    missionsDir,
    auditPath,
  }
}
