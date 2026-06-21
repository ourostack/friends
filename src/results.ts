// Structured result shape for the mutating friend helpers.
//
// The harness's friend tools return English strings; the package returns a
// discriminated result the MCP layer (or any caller) can serialize and branch
// on. `ok` carries success/failure; `status` distinguishes the cases that a
// caller must tell apart (override conflict vs not-found vs a real write).
import type { FriendRecord } from "./types"

export type FriendOpStatus =
  | "saved"
  | "updated"
  | "linked"
  | "unlinked"
  | "merged"
  | "noop"
  | "not_found"
  | "override_required"
  | "redirected_to_name"
  | "invalid"
  | "error"

export interface FriendOpResult {
  ok: boolean
  status: FriendOpStatus
  message?: string
  record?: FriendRecord
}
