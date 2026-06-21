import { describe, it, expect } from "vitest"

import {
  MAILBOX_VERSION,
  buildOutgoing,
  readIncoming,
  compareReady,
  isSeen,
  markSeen,
} from "../a2a"
import type { MailboxMessage, IncomingFile, IncomingMessage, SeenLedger } from "../a2a"
import type { ProfileShareEnvelope } from "../share"
import type { MissionShareEnvelope } from "../mission-share"

const NOW = "2026-03-14T18:00:00.000Z"

function missionEnvelope(overrides: Partial<MissionShareEnvelope> = {}): MissionShareEnvelope {
  return {
    subject: { missionKey: "PROJ-1234", title: "Ship it" },
    fromAgentId: "agent-a",
    scope: "mission",
    learnings: [{ key: "gotcha", value: "rebase not merge" }],
    issuedAt: NOW,
    ...overrides,
  }
}

function envelope(overrides: Partial<ProfileShareEnvelope> = {}): ProfileShareEnvelope {
  return {
    subject: {
      externalIds: [{ provider: "aad", externalId: "p@example.com", linkedAt: NOW }],
      displayName: "P",
    },
    fromAgentId: "agent-a",
    scope: "notes:safe",
    notes: [{ key: "team", value: "Platform" }],
    issuedAt: NOW,
    ...overrides,
  }
}

const emptyLedger: SeenLedger = { seen: {} }

/** Build a well-formed incoming file from a wrapper message, JSON-serialized. */
function fileFor(message: MailboxMessage): IncomingFile {
  return {
    relativePath: `agents/${message.fromAgentId}/outbox/${message.toAgentId}/${message.issuedAt}--${message.messageId}.json`,
    bytes: JSON.stringify(message, null, 2),
  }
}

function wrapper(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    mailboxVersion: MAILBOX_VERSION,
    messageId: "msg-1",
    fromAgentId: "agent-a",
    toAgentId: "agent-b",
    issuedAt: NOW,
    kind: "profile_share",
    envelope: envelope(),
    ...overrides,
  }
}

describe("buildOutgoing", () => {
  it("builds the exact post-office path with injected now (deterministic)", () => {
    const out = buildOutgoing({ envelope: envelope(), fromAgentId: "agent-a", toAgentId: "agent-b", now: NOW })
    expect(out.relativePath).toBe(`agents/agent-a/outbox/agent-b/${NOW}--${out.messageId}.json`)
  })

  it("serializes a MailboxMessage with kind profile_share and the verbatim envelope", () => {
    const env = envelope()
    const out = buildOutgoing({ envelope: env, fromAgentId: "agent-a", toAgentId: "agent-b", now: NOW })
    const parsed = JSON.parse(out.bytes) as MailboxMessage
    expect(parsed.mailboxVersion).toBe(MAILBOX_VERSION)
    expect(parsed.kind).toBe("profile_share")
    expect(parsed.fromAgentId).toBe("agent-a")
    expect(parsed.toAgentId).toBe("agent-b")
    expect(parsed.issuedAt).toBe(NOW)
    expect(parsed.messageId).toBe(out.messageId)
    // envelope is carried verbatim (deep-equal, content untouched).
    expect(parsed.envelope).toEqual(env)
  })

  it("does not clone or mutate the envelope passed in", () => {
    const env = envelope()
    buildOutgoing({ envelope: env, fromAgentId: "agent-a", toAgentId: "agent-b", now: NOW })
    expect(env.scope).toBe("notes:safe")
    expect(env.notes).toEqual([{ key: "team", value: "Platform" }])
  })

  it("mints a uuid messageId", () => {
    const out = buildOutgoing({ envelope: envelope(), fromAgentId: "agent-a", toAgentId: "agent-b", now: NOW })
    expect(out.messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it("defaults now to the current time when omitted (covers the ?? branch)", () => {
    const out = buildOutgoing({ envelope: envelope(), fromAgentId: "agent-a", toAgentId: "agent-b" })
    // A real ISO timestamp landed; the path embeds it.
    expect(out.relativePath).toMatch(/^agents\/agent-a\/outbox\/agent-b\/.+--.+\.json$/)
    const parsed = JSON.parse(out.bytes) as MailboxMessage
    expect(() => new Date(parsed.issuedAt).toISOString()).not.toThrow()
    expect(parsed.issuedAt).not.toBe("")
  })
})

describe("buildOutgoing — kind discriminant (brick 3)", () => {
  it("defaults kind to profile_share when omitted (backward-compat)", () => {
    const out = buildOutgoing({ envelope: envelope(), fromAgentId: "agent-a", toAgentId: "agent-b", now: NOW })
    const parsed = JSON.parse(out.bytes) as MailboxMessage
    expect(parsed.kind).toBe("profile_share")
  })

  it("stamps kind:mission_share on the wrapper when requested, carrying the mission envelope verbatim", () => {
    const env = missionEnvelope()
    const out = buildOutgoing({ envelope: env, fromAgentId: "agent-a", toAgentId: "agent-b", kind: "mission_share", now: NOW })
    const parsed = JSON.parse(out.bytes) as MailboxMessage
    expect(parsed.kind).toBe("mission_share")
    expect(parsed.envelope).toEqual(env)
  })

  it("stamps kind:profile_share explicitly when requested", () => {
    const out = buildOutgoing({ envelope: envelope(), fromAgentId: "agent-a", toAgentId: "agent-b", kind: "profile_share", now: NOW })
    expect((JSON.parse(out.bytes) as MailboxMessage).kind).toBe("profile_share")
  })
})

describe("readIncoming — kind propagation (brick 3)", () => {
  it("accepts a mission_share wrapper and surfaces kind:mission_share on the IncomingMessage", () => {
    const out = buildOutgoing({ envelope: missionEnvelope(), fromAgentId: "agent-a", toAgentId: "agent-b", kind: "mission_share", now: NOW })
    const result = readIncoming({
      files: [{ relativePath: out.relativePath, bytes: out.bytes }],
      selfAgentId: "agent-b",
      seen: emptyLedger,
    })
    expect(result.rejected).toEqual([])
    expect(result.ready).toHaveLength(1)
    expect(result.ready[0].kind).toBe("mission_share")
    expect(result.ready[0].envelope).toEqual(missionEnvelope())
  })

  it("surfaces kind:profile_share for a profile_share wrapper", () => {
    const out = buildOutgoing({ envelope: envelope(), fromAgentId: "agent-a", toAgentId: "agent-b", now: NOW })
    const result = readIncoming({
      files: [{ relativePath: out.relativePath, bytes: out.bytes }],
      selfAgentId: "agent-b",
      seen: emptyLedger,
    })
    expect(result.ready).toHaveLength(1)
    expect(result.ready[0].kind).toBe("profile_share")
  })
})

describe("readIncoming — happy path", () => {
  it("returns the message buildOutgoing produced when self is the recipient", () => {
    const out = buildOutgoing({ envelope: envelope(), fromAgentId: "agent-a", toAgentId: "agent-b", now: NOW })
    const result = readIncoming({
      files: [{ relativePath: out.relativePath, bytes: out.bytes }],
      selfAgentId: "agent-b",
      seen: emptyLedger,
    })
    expect(result.rejected).toEqual([])
    expect(result.skippedSeen).toEqual([])
    expect(result.ready).toHaveLength(1)
    expect(result.ready[0].messageId).toBe(out.messageId)
    expect(result.ready[0].fromAgentId).toBe("agent-a")
    expect(result.ready[0].toAgentId).toBe("agent-b")
    expect(result.ready[0].relativePath).toBe(out.relativePath)
    expect(result.ready[0].envelope).toEqual(envelope())
    expect(result.ready[0].kind).toBe("profile_share")
  })

  it("accepts an injected now (covers the readIncoming now branch)", () => {
    const result = readIncoming({ files: [], selfAgentId: "agent-b", seen: emptyLedger, now: NOW })
    expect(result.ready).toEqual([])
    expect(result.skippedSeen).toEqual([])
    expect(result.rejected).toEqual([])
  })

  it("defaults now when omitted on readIncoming (covers the ?? right side)", () => {
    const result = readIncoming({ files: [], selfAgentId: "agent-b", seen: emptyLedger })
    expect(result.ready).toEqual([])
  })
})

describe("readIncoming — dedup / replay", () => {
  it("skips a message already in the seen ledger", () => {
    const out = buildOutgoing({ envelope: envelope(), fromAgentId: "agent-a", toAgentId: "agent-b", now: NOW })
    const seen = markSeen(emptyLedger, out.messageId)
    const result = readIncoming({
      files: [{ relativePath: out.relativePath, bytes: out.bytes }],
      selfAgentId: "agent-b",
      seen,
    })
    expect(result.ready).toEqual([])
    expect(result.skippedSeen).toEqual([out.messageId])
    expect(result.rejected).toEqual([])
  })
})

describe("readIncoming — path-binding (TOFU spoof guard)", () => {
  it("rejects a wrapper whose fromAgentId does not match the outbox-owner dir", () => {
    // Path says agent-a's outbox, but the wrapper claims agent-evil.
    const msg = wrapper({ fromAgentId: "agent-evil" })
    const file: IncomingFile = {
      relativePath: `agents/agent-a/outbox/agent-b/${NOW}--${msg.messageId}.json`,
      bytes: JSON.stringify(msg),
    }
    const result = readIncoming({ files: [file], selfAgentId: "agent-b", seen: emptyLedger })
    expect(result.ready).toEqual([])
    expect(result.rejected).toEqual([{ relativePath: file.relativePath, reason: "from_path_mismatch" }])
  })

  it("rejects a wrapper whose toAgentId does not match the routing subdir", () => {
    const msg = wrapper({ toAgentId: "agent-c" })
    const file: IncomingFile = {
      relativePath: `agents/agent-a/outbox/agent-b/${NOW}--${msg.messageId}.json`,
      bytes: JSON.stringify(msg),
    }
    const result = readIncoming({ files: [file], selfAgentId: "agent-b", seen: emptyLedger })
    expect(result.ready).toEqual([])
    expect(result.rejected).toEqual([{ relativePath: file.relativePath, reason: "to_path_mismatch" }])
  })
})

describe("readIncoming — addressing", () => {
  it("silently skips a well-formed message addressed to a third party", () => {
    const msg = wrapper({ toAgentId: "agent-c" })
    // Path-consistent (routing dir agent-c == wrapper toAgentId) so it survives
    // path-binding; but it's not ours (self is agent-b).
    const file = fileFor(msg)
    const result = readIncoming({ files: [file], selfAgentId: "agent-b", seen: emptyLedger })
    expect(result.ready).toEqual([])
    expect(result.rejected).toEqual([])
    expect(result.skippedSeen).toEqual([])
  })
})

describe("readIncoming — malformed path", () => {
  const cases: Array<[string, string]> = [
    ["too few segments", "agents/agent-a/outbox/x.json"],
    ["too many segments", "agents/agent-a/outbox/agent-b/sub/x.json"],
    ["wrong agents literal", "nope/agent-a/outbox/agent-b/x.json"],
    ["wrong outbox literal", "agents/agent-a/inbox/agent-b/x.json"],
    ["non-json filename", "agents/agent-a/outbox/agent-b/x.txt"],
    ["empty segment", "agents//outbox/agent-b/x.json"],
  ]
  for (const [label, relativePath] of cases) {
    it(`rejects ${label}`, () => {
      const result = readIncoming({
        files: [{ relativePath, bytes: JSON.stringify(wrapper()) }],
        selfAgentId: "agent-b",
        seen: emptyLedger,
      })
      expect(result.ready).toEqual([])
      expect(result.rejected).toEqual([{ relativePath, reason: "malformed_path" }])
    })
  }
})

describe("readIncoming — invalid JSON / not-an-object", () => {
  it("rejects invalid JSON", () => {
    const relativePath = `agents/agent-a/outbox/agent-b/${NOW}--msg-1.json`
    const result = readIncoming({
      files: [{ relativePath, bytes: "{not json" }],
      selfAgentId: "agent-b",
      seen: emptyLedger,
    })
    expect(result.rejected).toEqual([{ relativePath, reason: "invalid_json" }])
  })

  it("rejects a JSON array (not an object)", () => {
    const relativePath = `agents/agent-a/outbox/agent-b/${NOW}--msg-1.json`
    const result = readIncoming({
      files: [{ relativePath, bytes: "[]" }],
      selfAgentId: "agent-b",
      seen: emptyLedger,
    })
    expect(result.rejected).toEqual([{ relativePath, reason: "not_an_object" }])
  })

  it("rejects JSON null (not an object)", () => {
    const relativePath = `agents/agent-a/outbox/agent-b/${NOW}--msg-1.json`
    const result = readIncoming({
      files: [{ relativePath, bytes: "null" }],
      selfAgentId: "agent-b",
      seen: emptyLedger,
    })
    expect(result.rejected).toEqual([{ relativePath, reason: "not_an_object" }])
  })
})

describe("readIncoming — malformed message (each wrapper-shape branch)", () => {
  function rejectFor(partial: Record<string, unknown>): string | undefined {
    const relativePath = `agents/agent-a/outbox/agent-b/${NOW}--msg-1.json`
    const result = readIncoming({
      files: [{ relativePath, bytes: JSON.stringify(partial) }],
      selfAgentId: "agent-b",
      seen: emptyLedger,
    })
    return result.rejected[0]?.reason
  }

  const base = wrapper()

  it("rejects a non-number mailboxVersion", () => {
    expect(rejectFor({ ...base, mailboxVersion: "1" })).toBe("malformed_message")
  })
  it("rejects an empty messageId", () => {
    expect(rejectFor({ ...base, messageId: "" })).toBe("malformed_message")
  })
  it("rejects a non-string messageId", () => {
    expect(rejectFor({ ...base, messageId: 5 })).toBe("malformed_message")
  })
  it("rejects a non-string fromAgentId", () => {
    expect(rejectFor({ ...base, fromAgentId: 5 })).toBe("malformed_message")
  })
  it("rejects a non-string toAgentId", () => {
    expect(rejectFor({ ...base, toAgentId: 5 })).toBe("malformed_message")
  })
  it("rejects a non-string issuedAt", () => {
    expect(rejectFor({ ...base, issuedAt: 5 })).toBe("malformed_message")
  })
  it("rejects a wrong kind", () => {
    expect(rejectFor({ ...base, kind: "something_else" })).toBe("malformed_message")
  })
  it("rejects a missing envelope", () => {
    const { envelope: _omit, ...noEnvelope } = base
    void _omit
    expect(rejectFor(noEnvelope)).toBe("malformed_message")
  })
  it("rejects a non-object envelope", () => {
    expect(rejectFor({ ...base, envelope: "nope" })).toBe("malformed_message")
  })
  it("rejects a null envelope", () => {
    expect(rejectFor({ ...base, envelope: null })).toBe("malformed_message")
  })
  it("rejects an array envelope", () => {
    expect(rejectFor({ ...base, envelope: [] })).toBe("malformed_message")
  })
})

describe("readIncoming — unsupported version", () => {
  it("rejects a wrapper with a different mailboxVersion", () => {
    const msg = wrapper({ mailboxVersion: 999 })
    const file = fileFor(msg)
    const result = readIncoming({ files: [file], selfAgentId: "agent-b", seen: emptyLedger })
    expect(result.ready).toEqual([])
    expect(result.rejected).toEqual([{ relativePath: file.relativePath, reason: "unsupported_version" }])
  })
})

describe("readIncoming — ordering", () => {
  it("sorts ready by issuedAt ascending", () => {
    const later = wrapper({ messageId: "msg-late", issuedAt: "2026-03-14T20:00:00.000Z" })
    const earlier = wrapper({ messageId: "msg-early", issuedAt: "2026-03-14T08:00:00.000Z" })
    const result = readIncoming({
      files: [fileFor(later), fileFor(earlier)],
      selfAgentId: "agent-b",
      seen: emptyLedger,
    })
    expect(result.ready.map((m) => m.messageId)).toEqual(["msg-early", "msg-late"])
  })

  it("tiebreaks equal issuedAt by messageId ascending (deterministic)", () => {
    const b = wrapper({ messageId: "msg-b", issuedAt: NOW })
    const a = wrapper({ messageId: "msg-a", issuedAt: NOW })
    const result = readIncoming({
      files: [fileFor(b), fileFor(a)],
      selfAgentId: "agent-b",
      seen: emptyLedger,
    })
    expect(result.ready.map((m) => m.messageId)).toEqual(["msg-a", "msg-b"])
  })
})

describe("compareReady — every arm reachable in both argument orders", () => {
  function msg(issuedAt: string, messageId: string): IncomingMessage {
    return { messageId, fromAgentId: "agent-a", toAgentId: "agent-b", issuedAt, envelope: envelope(), relativePath: "p" }
  }
  const early = msg("2026-01-01T00:00:00.000Z", "m1")
  const late = msg("2026-02-01T00:00:00.000Z", "m1")
  const tieA = msg(NOW, "m-a")
  const tieB = msg(NOW, "m-b")

  it("orders by issuedAt ascending (both directions)", () => {
    expect(compareReady(early, late)).toBe(-1)
    expect(compareReady(late, early)).toBe(1)
  })

  it("tiebreaks by messageId when issuedAt is equal (both directions)", () => {
    expect(compareReady(tieA, tieB)).toBe(-1)
    expect(compareReady(tieB, tieA)).toBe(1)
  })

  it("returns 0 for identical issuedAt + messageId", () => {
    expect(compareReady(tieA, msg(NOW, "m-a"))).toBe(0)
  })
})

describe("isSeen / markSeen", () => {
  it("isSeen reports membership", () => {
    const ledger = markSeen(emptyLedger, "msg-1", NOW)
    expect(isSeen(ledger, "msg-1")).toBe(true)
    expect(isSeen(ledger, "msg-2")).toBe(false)
  })

  it("isSeen does not treat inherited prototype keys as seen", () => {
    expect(isSeen(emptyLedger, "toString")).toBe(false)
    expect(isSeen(emptyLedger, "hasOwnProperty")).toBe(false)
  })

  it("markSeen is immutable — it does not mutate the input ledger", () => {
    const before: SeenLedger = { seen: {} }
    const after = markSeen(before, "msg-1", NOW)
    expect(before.seen).toEqual({})
    expect(after.seen).toEqual({ "msg-1": NOW })
    expect(after).not.toBe(before)
  })

  it("markSeen stamps the provided at timestamp", () => {
    const after = markSeen(emptyLedger, "msg-1", NOW)
    expect(after.seen["msg-1"]).toBe(NOW)
  })

  it("markSeen defaults at to the current time when omitted (covers the ?? branch)", () => {
    const after = markSeen(emptyLedger, "msg-1")
    expect(typeof after.seen["msg-1"]).toBe("string")
    expect(() => new Date(after.seen["msg-1"]).toISOString()).not.toThrow()
  })
})
