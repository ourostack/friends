// Control-plane audit (Bug B) — an append-only record of every trust mutation.
//
// The control plane is "who changed a peer's standing, from where, and why". The
// package must stay storage-agnostic (and 100%-coverable), so the audit is an
// injectable SINK — not a hard-wired `fs` write — mirroring the observability
// seam and the GrantStore/FileGrantStore split. `setFriendTrust` writes one record
// on a successful mutation; the host wires a `FileAuditSink` (or its own) to
// persist it. With no sink injected, the mutation is unchanged (no-op audit).
import type { TrustBasis } from "./trust-explanation"
import type { TrustLevel } from "./types"

/** One append-only control-plane audit record. Captures a single trust mutation:
 * WHO (`actor`), to WHOM (`targetId` / optional `targetDid`), the new `level`, the
 * `basis` it was granted on, the `originSense` it came through, and WHEN (`ts`). */
export interface ControlPlaneAuditRecord {
  action: "set_trust"
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
