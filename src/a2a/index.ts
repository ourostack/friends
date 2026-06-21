// src/a2a — the pure git-mailbox format/routing/dedup library (brick two).
//
// A consumer agent and a producer agent that authenticate as two DISTINCT git
// identities share a dedicated PRIVATE mailbox repo. This module computes the
// per-message file PATH + BYTES the host writes, and parses/validates/orders/
// dedups the files the host hands back — nothing more. It is PURE:
//   • ZERO runtime deps; the ONLY node builtin is `node:crypto` (randomUUID),
//     mirroring share.ts / agent-peer.ts;
//   • NO fs / net / http / child_process / process.env / git anywhere — the wire
//     (clone / pull / add / commit / push) is entirely the caller's job.
// Type-only imports of `ProfileShareEnvelope` (../share) + `MissionShareEnvelope`
// (../mission-share) carry no runtime edge. Both are CORE modules, so the a2a→core
// import direction is eslint-legal (a2a may import core; the reverse is forbidden).
//
// Security model (the git-native TOFU): addressing lives in the PATH, and a
// single-writer-per-outbox-dir layout means a forged sender can't write into
// another agent's outbox dir without that git identity. `readIncoming` binds the
// wrapper's claimed from/to against the path and REJECTS any mismatch, so a
// hostile mailbox can only DENY or REPLAY — never escalate (content trust is the
// import layer's job; this layer never touches first-party notes or trust).
import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "../observability"
import type { ProfileShareEnvelope } from "../share"
import type { MissionShareEnvelope } from "../mission-share"

/** The mailbox wire-format version. Bumped only on a breaking message change. */
export const MAILBOX_VERSION = 1

/** A mailbox message: the TRANSPORT wrapper around a verbatim share envelope. The
 * wrapper's from/to are the post-office addressing (validated against the path);
 * the envelope's own `fromAgentId` is the producing-agent claim and is NEVER
 * mutated by this module. */
export interface MailboxMessage {
  mailboxVersion: number
  messageId: string
  fromAgentId: string
  toAgentId: string
  issuedAt: string
  /** The payload discriminant. The host branches on it to call importProfileShare
   * vs importMissionShare. The mailbox itself is payload-agnostic. */
  kind: "profile_share" | "mission_share"
  envelope: ProfileShareEnvelope | MissionShareEnvelope
}

export interface BuildOutgoingInput {
  envelope: ProfileShareEnvelope | MissionShareEnvelope
  fromAgentId: string
  toAgentId: string
  /** The payload discriminant. Defaults to "profile_share" for backward-compat;
   * a mission share passes "mission_share". */
  kind?: "profile_share" | "mission_share"
  /** Injectable ISO clock for deterministic tests; defaults to now. */
  now?: string
}

export interface BuildOutgoingResult {
  /** git-relative POSIX path: agents/<from>/outbox/<to>/<issuedAt>--<msgId>.json */
  relativePath: string
  /** The exact file contents the host writes (pretty-printed JSON). */
  bytes: string
  messageId: string
}

/** Compute the mailbox file (path + bytes) for one outgoing share. Does NOT
 * write anything — the host does the git op. The envelope is carried verbatim
 * (by reference, never cloned or mutated). */
export function buildOutgoing(input: BuildOutgoingInput): BuildOutgoingResult {
  const now = input.now ?? new Date().toISOString()
  const messageId = randomUUID()
  const message: MailboxMessage = {
    mailboxVersion: MAILBOX_VERSION,
    messageId,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    issuedAt: now,
    kind: input.kind ?? "profile_share",
    envelope: input.envelope,
  }
  // Mailbox paths are git-relative POSIX (always `/`), intentionally NOT
  // path.join — that would pull an fs-adjacent builtin and be platform-sep
  // sensitive. A template literal keeps this module fs-free.
  const relativePath = `agents/${input.fromAgentId}/outbox/${input.toAgentId}/${now}--${messageId}.json`
  emitNervesEvent({
    component: "friends",
    event: "friends.a2a_outgoing_built",
    message: "built outgoing mailbox message",
    meta: { toAgentId: input.toAgentId },
  })
  return { relativePath, bytes: JSON.stringify(message, null, 2), messageId }
}

/** One file handed to `readIncoming`: its git-relative POSIX path + raw bytes. */
export interface IncomingFile {
  relativePath: string
  bytes: string
}

/** A validated, path-bound, self-addressed message ready to import. The `kind`
 * is the load-bearing routing primitive — the host branches on it to call
 * importProfileShare vs importMissionShare. */
export interface IncomingMessage {
  messageId: string
  fromAgentId: string
  toAgentId: string
  issuedAt: string
  kind: "profile_share" | "mission_share"
  envelope: ProfileShareEnvelope | MissionShareEnvelope
  relativePath: string
}

export interface ReadIncomingInput {
  files: IncomingFile[]
  selfAgentId: string
  seen: SeenLedger
  /** Injectable ISO clock for the audit emit; defaults to now. */
  now?: string
}

/** A file that failed validation, with the specific reason. */
export interface RejectedMessage {
  relativePath: string
  reason: string
}

export interface ReadIncomingResult {
  ready: IncomingMessage[]
  /** messageIds skipped because already in the seen ledger (replay-safe). */
  skippedSeen: string[]
  rejected: RejectedMessage[]
}

/** Parse the post-office path. Returns the owner/routing dirs, or null when the
 * path doesn't match `agents/<from>/outbox/<to>/<file>.json` exactly. */
function parsePath(relativePath: string): { from: string; to: string } | null {
  const parts = relativePath.split("/")
  if (parts.length !== 5) return null
  if (parts[0] !== "agents" || parts[2] !== "outbox") return null
  if (parts.some((segment) => segment.length === 0)) return null
  if (!parts[4].endsWith(".json")) return null
  return { from: parts[1], to: parts[3] }
}

/** Whether a parsed value is a well-formed mailbox wrapper. */
function isWellFormedWrapper(value: Record<string, unknown>): boolean {
  return (
    typeof value.mailboxVersion === "number" &&
    typeof value.messageId === "string" &&
    value.messageId.length > 0 &&
    typeof value.fromAgentId === "string" &&
    typeof value.toAgentId === "string" &&
    typeof value.issuedAt === "string" &&
    (value.kind === "profile_share" || value.kind === "mission_share") &&
    typeof value.envelope === "object" &&
    value.envelope !== null &&
    !Array.isArray(value.envelope)
  )
}

/** Lexicographic compare of two strings → -1 | 0 | 1. */
function cmp(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Deterministic delivery order: issuedAt ascending, tiebroken by messageId
 * ascending. Exported so the ordering contract is independently testable in both
 * argument orders (every branch reachable). */
export function compareReady(a: IncomingMessage, b: IncomingMessage): number {
  const byTime = cmp(a.issuedAt, b.issuedAt)
  return byTime !== 0 ? byTime : cmp(a.messageId, b.messageId)
}

/** Parse, validate, path-bind, address-filter, and dedup a batch of mailbox
 * files. The security-critical reader: every reject reason is distinct so the
 * caller can tell a spoof (path mismatch) from malformed input. Order of checks:
 * path → JSON → object → wrapper shape → version → path-binding → addressing →
 * dedup. A message addressed to someone else is silently skipped (not ours);
 * only a malformed PATH makes a non-self message visible (as rejected). */
export function readIncoming(input: ReadIncomingInput): ReadIncomingResult {
  const ready: IncomingMessage[] = []
  const skippedSeen: string[] = []
  const rejected: RejectedMessage[] = []

  for (const file of input.files) {
    const path = parsePath(file.relativePath)
    if (!path) {
      rejected.push({ relativePath: file.relativePath, reason: "malformed_path" })
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(file.bytes)
    } catch {
      rejected.push({ relativePath: file.relativePath, reason: "invalid_json" })
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      rejected.push({ relativePath: file.relativePath, reason: "not_an_object" })
      continue
    }

    const message = parsed as Record<string, unknown>
    if (!isWellFormedWrapper(message)) {
      rejected.push({ relativePath: file.relativePath, reason: "malformed_message" })
      continue
    }

    if (message.mailboxVersion !== MAILBOX_VERSION) {
      rejected.push({ relativePath: file.relativePath, reason: "unsupported_version" })
      continue
    }

    // Path-binding (TOFU): a forged sender that doesn't own the outbox dir, or a
    // wrapper routed to a dir it doesn't address, is rejected — never delivered.
    if (message.fromAgentId !== path.from) {
      rejected.push({ relativePath: file.relativePath, reason: "from_path_mismatch" })
      continue
    }
    if (message.toAgentId !== path.to) {
      rejected.push({ relativePath: file.relativePath, reason: "to_path_mismatch" })
      continue
    }

    // Addressing: a message for someone else is not ours to read — skip silently.
    if (message.toAgentId !== input.selfAgentId) continue

    const messageId = message.messageId as string
    if (isSeen(input.seen, messageId)) {
      skippedSeen.push(messageId)
      continue
    }

    ready.push({
      messageId,
      fromAgentId: message.fromAgentId as string,
      toAgentId: message.toAgentId as string,
      issuedAt: message.issuedAt as string,
      kind: message.kind as IncomingMessage["kind"],
      envelope: message.envelope as ProfileShareEnvelope | MissionShareEnvelope,
      relativePath: file.relativePath,
    })
  }

  // Deterministic delivery order: issuedAt ascending, tiebroken by messageId.
  ready.sort(compareReady)

  emitNervesEvent({
    component: "friends",
    event: "friends.a2a_incoming_read",
    message: "read incoming mailbox files",
    meta: {
      ready: ready.length,
      skipped: skippedSeen.length,
      rejected: rejected.length,
      at: input.now ?? new Date().toISOString(),
    },
  })

  return { ready, skippedSeen, rejected }
}

/** The exactly-once dedup ledger: messageId → ISO timestamp it was first seen.
 * Host-owned (the proof/host persists it, e.g. `_a2a/seen.json`) — this module
 * only reads and functionally updates it. */
export interface SeenLedger {
  seen: Record<string, string>
}

/** Whether a messageId is already in the ledger. Uses hasOwnProperty so an
 * inherited prototype key (e.g. "toString") never reads as seen. */
export function isSeen(seen: SeenLedger, messageId: string): boolean {
  return Object.prototype.hasOwnProperty.call(seen.seen, messageId)
}

/** Return a NEW ledger with `messageId` recorded (immutable — never mutates the
 * input). `at` defaults to now; that single `new Date()` is the only ambient
 * time minted here and matches share.ts's idiom. */
export function markSeen(seen: SeenLedger, messageId: string, at?: string): SeenLedger {
  emitNervesEvent({
    component: "friends",
    event: "friends.a2a_marked_seen",
    message: "marked mailbox message seen",
    meta: {},
  })
  return { seen: { ...seen.seen, [messageId]: at ?? new Date().toISOString() } }
}
