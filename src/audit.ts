// Control-plane audit (Bug B) — an append-only record of every trust mutation.
//
// The control plane is "who changed a peer's standing, from where, and why". The
// package must stay storage-agnostic (and 100%-coverable), so the audit is an
// injectable SINK — not a hard-wired `fs` write — mirroring the observability
// seam and the GrantStore/FileGrantStore split. `setFriendTrust` writes one record
// on a successful mutation; the host wires a `FileAuditSink` (or its own) to
// persist it. With no sink injected, the mutation is unchanged (no-op audit).
import * as fs from "fs"
import * as fsPromises from "fs/promises"
import * as path from "path"
import { emitNervesEvent } from "./observability"
import type { TrustBasis } from "./trust-explanation"
import type { TrustLevel } from "./types"

/** One append-only control-plane audit record. Captures a single control-plane
 * mutation: WHO (`actor`), to WHOM (`targetId` / optional `targetDid`), the resulting
 * `level`, the `basis` it was granted on, the `originSense` it came through, and WHEN
 * (`ts`). The `action` discriminates the mutation kind: `"set_trust"` (a trust-level
 * change — the `setFriendTrust` mutation + the `onboard_agent` trust seat) or
 * `"connect"` (an owner linking one of their own agents into the fleet via `connect_to`
 * — p11 inc2; additive, the JSONL append is value-agnostic so only the type widened). */
export interface ControlPlaneAuditRecord {
  action: "set_trust" | "connect"
  targetId: string
  targetDid?: string
  level: TrustLevel
  basis?: TrustBasis
  actor: string
  originSense?: string
  ts: string
}

/** The append-only sink a control-plane mutation writes through. The host
 * implements it (in-memory in tests, a file/JSONL adapter in production). */
export interface AuditSink {
  append(record: ControlPlaneAuditRecord): Promise<void> | void
}

/** In-memory append-only sink — test/host convenience, mirroring MemoryPinStore.
 * `list()` exposes the records in append order; there is no overwrite. */
export class MemoryAuditSink implements AuditSink {
  private readonly records: ControlPlaneAuditRecord[] = []
  append(record: ControlPlaneAuditRecord): void {
    this.records.push(record)
  }
  list(): ControlPlaneAuditRecord[] {
    return [...this.records]
  }
}

/** The append-only control-plane log file for a given friends directory:
 * `<friendsDir>/_audit/control.jsonl`. A reserved `_`-prefixed sibling (like
 * `_grants/`) so one `--dir` covers it; JSONL so appends never rewrite history. */
export function auditPathFor(friendsDir: string): string {
  return path.join(friendsDir, "_audit", "control.jsonl")
}

/** Filesystem AuditSink — appends each record as one JSON line to
 * `_audit/control.jsonl`. mkdir-on-construct, mirroring FileGrantStore. */
export class FileAuditSink implements AuditSink {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    emitNervesEvent({
      component: "friends",
      event: "friends.audit_sink_init",
      message: "file audit sink initialized",
      meta: {},
    })
  }

  async append(record: ControlPlaneAuditRecord): Promise<void> {
    await fsPromises.appendFile(this.filePath, JSON.stringify(record) + "\n", "utf-8")
  }
}
