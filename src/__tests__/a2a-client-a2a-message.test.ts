// A2A DataPart mapping — wrap/unwrap + every malformed-unwrap null branch. The
// DataPart is relay-blind: only { v, sealed, recipientDid }, NO friendsKind.
import { describe, expect, it } from "vitest"

import { unwrapDataPart, wrapInDataPart } from "../a2a-client/a2a-message"
import type { A2AMessage } from "../a2a-client/a2a-message"
import type { SealedBlob } from "../a2a-client/seal"

const SEALED: SealedBlob = { v: 1, ePk: "ZQ==", n: "Tg==", ct: "Q1Q=" }

describe("wrapInDataPart", () => {
  it("produces a single relay-blind DataPart (no friendsKind on the wire)", () => {
    const msg = wrapInDataPart({ sealedEnvelope: { v: 1, sealed: SEALED }, recipientDid: "did:key:zB" })
    expect(msg.role).toBe("agent")
    expect(typeof msg.messageId).toBe("string")
    expect(msg.parts).toHaveLength(1)
    expect(msg.parts[0].kind).toBe("data")
    expect(msg.parts[0].data).toEqual({ v: 1, sealed: SEALED, recipientDid: "did:key:zB" })
    // No friendsKind anywhere on the wire.
    expect(JSON.stringify(msg)).not.toContain("friendsKind")
    expect(JSON.stringify(msg)).not.toContain("ouro.friends/kind")
  })

  it("each wrap gets a fresh messageId", () => {
    const a = wrapInDataPart({ sealedEnvelope: { v: 1, sealed: SEALED }, recipientDid: "did:key:zB" })
    const b = wrapInDataPart({ sealedEnvelope: { v: 1, sealed: SEALED }, recipientDid: "did:key:zB" })
    expect(a.messageId).not.toBe(b.messageId)
  })

  it("an explicit v overrides the sealedEnvelope v in the DataPart", () => {
    const msg = wrapInDataPart({ sealedEnvelope: { v: 1, sealed: SEALED }, recipientDid: "did:key:zB", v: 9 })
    expect(msg.parts[0].data.v).toBe(9)
  })
})

describe("unwrapDataPart — round-trip + every null branch", () => {
  it("round-trips a wrapped message", () => {
    const msg = wrapInDataPart({ sealedEnvelope: { v: 1, sealed: SEALED }, recipientDid: "did:key:zB" })
    expect(unwrapDataPart(msg)).toEqual({ v: 1, sealed: SEALED, recipientDid: "did:key:zB" })
  })

  it("null/non-object message → null", () => {
    expect(unwrapDataPart(null as unknown as A2AMessage)).toBeNull()
    expect(unwrapDataPart("nope" as unknown as A2AMessage)).toBeNull()
  })

  it("parts not an array → null", () => {
    expect(unwrapDataPart({ messageId: "m", role: "agent", parts: "x" } as unknown as A2AMessage)).toBeNull()
  })

  it("zero parts → null", () => {
    expect(unwrapDataPart({ messageId: "m", role: "agent", parts: [] })).toBeNull()
  })

  it("two parts → null (exactly one DataPart required)", () => {
    const two = { messageId: "m", role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: SEALED, recipientDid: "d" } }, { kind: "data", data: { v: 1, sealed: SEALED, recipientDid: "d" } }] } as unknown as A2AMessage
    expect(unwrapDataPart(two)).toBeNull()
  })

  it("wrong part kind → null", () => {
    const text = { messageId: "m", role: "agent", parts: [{ kind: "text", data: { v: 1, sealed: SEALED, recipientDid: "d" } }] } as unknown as A2AMessage
    expect(unwrapDataPart(text)).toBeNull()
  })

  it("a null part → null", () => {
    const msg = { messageId: "m", role: "agent", parts: [null] } as unknown as A2AMessage
    expect(unwrapDataPart(msg)).toBeNull()
  })

  it("missing data object → null", () => {
    const msg = { messageId: "m", role: "agent", parts: [{ kind: "data" }] } as unknown as A2AMessage
    expect(unwrapDataPart(msg)).toBeNull()
  })

  it("missing recipientDid → null", () => {
    const msg = { messageId: "m", role: "agent", parts: [{ kind: "data", data: { v: 1, sealed: SEALED } }] } as unknown as A2AMessage
    expect(unwrapDataPart(msg)).toBeNull()
  })

  it("non-number v → null", () => {
    const msg = { messageId: "m", role: "agent", parts: [{ kind: "data", data: { v: "1", sealed: SEALED, recipientDid: "d" } }] } as unknown as A2AMessage
    expect(unwrapDataPart(msg)).toBeNull()
  })

  it("missing/ill-typed sealed → null", () => {
    const noSealed = { messageId: "m", role: "agent", parts: [{ kind: "data", data: { v: 1, recipientDid: "d" } }] } as unknown as A2AMessage
    expect(unwrapDataPart(noSealed)).toBeNull()
    const badSealed = { messageId: "m", role: "agent", parts: [{ kind: "data", data: { v: 1, recipientDid: "d", sealed: { v: 1, ePk: 5, n: "n", ct: "c" } } }] } as unknown as A2AMessage
    expect(unwrapDataPart(badSealed)).toBeNull()
    const sealedNotObj = { messageId: "m", role: "agent", parts: [{ kind: "data", data: { v: 1, recipientDid: "d", sealed: "nope" } }] } as unknown as A2AMessage
    expect(unwrapDataPart(sealedNotObj)).toBeNull()
  })
})
