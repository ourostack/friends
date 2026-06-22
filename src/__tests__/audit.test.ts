import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join, dirname } from "path"

import { MemoryAuditSink, FileAuditSink, auditPathFor } from "../index"
import type { ControlPlaneAuditRecord } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

function record(overrides: Partial<ControlPlaneAuditRecord> = {}): ControlPlaneAuditRecord {
  return {
    action: "set_trust",
    targetId: "f-1",
    level: "friend",
    actor: "owner",
    ts: NOW,
    ...overrides,
  }
}

describe("auditPathFor", () => {
  it("returns the sibling _audit/control.jsonl under the friends dir", () => {
    expect(auditPathFor("/bundle/friends")).toBe(join("/bundle/friends", "_audit", "control.jsonl"))
  })
})

describe("ControlPlaneAuditRecord.action — additive widening to include 'connect' (p11 inc2)", () => {
  let dirConnect: string
  afterEach(() => {
    if (dirConnect) rmSync(dirConnect, { recursive: true, force: true })
  })

  it("accepts a record with action:'connect' (the new control-plane action)", () => {
    // Type-level assertion: this object must satisfy ControlPlaneAuditRecord with
    // action 'connect'. Before the widening, this fails to type-check.
    const connectRecord: ControlPlaneAuditRecord = {
      action: "connect",
      targetId: "peer-1",
      targetDid: "did:key:zPeer",
      level: "family",
      actor: "owner:stdio",
      originSense: "stdio",
      ts: NOW,
    }
    expect(connectRecord.action).toBe("connect")
  })

  it("still accepts a record with action:'set_trust' (the existing action is unaffected)", () => {
    const setTrustRecord: ControlPlaneAuditRecord = record({ action: "set_trust" })
    expect(setTrustRecord.action).toBe("set_trust")
  })

  it("round-trips a connect-action record through MemoryAuditSink unchanged (append + list)", () => {
    const sink = new MemoryAuditSink()
    const connectRecord = record({ action: "connect", targetId: "peer-1", targetDid: "did:key:zPeer", level: "family", originSense: "stdio" })
    sink.append(connectRecord)
    const listed = sink.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(connectRecord)
    expect(listed[0].action).toBe("connect")
  })

  it("round-trips a connect-action record through FileAuditSink as one JSON line (action preserved)", async () => {
    dirConnect = mkdtempSync(join(tmpdir(), "friends-audit-connect-"))
    const filePath = auditPathFor(join(dirConnect, "friends"))
    const sink = new FileAuditSink(filePath)
    await sink.append(record({ action: "connect", targetId: "peer-1", targetDid: "did:key:zPeer", level: "family", originSense: "stdio" }))
    await sink.append(record({ action: "set_trust", targetId: "f-9", level: "friend" }))
    const lines = readFileSync(filePath, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]) as ControlPlaneAuditRecord
    const second = JSON.parse(lines[1]) as ControlPlaneAuditRecord
    expect(first.action).toBe("connect")
    expect(first.targetId).toBe("peer-1")
    // the value-agnostic JSONL append carries both actions in one log, in order
    expect(second.action).toBe("set_trust")
  })
})

describe("MemoryAuditSink", () => {
  it("is append-only and exposes records in order via list()", () => {
    const sink = new MemoryAuditSink()
    sink.append(record({ level: "acquaintance" }))
    sink.append(record({ level: "friend" }))
    expect(sink.list().map((r) => r.level)).toEqual(["acquaintance", "friend"])
  })

  it("list() returns a copy (mutating it does not corrupt the sink)", () => {
    const sink = new MemoryAuditSink()
    sink.append(record())
    const snapshot = sink.list()
    snapshot.pop()
    expect(sink.list()).toHaveLength(1)
  })
})

describe("FileAuditSink", () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("mkdirs the _audit dir on construction", () => {
    dir = mkdtempSync(join(tmpdir(), "friends-audit-"))
    const filePath = auditPathFor(join(dir, "friends"))
    new FileAuditSink(filePath)
    expect(existsSync(dirname(filePath))).toBe(true)
  })

  it("appends each record as one JSON line (append-only JSONL)", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-audit-"))
    const filePath = auditPathFor(join(dir, "friends"))
    const sink = new FileAuditSink(filePath)
    await sink.append(record({ level: "acquaintance", actor: "a1" }))
    await sink.append(record({ level: "friend", actor: "a2", originSense: "management", basis: "same_account", targetDid: "did:key:zA" }))
    const lines = readFileSync(filePath, "utf-8").trim().split("\n")
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]) as ControlPlaneAuditRecord
    const second = JSON.parse(lines[1]) as ControlPlaneAuditRecord
    expect(first.level).toBe("acquaintance")
    expect(second).toMatchObject({
      level: "friend",
      actor: "a2",
      originSense: "management",
      basis: "same_account",
      targetDid: "did:key:zA",
    })
  })
})
