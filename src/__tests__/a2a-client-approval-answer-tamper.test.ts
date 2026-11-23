// Tampering with a signed approval answer, through the full seal and receiveShare path. Synthetic keys and tokens.
// Ported from the security review of #236.
import { describe, expect, it } from "vitest"
import { didKeyIdentityFromEd25519, keyAgreementFromDidKey, parseDidKey } from "../a2a-client/did-key"
import type { DidKeyIdentity } from "../a2a-client/did-key"
import { MemoryPinStore, getPinned, pinOnFirstContact } from "../a2a-client/did-verifier"
import { receiveShare } from "../a2a-client/adapter"
import type { DidResolution, SeenLedgerLike } from "../a2a-client/adapter"
import { wrapInDataPart } from "../a2a-client/a2a-message"
import type { A2AMessage } from "../a2a-client/a2a-message"
import { sealEnvelope } from "../a2a-client/sealed-envelope"
import { sealTo } from "../a2a-client/seal"
import { signEnvelope, serializeProof } from "../a2a-client/sign"
import type { FriendStore } from "../store"
import type { MissionStore } from "../mission-store"
import { readySodium } from "./_sodium"

type Sodium = Awaited<ReturnType<typeof readySodium>>
const NOW_MS = Date.parse("2026-09-24T05:00:00.000Z")
const iso = (ms: number) => new Date(ms).toISOString()
const TOKEN = "SYNTHETICrelayTOKEN_0123456789-abc"
class Seen implements SeenLedgerLike { s = new Set<string>(); isSeen(n: string) { return this.s.has(n) } markSeen(n: string) { this.s.add(n) } }
const noStore = new Proxy({}, { get() { throw new Error("store touched") } }) as FriendStore
const noMissions = new Proxy({}, { get() { throw new Error("missions touched") } }) as MissionStore

function res(sodium: Sodium): DidResolution {
  return { async resolveAndPin({ fromAgentId, did, pinStore }) {
    const e = getPinned(pinStore, fromAgentId); if (e) return { ed25519Pub: e.ed25519Pub }
    const p = parseDidKey(did); if (!p) return null
    pinOnFirstContact({ pinStore, fromAgentId, did, ed25519Pub: p.ed25519Pub }); return { ed25519Pub: p.ed25519Pub }
  } }
}
async function agents() {
  const sodium = await readySodium()
  const mk = () => { const k = sodium.crypto_sign_keypair(); return didKeyIdentityFromEd25519({ sodium, ed25519Pub: k.publicKey, ed25519Priv: k.privateKey }) }
  return { sodium, a: mk(), b: mk() }
}
function recv(sodium: Sodium, b: DidKeyIdentity, m: A2AMessage, now = NOW_MS, seen = new Seen()) {
  return receiveShare({ sodium, store: noStore, missionStore: noMissions, pinStore: new MemoryPinStore(), didResolution: res(sodium), seen, a2aMessage: m,
    recipientDid: b.did, recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub }, trustOfSource: "family", options: { now, rejectUnboundEnvelopes: true } })
}
function seal(sodium: Sodium, a: DidKeyIdentity, b: DidKeyIdentity, env: Record<string, unknown>): A2AMessage {
  const s = sealEnvelope({ sodium, envelope: env, friendsKind: "message", fromIdentity: a, recipientDid: b.did, recipientX25519Pub: b.x25519Pub })
  return wrapInDataPart({ sealedEnvelope: s, recipientDid: b.did }) as unknown as A2AMessage
}
// Sign `signed`, then seal `sent` with that signature (tamper after signing). bind=false omits binding.
function tamper(sodium: Sodium, a: DidKeyIdentity, b: DidKeyIdentity, signed: Record<string, unknown>, mutate: (e: Record<string, unknown>) => Record<string, unknown>, bind = true): A2AMessage {
  const bound = bind ? { ...signed, binding: { to: b.did, kind: "message", id: sodium.to_base64(sodium.randombytes_buf(16), sodium.base64_variants.URLSAFE_NO_PADDING) } } : signed
  const proof = signEnvelope({ sodium, envelope: bound, signerEd25519Priv: a.ed25519Priv, signerDid: a.did, signerKeyId: a.keyId })
  const env = { ...mutate({ ...bound }), proof: serializeProof(proof) }
  const pt = { envelope: env, signature: proof.sig, signerDid: a.did, signerKeyId: a.keyId, recipient: b.did, v: 1, friendsKind: "message" }
  const sealed = sealTo({ sodium, plaintextBytes: new TextEncoder().encode(JSON.stringify(pt)), recipientX25519Pub: b.x25519Pub, recipientDid: b.did })
  return wrapInDataPart({ sealedEnvelope: { v: 1, sealed }, recipientDid: b.did }) as unknown as A2AMessage
}
const env = (a: DidKeyIdentity, at = NOW_MS, extra: Record<string, unknown> = {}) =>
  ({ fromAgentId: a.did, text: "x", approvalAnswer: { relayToken: TOKEN, decision: "deny" }, issuedAt: iso(at), ...extra })

describe("a signed approval answer, tampered with", () => {
  // This version accepts deny only, so a flip to approve fails the shape check before the signature is even
  // checked, and nothing is marked seen.
  it("is refused, and not marked seen, when its decision is changed after signing", async () => {
    const { sodium, a, b } = await agents()
    const m = tamper(sodium, a, b, env(a), (e) => ({ ...e, approvalAnswer: { relayToken: TOKEN, decision: "approve" } }))
    const seen = new Seen()
    expect(await recv(sodium, b, m, NOW_MS, seen)).toMatchObject({ state: "rejected", reason: "malformed_plaintext" })
    expect(seen.s.size).toBe(0)
  })

  it("is refused when its token is swapped after signing", async () => {
    const { sodium, a, b } = await agents()
    const m = tamper(sodium, a, b, env(a), (e) => ({ ...e, approvalAnswer: { relayToken: `${TOKEN}X`, decision: "deny" } }))
    expect(await recv(sodium, b, m)).toMatchObject({ state: "rejected", reason: "bad_signature" })
  })

  it("is refused when stripped from a signed envelope, or added to a signed plain message", async () => {
    const { sodium, a, b } = await agents()
    const strip = tamper(sodium, a, b, env(a), (e) => { const { approvalAnswer: _dropped, ...rest } = e; return rest })
    expect(await recv(sodium, b, strip)).toMatchObject({ state: "rejected", reason: "bad_signature" })
    const add = tamper(sodium, a, b, { fromAgentId: a.did, text: "x", issuedAt: iso(NOW_MS) }, (e) => ({ ...e, approvalAnswer: { relayToken: TOKEN, decision: "deny" } }))
    expect(await recv(sodium, b, add)).toMatchObject({ state: "rejected", reason: "bad_signature" })
  })

  it("is accepted exactly up to 10 minutes old and 2 minutes ahead, and refused past either edge", async () => {
    const { sodium, a, b } = await agents()
    const at = (age: number) => recv(sodium, b, seal(sodium, a, b, env(a, NOW_MS - age)))
    expect(await at(10 * 60_000)).toMatchObject({ state: "completed" })
    expect(await at(10 * 60_000 + 1)).toMatchObject({ state: "rejected", reason: "stale_approval_answer" })
    expect(await at(-2 * 60_000)).toMatchObject({ state: "completed" })
    expect(await at(-2 * 60_000 - 1)).toMatchObject({ state: "rejected", reason: "stale_approval_answer" })
  })

  it("is refused, and not marked seen, when the envelope also carries onBehalfOf", async () => {
    const { sodium, a, b } = await agents()
    const seen = new Seen()
    expect(await recv(sodium, b, seal(sodium, a, b, env(a, NOW_MS, { onBehalfOf: "principal" })), NOW_MS, seen))
      .toMatchObject({ state: "rejected", reason: "malformed_plaintext" })
    expect(seen.s.size).toBe(0)
  })
})
