// R2: the signature binds recipient, kind, id and time. Exploit tests first (the
// audit's re-seal attack), then the checkEnvelopeBinding rules and backward compat.
import { describe, expect, it } from "vitest"

import { didKeyIdentityFromEd25519, keyAgreementFromDidKey, parseDidKey } from "../a2a-client/did-key"
import type { DidKeyIdentity } from "../a2a-client/did-key"
import { MemoryPinStore, pinOnFirstContact } from "../a2a-client/did-verifier"
import { receiveShare, sendShare } from "../a2a-client/adapter"
import type { A2ATransport, DidResolution, SeenLedgerLike } from "../a2a-client/adapter"
import { wrapInDataPart, unwrapDataPart } from "../a2a-client/a2a-message"
import type { A2AMessage } from "../a2a-client/a2a-message"
import { sealTo } from "../a2a-client/seal"
import { checkEnvelopeBinding } from "../a2a-client/envelope-binding"
import { openSealedEnvelope, sealEnvelope } from "../a2a-client/sealed-envelope"
import type { FriendsKind } from "../a2a-client/sealed-envelope"
import { parseProof, serializeProof, signEnvelope, verifyEnvelopeSignature } from "../a2a-client/sign"
import { prepareMessage } from "../message"
import type { FriendStore } from "../store"
import type { MissionStore } from "../mission-store"
import type { TrustLevel } from "../types"
import { readySodium } from "./_sodium"

type Sodium = Awaited<ReturnType<typeof readySodium>>

class SeenLedger implements SeenLedgerLike {
  private readonly set = new Set<string>()
  isSeen(n: string) { return this.set.has(n) }
  markSeen(n: string) { this.set.add(n) }
}

const untouchedStore = new Proxy({}, { get() { throw new Error("must not touch the friend store") } }) as FriendStore
const untouchedMissions = new Proxy({}, { get() { throw new Error("must not touch the mission store") } }) as MissionStore

function didKeyResolution(sodium: Sodium, delayMs = 0): DidResolution {
  return {
    async resolveAndPin({ fromAgentId, did, pinStore }) {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      const existing = pinStore.get(fromAgentId)
      if (existing) return { ed25519Pub: existing.ed25519Pub }
      const parsed = parseDidKey(did)
      if (!parsed) return null
      keyAgreementFromDidKey({ sodium, ed25519Pub: parsed.ed25519Pub })
      pinOnFirstContact({ pinStore, fromAgentId, did, ed25519Pub: parsed.ed25519Pub })
      return { ed25519Pub: parsed.ed25519Pub }
    },
  }
}

function agent(sodium: Sodium): DidKeyIdentity {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

async function sendTo(sodium: Sodium, from: DidKeyIdentity, to: DidKeyIdentity, envelope: Record<string, unknown>, friendsKind: FriendsKind = "message"): Promise<A2AMessage> {
  const sent: A2AMessage[] = []
  const transport: A2ATransport = { async send(_t, message) { sent.push(message) } }
  const r = await sendShare({
    sodium, transport, fromIdentity: from,
    toPeer: { a2a: { endpointUrl: "https://x.example/a2a", did: to.did } },
    recipientDid: to.did, recipientX25519Pub: to.x25519Pub, plaintextEnvelope: envelope, friendsKind,
  })
  expect(r.ok).toBe(true)
  return sent[0]
}

/** What a hostile or curious recipient can do: open a blob addressed to it and seal the SAME
 * signed envelope (proof untouched) to someone else, with a fresh seal nonce. */
function reseal(sodium: Sodium, wire: A2AMessage, opener: DidKeyIdentity, to: DidKeyIdentity): A2AMessage {
  const payload = unwrapDataPart(wire)!
  const opened = openSealedEnvelope({
    sodium, sealedEnvelope: { v: payload.v, sealed: payload.sealed }, recipientDid: opener.did,
    recipientIdentity: { x25519Priv: opener.x25519Priv, x25519Pub: opener.x25519Pub },
  })
  if (!opened.ok) throw new Error(opened.error)
  return sealPlaintext(sodium, {
    envelope: opened.envelope, signature: parseProof(opened.envelope.proof as string)!.sig,
    signerDid: opened.signerDid, signerKeyId: opened.signerKeyId, friendsKind: opened.friendsKind,
  }, to)
}

/** The pre-binding sealer: sign + seal with NO binding stamp (what alpha.14 and earlier did). */
function legacySeal(sodium: Sodium, envelope: Record<string, unknown>, from: DidKeyIdentity, to: DidKeyIdentity, friendsKind: FriendsKind = "message"): A2AMessage {
  const proof = signEnvelope({ sodium, envelope, signerEd25519Priv: from.ed25519Priv, signerDid: from.did, signerKeyId: from.keyId })
  return sealPlaintext(sodium, {
    envelope: { ...envelope, proof: serializeProof(proof) }, signature: proof.sig,
    signerDid: proof.signerDid, signerKeyId: proof.signerKeyId, friendsKind,
  }, to)
}

function sealPlaintext(sodium: Sodium, p: { envelope: unknown; signature: string; signerDid: string; signerKeyId: string; friendsKind: FriendsKind }, to: DidKeyIdentity): A2AMessage {
  const plaintext = { ...p, recipient: to.did, v: 1 }
  const sealed = sealTo({ sodium, plaintextBytes: new TextEncoder().encode(JSON.stringify(plaintext)), recipientX25519Pub: to.x25519Pub, recipientDid: to.did, v: 1 })
  return wrapInDataPart({ sealedEnvelope: { v: 1, sealed }, recipientDid: to.did })
}

function receiveAt(sodium: Sodium, b: DidKeyIdentity, message: A2AMessage, trustOfSource: TrustLevel, extra: Record<string, unknown> = {}) {
  return receiveShare({
    sodium, store: untouchedStore, missionStore: untouchedMissions, pinStore: new MemoryPinStore(),
    didResolution: didKeyResolution(sodium), seen: new SeenLedger(), a2aMessage: message,
    recipientDid: b.did, recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub }, trustOfSource,
    ...extra,
  })
}

function msg(from: DidKeyIdentity, opts: { text?: string; onBehalfOf?: "principal"; at?: string } = {}): Record<string, unknown> {
  const prepared = prepareMessage({
    fromAgentId: from.did, text: opts.text ?? "hello", ...(opts.onBehalfOf ? { onBehalfOf: opts.onBehalfOf } : {}),
    ...(opts.at ? { now: () => opts.at! } : {}),
  })
  if (!prepared.ok) throw new Error(prepared.status)
  return prepared.envelope as unknown as Record<string, unknown>
}

describe("EXPLOIT: re-sealing a delegated message to a different recipient", () => {
  it("C rejects A's delegated command that B opened and re-sealed to C", async () => {
    const sodium = await readySodium()
    const [a, b, c] = [agent(sodium), agent(sodium), agent(sodium)]
    const toB = await sendTo(sodium, a, b, msg(a, { text: "wire money", onBehalfOf: "principal" }))
    const toC = reseal(sodium, toB, b, c)
    const r = await receiveAt(sodium, c, toC, "family")
    expect(r).toEqual({ state: "rejected", reason: "signed_recipient_mismatch" })
  })

  it("still delivers the original to its real recipient B", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const toB = await sendTo(sodium, a, b, msg(a, { text: "wire money", onBehalfOf: "principal" }))
    const r = await receiveAt(sodium, b, toB, "family")
    expect(r.state).toBe("completed")
    expect(r).toMatchObject({ bound: true, friendsKind: "message", status: "received", bindingId: expect.any(String) })
  })

  it("rejects a second delivery of the same signed message re-sealed to the same recipient", async () => {
    const sodium = await readySodium()
    const [a, c] = [agent(sodium), agent(sodium)]
    const first = await sendTo(sodium, a, c, msg(a, { onBehalfOf: "principal" }))
    const second = reseal(sodium, first, c, c) // fresh seal nonce, identical signed envelope
    expect(unwrapDataPart(second)!.sealed.n).not.toBe(unwrapDataPart(first)!.sealed.n)
    const seen = new SeenLedger()
    const input = { seen }
    expect((await receiveAt(sodium, c, first, "family", input)).state).toBe("completed")
    expect(await receiveAt(sodium, c, second, "family", input)).toEqual({ state: "rejected", reason: "replayed" })
  })

  it("rejects a stale delegated message (issuedAt in 2020)", async () => {
    const sodium = await readySodium()
    const [a, c] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, c, msg(a, { onBehalfOf: "principal", at: "2020-01-01T00:00:00.000Z" }))
    expect(await receiveAt(sodium, c, wire, "family")).toEqual({ state: "rejected", reason: "stale_delegation" })
  })

  it("two concurrent receives of the same sealed blob produce exactly one acceptance", async () => {
    const sodium = await readySodium()
    const [a, c] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, c, msg(a))
    const seen = new SeenLedger()
    const slow = { seen, didResolution: didKeyResolution(sodium, 10) }
    const results = await Promise.all([receiveAt(sodium, c, wire, "friend", slow), receiveAt(sodium, c, wire, "friend", slow)])
    expect(results.filter((r) => r.state === "completed")).toHaveLength(1)
    expect(results.filter((r) => r.state === "rejected" && r.reason === "replayed")).toHaveLength(1)
  })
})

describe("backward compatibility with unbound (pre-binding) senders", () => {
  it("accepts a non-delegated unbound message with bound:false", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const r = await receiveAt(sodium, b, legacySeal(sodium, msg(a), a, b), "friend")
    expect(r).toMatchObject({ state: "completed", status: "received", bound: false })
  })

  it("refuses an unbound delegated message", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const r = await receiveAt(sodium, b, legacySeal(sodium, msg(a, { onBehalfOf: "principal" }), a, b), "family")
    expect(r).toEqual({ state: "rejected", reason: "unbound_delegation" })
  })

  it("refuses any unbound envelope when rejectUnboundEnvelopes is set", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const r = await receiveAt(sodium, b, legacySeal(sodium, msg(a), a, b), "friend", { options: { rejectUnboundEnvelopes: true } })
    expect(r).toEqual({ state: "rejected", reason: "unbound_envelope" })
  })
})

describe("sealEnvelope stamps a signed binding", () => {
  it("adds { to, kind, id } covered by the signature, with a fresh 128-bit id each time", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const open = () => {
      const sealed = sealEnvelope({ sodium, envelope: msg(a), friendsKind: "message", fromIdentity: a, recipientDid: b.did, recipientX25519Pub: b.x25519Pub })
      const o = openSealedEnvelope({ sodium, sealedEnvelope: sealed, recipientDid: b.did, recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub } })
      if (!o.ok) throw new Error(o.error)
      return o
    }
    const one = open()
    const two = open()
    const binding = one.envelope.binding as { to: string; kind: string; id: string }
    expect(binding).toMatchObject({ to: b.did, kind: "message" })
    expect(binding.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect((two.envelope.binding as { id: string }).id).not.toBe(binding.id)
    const verify = (env: Record<string, unknown>) => verifyEnvelopeSignature({ sodium, envelope: env, proof: env.proof as string, signerEd25519Pub: a.ed25519Pub })
    expect(verify(one.envelope)).toBe(true)
    expect(verify({ ...one.envelope, binding: { ...binding, to: "did:key:other" } })).toBe(false)
  })

  it("throws when the caller already supplied a binding", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    expect(() => sealEnvelope({ sodium, envelope: { ...msg(a), binding: { to: "x" } }, friendsKind: "message", fromIdentity: a, recipientDid: b.did, recipientX25519Pub: b.x25519Pub })).toThrow(/reserved/)
  })
})

describe("receiveShare — message rejection reasons", () => {
  it("splits a failed signature (bad_signature) from a low-trust sender (untrusted_source)", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const mallory = sodium.crypto_sign_keypair()
    const sealed = sealEnvelope({
      sodium, envelope: msg(a), friendsKind: "message",
      fromIdentity: { did: a.did, keyId: a.keyId, ed25519Priv: mallory.privateKey }, // claims A, signs with the wrong key
      recipientDid: b.did, recipientX25519Pub: b.x25519Pub,
    })
    const wire = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: b.did })
    expect(await receiveAt(sodium, b, wire, "family")).toEqual({ state: "rejected", reason: "bad_signature" })
    const honest = await sendTo(sodium, a, b, msg(a))
    expect(await receiveAt(sodium, b, honest, "stranger")).toEqual({ state: "rejected", reason: "untrusted_source" })
  })

  it("treats a message with no proof at all as bad_signature", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const wire = sealPlaintext(sodium, { envelope: msg(a), signature: "", signerDid: a.did, signerKeyId: a.keyId, friendsKind: "message" }, b)
    expect(await receiveAt(sodium, b, wire, "family")).toEqual({ state: "rejected", reason: "bad_signature" })
  })

  it("applies the delegated 10-minute window through receiveShare, and a custom one when given", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const issued = "2026-10-09T12:00:00.000Z"
    const wire = await sendTo(sodium, a, b, msg(a, { onBehalfOf: "principal", at: issued }))
    const at = (ms: number) => ({ options: { now: Date.parse(issued) + ms } })
    expect((await receiveAt(sodium, b, wire, "family", at(9 * 60_000))).state).toBe("completed")
    const wire2 = await sendTo(sodium, a, b, msg(a, { onBehalfOf: "principal", at: issued }))
    expect(await receiveAt(sodium, b, wire2, "family", at(11 * 60_000))).toEqual({ state: "rejected", reason: "stale_delegation" })
    const wire3 = await sendTo(sodium, a, b, msg(a, { onBehalfOf: "principal", at: issued }))
    expect((await receiveAt(sodium, b, wire3, "family", { options: { now: Date.parse(issued) + 11 * 60_000, delegatedMaxAgeMs: 20 * 60_000 } })).state).toBe("completed")
  })
})

describe("checkEnvelopeBinding", () => {
  const NOW_MS = Date.parse("2026-10-09T12:00:00.000Z")
  const ID = "AAAAAAAAAAAAAAAAAAAAAA"
  function opened(envelope: Record<string, unknown>, friendsKind: FriendsKind = "message") {
    return { ok: true as const, envelope, fromAgentId: "did:key:sender", signerDid: "did:key:sender", signerKeyId: "k", friendsKind }
  }
  const bound = (over: Record<string, unknown> = {}, bindingOver: Record<string, unknown> = {}) => ({
    issuedAt: new Date(NOW_MS).toISOString(), binding: { to: "did:key:me", kind: "message", id: ID, ...bindingOver }, ...over,
  })
  const check = (o: ReturnType<typeof opened>, extra: Record<string, unknown> = {}, seen = new SeenLedger()) =>
    checkEnvelopeBinding(o, { recipientDid: "did:key:me", seen, now: NOW_MS, ...extra })

  it("accepts a bound, fresh envelope, returns mid:<sender>:<id> to mark, and refuses it once marked", () => {
    const seen = new SeenLedger()
    const r = check(opened(bound()), {}, seen)
    expect(r).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
    expect(seen.isSeen(`mid:did:key:sender:${ID}`)).toBe(false) // check-only: the caller marks after verification
    seen.markSeen(`mid:did:key:sender:${ID}`)
    expect(check(opened(bound()), {}, seen)).toEqual({ ok: false, reason: "replayed" })
  })

  it("rejects a recipient mismatch without touching the ledger", () => {
    const seen = new SeenLedger()
    expect(check(opened(bound({}, { to: "did:key:other" })), {}, seen)).toEqual({ ok: false, reason: "signed_recipient_mismatch" })
    expect(seen.isSeen(`mid:did:key:sender:${ID}`)).toBe(false)
  })

  it("throws on a non-Date, non-number now", () => {
    expect(() => check(opened(bound()), { now: "yesterday" as never })).toThrow(TypeError)
  })

  it("rejects a kind mismatch", () => {
    expect(check(opened(bound({}, { kind: "coordination" })))).toEqual({ ok: false, reason: "signed_kind_mismatch" })
  })

  it.each([
    ["non-object binding", "nope"],
    ["array binding", []],
    ["null binding", null],
    ["short id", { to: "did:key:me", kind: "message", id: "short" }],
    ["non-string to", { to: 5, kind: "message", id: ID }],
    ["non-string kind", { to: "did:key:me", kind: 5, id: ID }],
    ["non-string id", { to: "did:key:me", kind: "message", id: 5 }],
  ])("rejects a malformed binding: %s", (_n, binding) => {
    expect(check(opened({ issuedAt: new Date(NOW_MS).toISOString(), binding }))).toEqual({ ok: false, reason: "malformed_binding" })
  })

  it("applies the 7-day default window to any kind, and honours maxAgeMs", () => {
    const old = (days: number) => bound({ issuedAt: new Date(NOW_MS - days * 86_400_000).toISOString() })
    expect(check(opened(old(6)))).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
    expect(check(opened(old(8)))).toEqual({ ok: false, reason: "stale_envelope" })
    const coord = (days: number) => opened(bound({ issuedAt: new Date(NOW_MS - days * 86_400_000).toISOString() }, { kind: "coordination" }), "coordination")
    expect(check(coord(6))).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
    expect(check(coord(8))).toEqual({ ok: false, reason: "stale_envelope" })
    expect(check(opened(old(8)), { maxAgeMs: 10 * 86_400_000 })).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
  })

  it("rejects an issuedAt too far in the future, and honours maxFutureSkewMs", () => {
    const ahead = (ms: number) => bound({ issuedAt: new Date(NOW_MS + ms).toISOString() })
    expect(check(opened(ahead(60_000)))).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
    expect(check(opened(ahead(3 * 60_000)))).toEqual({ ok: false, reason: "stale_envelope" })
    expect(check(opened(ahead(3 * 60_000)), { maxFutureSkewMs: 5 * 60_000 })).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
    expect(check(opened(ahead(60_000)), { now: new Date(NOW_MS), maxFutureSkewMs: 0 })).toEqual({ ok: false, reason: "stale_envelope" })
  })

  it("rejects a missing or unparseable issuedAt", () => {
    expect(check(opened({ binding: bound().binding }))).toEqual({ ok: false, reason: "stale_envelope" })
    expect(check(opened(bound({ issuedAt: "soon" })))).toEqual({ ok: false, reason: "stale_envelope" })
  })

  it("uses the delegated window for any kind carrying onBehalfOf", () => {
    const delegated = (ms: number, kind: FriendsKind = "coordination") =>
      opened(bound({ onBehalfOf: "principal", issuedAt: new Date(NOW_MS - ms).toISOString() }, { kind }), kind)
    expect(check(delegated(5 * 60_000))).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
    expect(check(delegated(11 * 60_000))).toEqual({ ok: false, reason: "stale_delegation" })
  })

  it("rejects a binding with extra keys", () => {
    expect(check(opened(bound({}, { extra: "x" })))).toEqual({ ok: false, reason: "malformed_binding" })
  })

  it.each([
    ["RFC 2822", "Fri, 09 Oct 2026 12:00:00 GMT"],
    ["zone-less", "2026-10-09T12:00:00"],
    ["date only", "2026-10-09"],
    ["space separator", "2026-10-09 12:00:00Z"],
  ])("requires ISO-8601 with a zone for issuedAt: %s", (_n, issuedAt) => {
    expect(check(opened(bound({ issuedAt })))).toEqual({ ok: false, reason: "stale_envelope" })
  })

  it("accepts an ISO-8601 issuedAt with a numeric offset", () => {
    expect(check(opened(bound({ issuedAt: "2026-10-09T05:00:00-07:00" })))).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
  })

  it.each([
    ["now NaN", { now: Number.NaN }],
    ["now Invalid Date", { now: new Date("garbage") }],
    ["now Infinity", { now: Number.POSITIVE_INFINITY }],
    ["maxAgeMs NaN", { maxAgeMs: Number.NaN }],
    ["delegatedMaxAgeMs NaN", { delegatedMaxAgeMs: Number.NaN }],
    ["maxFutureSkewMs NaN", { maxFutureSkewMs: Number.NaN }],
    ["maxAgeMs Infinity", { maxAgeMs: Number.POSITIVE_INFINITY }],
    ["delegatedMaxAgeMs negative", { delegatedMaxAgeMs: -1 }],
    ["maxFutureSkewMs negative", { maxFutureSkewMs: -1 }],
  ])("throws a TypeError on invalid options instead of failing open: %s", (_n, extra) => {
    const delegated = opened(bound({ onBehalfOf: "principal", issuedAt: "2020-01-01T00:00:00.000Z" }))
    expect(() => check(delegated, extra)).toThrow(TypeError)
  })

  it("accepts a Date clock and defaults the clock to the current time", () => {
    expect(check(opened(bound()), { now: new Date(NOW_MS) })).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
    const fresh = { issuedAt: new Date().toISOString(), binding: { to: "did:key:me", kind: "message", id: ID } }
    expect(checkEnvelopeBinding(opened(fresh), { recipientDid: "did:key:me", seen: new SeenLedger() })).toEqual({ ok: true, bound: true, bindingId: ID, seenKey: `mid:did:key:sender:${ID}` })
  })

  it("handles unbound envelopes: delegated always refused, others per rejectUnboundEnvelopes", () => {
    const plain = { issuedAt: new Date(NOW_MS).toISOString() }
    expect(check(opened(plain))).toEqual({ ok: true, bound: false })
    expect(check(opened(plain), { rejectUnboundEnvelopes: true })).toEqual({ ok: false, reason: "unbound_envelope" })
    expect(check(opened({ ...plain, onBehalfOf: "principal" }))).toEqual({ ok: false, reason: "unbound_delegation" })
    expect(check(opened({ ...plain, onBehalfOf: "principal" }), { rejectUnboundEnvelopes: false })).toEqual({ ok: false, reason: "unbound_delegation" })
  })

  it("still enforces freshness on an unbound envelope", () => {
    const old = { issuedAt: "2020-01-01T00:00:00.000Z" }
    expect(check(opened(old))).toEqual({ ok: false, reason: "stale_envelope" })
  })
})

describe("claim ordering (in-flight set, durable mark only after the signature verifies)", () => {
  class RecordingLedger extends SeenLedger {
    readonly marks: string[] = []
    override markSeen(n: string) { this.marks.push(n); super.markSeen(n) }
  }

  it("a concurrent re-sealed duplicate (fresh nonce, same message id) is replayed while the first is in flight", async () => {
    const sodium = await readySodium()
    const [a, c] = [agent(sodium), agent(sodium)]
    const first = await sendTo(sodium, a, c, msg(a))
    const second = reseal(sodium, first, c, c)
    const slow = { seen: new SeenLedger(), didResolution: didKeyResolution(sodium, 10) }
    const results = await Promise.all([receiveAt(sodium, c, first, "friend", slow), receiveAt(sodium, c, second, "friend", slow)])
    expect(results.map((r) => r.state).sort()).toEqual(["completed", "rejected"])
    expect(results.find((r) => r.state === "rejected")).toEqual({ state: "rejected", reason: "replayed" })
  })

  it("a transient resolve_failed does not burn the message: redelivery of the same blob completes", async () => {
    const sodium = await readySodium()
    const [a, c] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, c, msg(a))
    const seen = new RecordingLedger()
    const failing: DidResolution = { async resolveAndPin() { return null } }
    expect(await receiveAt(sodium, c, wire, "friend", { seen, didResolution: failing })).toEqual({ state: "rejected", reason: "resolve_failed" })
    expect(seen.marks).toEqual([])
    expect((await receiveAt(sodium, c, wire, "friend", { seen })).state).toBe("completed")
  })

  it("a forged blob (bad signature) leaves no durable claim, so the real message still completes", async () => {
    const sodium = await readySodium()
    const [a, c] = [agent(sodium), agent(sodium)]
    const mallory = sodium.crypto_sign_keypair()
    const forgedSealed = sealEnvelope({
      sodium, envelope: msg(a), friendsKind: "message",
      fromIdentity: { did: a.did, keyId: a.keyId, ed25519Priv: mallory.privateKey },
      recipientDid: c.did, recipientX25519Pub: c.x25519Pub,
    })
    const forged = wrapInDataPart({ sealedEnvelope: forgedSealed, recipientDid: c.did })
    const real = await sendTo(sodium, a, c, msg(a))
    const seen = new RecordingLedger()
    expect(await receiveAt(sodium, c, forged, "family", { seen })).toEqual({ state: "rejected", reason: "bad_signature" })
    expect(seen.marks).toEqual([])
    expect((await receiveAt(sodium, c, real, "family", { seen })).state).toBe("completed")
  })

  it("still reads an old nonce-only ledger entry as seen", async () => {
    const sodium = await readySodium()
    const [a, c] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, c, msg(a))
    const seen = new SeenLedger()
    seen.markSeen(unwrapDataPart(wire)!.sealed.n)
    expect(await receiveAt(sodium, c, wire, "family", { seen })).toEqual({ state: "rejected", reason: "replayed" })
  })

  it("a completed delivery is marked durably and a later duplicate is replayed", async () => {
    const sodium = await readySodium()
    const [a, c] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, c, msg(a))
    const seen = new RecordingLedger()
    expect((await receiveAt(sodium, c, wire, "family", { seen })).state).toBe("completed")
    expect(seen.marks).toHaveLength(2) // blob key + mid key
    expect(await receiveAt(sodium, c, wire, "family", { seen })).toEqual({ state: "rejected", reason: "replayed" })
  })

  it("releases the in-flight claim when the receive throws", async () => {
    const sodium = await readySodium()
    const [a, c] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, c, msg(a))
    const seen = new SeenLedger()
    const throwing: DidResolution = { async resolveAndPin() { throw new Error("network down") } }
    await expect(receiveAt(sodium, c, wire, "family", { seen, didResolution: throwing })).rejects.toThrow("network down")
    expect((await receiveAt(sodium, c, wire, "family", { seen })).state).toBe("completed")
  })
})

describe("receiveShare — stripped or altered binding, ids and options", () => {
  it("a bound message whose binding was stripped is bad_signature", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, b, msg(a))
    const payload = unwrapDataPart(wire)!
    const opened = openSealedEnvelope({ sodium, sealedEnvelope: { v: payload.v, sealed: payload.sealed }, recipientDid: b.did, recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub } })
    if (!opened.ok) throw new Error(opened.error)
    const { binding: _stripped, ...rest } = opened.envelope
    const stripped = sealPlaintext(sodium, { envelope: rest, signature: "", signerDid: opened.signerDid, signerKeyId: opened.signerKeyId, friendsKind: "message" }, b)
    expect(await receiveAt(sodium, b, stripped, "family")).toEqual({ state: "rejected", reason: "bad_signature" })
  })

  it.each(["profile_share", "mission_share", "coordination"] as const)("a stripped bound %s envelope is rejected", async (kind) => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const env: Record<string, unknown> = kind === "profile_share"
      ? { subject: { externalIds: [], displayName: "J" }, fromAgentId: a.did, scope: "notes:safe", notes: [], issuedAt: new Date().toISOString() }
      : { subject: { missionKey: "M-1", title: "M" }, fromAgentId: a.did, scope: "mission", learnings: [], intent: "request", issuedAt: new Date().toISOString() }
    const wire = await sendTo(sodium, a, b, env, kind)
    const payload = unwrapDataPart(wire)!
    const opened = openSealedEnvelope({ sodium, sealedEnvelope: { v: payload.v, sealed: payload.sealed }, recipientDid: b.did, recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub } })
    if (!opened.ok) throw new Error(opened.error)
    const { binding: _stripped, ...rest } = opened.envelope
    const stripped = sealPlaintext(sodium, { envelope: rest, signature: "", signerDid: opened.signerDid, signerKeyId: opened.signerKeyId, friendsKind: kind }, b)
    const r = await receiveAt(sodium, b, stripped, "family")
    expect(r.state).toBe("rejected")
  })

  it("changing the outer friendsKind is signed_kind_mismatch", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, b, msg(a))
    const payload = unwrapDataPart(wire)!
    const opened = openSealedEnvelope({ sodium, sealedEnvelope: { v: payload.v, sealed: payload.sealed }, recipientDid: b.did, recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub } })
    if (!opened.ok) throw new Error(opened.error)
    const relabeled = sealPlaintext(sodium, { envelope: opened.envelope, signature: "", signerDid: opened.signerDid, signerKeyId: opened.signerKeyId, friendsKind: "coordination" }, b)
    expect(await receiveAt(sodium, b, relabeled, "family")).toEqual({ state: "rejected", reason: "signed_kind_mismatch" })
  })

  it("returns the signed binding id as bindingId on a completed result", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, b, msg(a))
    const payload = unwrapDataPart(wire)!
    const opened = openSealedEnvelope({ sodium, sealedEnvelope: { v: payload.v, sealed: payload.sealed }, recipientDid: b.did, recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub } })
    if (!opened.ok) throw new Error(opened.error)
    const r = await receiveAt(sodium, b, wire, "family")
    expect(r).toMatchObject({ state: "completed", bound: true, bindingId: (opened.envelope.binding as { id: string }).id })
  })

  it("an unbound completed result has no bindingId", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const r = await receiveAt(sodium, b, legacySeal(sodium, msg(a), a, b), "friend")
    expect(r).toMatchObject({ state: "completed", bound: false })
    expect(r).not.toHaveProperty("bindingId")
  })

  it("receiveShare rejects (does not fail open) on a NaN clock for a stale delegated command", async () => {
    const sodium = await readySodium()
    const [a, b] = [agent(sodium), agent(sodium)]
    const wire = await sendTo(sodium, a, b, msg(a, { onBehalfOf: "principal", at: "2020-01-01T00:00:00.000Z" }))
    await expect(receiveAt(sodium, b, wire, "family", { options: { now: Number.NaN } })).rejects.toThrow(TypeError)
  })
})
