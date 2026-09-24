import { describe, expect, it } from "vitest"

import { MAX_CONVERSATION_ID_CHARS, MAX_MESSAGE_TEXT_CHARS, prepareMessage, receiveMessage } from "../message"
import type { AgentVerifier } from "../verifier"

const NOW = "2026-09-24T05:00:00.000Z"
const A = "did:key:z6MkSender"
const accept: AgentVerifier = { verify: () => true }
const reject: AgentVerifier = { verify: () => false }

describe("prepareMessage", () => {
  it("builds an envelope with the injected clock", () => {
    expect(prepareMessage({ fromAgentId: A, text: "hi", now: () => NOW })).toEqual({
      ok: true,
      envelope: { fromAgentId: A, text: "hi", issuedAt: NOW },
    })
  })

  it("carries an optional conversation id", () => {
    const r = prepareMessage({ fromAgentId: A, text: "hi", conversationId: "ctx-1", now: () => NOW })
    expect(r).toEqual({ ok: true, envelope: { fromAgentId: A, text: "hi", conversationId: "ctx-1", issuedAt: NOW } })
  })

  it("defaults issuedAt to the current time", () => {
    const r = prepareMessage({ fromAgentId: A, text: "hi" })
    expect(r.ok && !Number.isNaN(Date.parse(r.envelope.issuedAt))).toBe(true)
  })

  it.each([
    [{ fromAgentId: "", text: "hi" }, "invalid_sender"],
    [{ fromAgentId: 7 as unknown as string, text: "hi" }, "invalid_sender"],
    [{ fromAgentId: A, text: "   " }, "empty_text"],
    [{ fromAgentId: A, text: 5 as unknown as string }, "empty_text"],
    [{ fromAgentId: A, text: "x".repeat(MAX_MESSAGE_TEXT_CHARS + 1) }, "text_too_long"],
    [{ fromAgentId: A, text: "hi", conversationId: "" }, "invalid_conversation_id"],
    [{ fromAgentId: A, text: "hi", conversationId: "c".repeat(MAX_CONVERSATION_ID_CHARS + 1) }, "invalid_conversation_id"],
  ])("rejects %j as %s", (input, status) => {
    expect(prepareMessage(input)).toEqual({ ok: false, status })
  })
})

describe("receiveMessage", () => {
  const envelope = (over: Record<string, unknown> = {}) => ({ fromAgentId: A, text: "status?", issuedAt: NOW, proof: "p", ...over })

  it("returns the verified message when authenticated and trusted", () => {
    expect(receiveMessage({ envelope: envelope(), fromAgentId: A, trustOfSource: "family" }, { verifier: accept })).toEqual({
      ok: true,
      status: "received",
      message: { fromAgentId: A, text: "status?", issuedAt: NOW },
    })
  })

  it("keeps the conversation id", () => {
    const r = receiveMessage({ envelope: envelope({ conversationId: "ctx-9" }), fromAgentId: A, trustOfSource: "friend" }, { verifier: accept })
    expect(r).toEqual({ ok: true, status: "received", message: { fromAgentId: A, text: "status?", conversationId: "ctx-9", issuedAt: NOW } })
  })

  it("passes the envelope proof to the verifier, and undefined for a non-string proof", () => {
    const seen: (string | undefined)[] = []
    const spy: AgentVerifier = { verify: (_from, proof) => { seen.push(proof); return true } }
    receiveMessage({ envelope: envelope(), fromAgentId: A, trustOfSource: "friend" }, { verifier: spy })
    receiveMessage({ envelope: envelope({ proof: 42 }), fromAgentId: A, trustOfSource: "friend" }, { verifier: spy })
    expect(seen).toEqual(["p", undefined])
  })

  it("uses the default verifier when none is given", () => {
    const r = receiveMessage({ envelope: envelope(), fromAgentId: A, trustOfSource: "acquaintance" })
    expect(r.ok).toBe(true)
  })

  it.each([
    ["sender binding mismatch", envelope({ fromAgentId: "did:key:z6MkOther" })],
    ["non-string text", envelope({ text: 3 })],
    ["blank text", envelope({ text: "  " })],
    ["oversized text", envelope({ text: "x".repeat(MAX_MESSAGE_TEXT_CHARS + 1) })],
    ["missing issuedAt", envelope({ issuedAt: undefined })],
    ["unparseable issuedAt", envelope({ issuedAt: "not a date" })],
    ["invalid conversation id", envelope({ conversationId: "" })],
  ])("rejects %s as malformed", (_label, env) => {
    expect(receiveMessage({ envelope: env, fromAgentId: A, trustOfSource: "family" }, { verifier: accept })).toEqual({ ok: false, status: "malformed_message" })
  })

  it("refuses an unauthenticated message even from family", () => {
    expect(receiveMessage({ envelope: envelope(), fromAgentId: A, trustOfSource: "family" }, { verifier: reject })).toEqual({ ok: false, status: "untrusted_source" })
  })

  it("refuses an authenticated stranger by default", () => {
    expect(receiveMessage({ envelope: envelope(), fromAgentId: A, trustOfSource: "stranger" }, { verifier: accept })).toEqual({ ok: false, status: "untrusted_source" })
  })

  it("honors a stricter trust floor", () => {
    const r = receiveMessage({ envelope: envelope(), fromAgentId: A, trustOfSource: "acquaintance" }, { verifier: accept, minTrustToAccept: "friend" })
    expect(r).toEqual({ ok: false, status: "untrusted_source" })
  })
})
