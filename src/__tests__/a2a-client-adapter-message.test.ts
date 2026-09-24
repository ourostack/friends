// End-to-end: a direct agent message sealed + signed by A, received by B through
// the same receiveShare path as every other friends kind (real did:key agents).
import { describe, expect, it } from "vitest"

import { didKeyIdentityFromEd25519, keyAgreementFromDidKey, parseDidKey } from "../a2a-client/did-key"
import type { DidKeyIdentity } from "../a2a-client/did-key"
import { MemoryPinStore, pinOnFirstContact } from "../a2a-client/did-verifier"
import { receiveShare, sendShare } from "../a2a-client/adapter"
import type { A2ATransport, DidResolution, SeenLedgerLike } from "../a2a-client/adapter"
import type { A2AMessage } from "../a2a-client/a2a-message"
import { sealEnvelope } from "../a2a-client/sealed-envelope"
import { wrapInDataPart } from "../a2a-client/a2a-message"
import { prepareMessage } from "../message"
import type { FriendStore } from "../store"
import type { MissionStore } from "../mission-store"
import type { TrustLevel } from "../types"
import { readySodium } from "./_sodium"

type Sodium = Awaited<ReturnType<typeof readySodium>>
const NOW = "2026-09-24T05:00:00.000Z"

class SeenLedger implements SeenLedgerLike {
  private readonly set = new Set<string>()
  isSeen(n: string) { return this.set.has(n) }
  markSeen(n: string) { this.set.add(n) }
}

// A message imports nothing, so the stores must never be touched.
const untouchedStore = new Proxy({}, { get() { throw new Error("message receipt must not touch the friend store") } }) as FriendStore
const untouchedMissions = new Proxy({}, { get() { throw new Error("message receipt must not touch the mission store") } }) as MissionStore

function didKeyResolution(sodium: Sodium): DidResolution {
  return {
    async resolveAndPin({ fromAgentId, did, pinStore }) {
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

async function twoAgents(): Promise<{ sodium: Sodium; a: DidKeyIdentity; b: DidKeyIdentity }> {
  const sodium = await readySodium()
  const aKp = sodium.crypto_sign_keypair()
  const bKp = sodium.crypto_sign_keypair()
  return {
    sodium,
    a: didKeyIdentityFromEd25519({ sodium, ed25519Pub: aKp.publicKey, ed25519Priv: aKp.privateKey }),
    b: didKeyIdentityFromEd25519({ sodium, ed25519Pub: bKp.publicKey, ed25519Priv: bKp.privateKey }),
  }
}

async function sendFromA(sodium: Sodium, a: DidKeyIdentity, b: DidKeyIdentity, envelope: Record<string, unknown>): Promise<A2AMessage> {
  const sent: A2AMessage[] = []
  const transport: A2ATransport = { async send(_target, message) { sent.push(message) } }
  const r = await sendShare({
    sodium, transport, fromIdentity: a,
    toPeer: { a2a: { endpointUrl: "https://b.example/a2a", did: b.did } },
    recipientDid: b.did, recipientX25519Pub: b.x25519Pub,
    plaintextEnvelope: envelope, friendsKind: "message",
  })
  expect(r.ok).toBe(true)
  return sent[0]
}

function receiveAt(sodium: Sodium, b: DidKeyIdentity, message: A2AMessage, trustOfSource: TrustLevel, seen = new SeenLedger()) {
  return receiveShare({
    sodium, store: untouchedStore, missionStore: untouchedMissions, pinStore: new MemoryPinStore(),
    didResolution: didKeyResolution(sodium), seen, a2aMessage: message,
    recipientDid: b.did, recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub }, trustOfSource,
  })
}

function messageFrom(a: DidKeyIdentity, text = "are you up?", conversationId?: string): Record<string, unknown> {
  const prepared = prepareMessage({ fromAgentId: a.did, text, ...(conversationId ? { conversationId } : {}), now: () => NOW })
  if (!prepared.ok) throw new Error(prepared.status)
  return prepared.envelope as unknown as Record<string, unknown>
}

describe("receiveShare — direct agent messages", () => {
  it("delivers the verified text and signed sender to a trusted recipient", async () => {
    const { sodium, a, b } = await twoAgents()
    const wire = await sendFromA(sodium, a, b, messageFrom(a, "are you up?", "ctx-1"))
    expect(JSON.stringify(wire)).not.toContain("are you up?") // sealed: text never on the wire in the clear
    const r = await receiveAt(sodium, b, wire, "family")
    expect(r).toEqual({
      state: "completed", friendsKind: "message", status: "received",
      message: { fromAgentId: a.did, text: "are you up?", conversationId: "ctx-1", issuedAt: NOW },
    })
  })

  it("rejects a replay of the same sealed message", async () => {
    const { sodium, a, b } = await twoAgents()
    const wire = await sendFromA(sodium, a, b, messageFrom(a))
    const seen = new SeenLedger()
    expect((await receiveAt(sodium, b, wire, "friend", seen)).state).toBe("completed")
    expect(await receiveAt(sodium, b, wire, "friend", seen)).toEqual({ state: "rejected", reason: "replayed" })
  })

  it("rejects a stranger sender as untrusted_source", async () => {
    const { sodium, a, b } = await twoAgents()
    const wire = await sendFromA(sodium, a, b, messageFrom(a))
    expect(await receiveAt(sodium, b, wire, "stranger")).toEqual({ state: "rejected", reason: "untrusted_source" })
  })

  it("rejects a malformed message envelope as malformed_plaintext", async () => {
    const { sodium, a, b } = await twoAgents()
    const wire = await sendFromA(sodium, a, b, { fromAgentId: a.did, text: "", issuedAt: NOW })
    expect(await receiveAt(sodium, b, wire, "family")).toEqual({ state: "rejected", reason: "malformed_plaintext" })
  })

  it("rejects an envelope sealed under an unknown kind instead of routing it to another importer", async () => {
    const { sodium, a, b } = await twoAgents()
    const sealed = sealEnvelope({
      sodium, envelope: messageFrom(a), friendsKind: "chat_v0" as never, fromIdentity: a,
      recipientDid: b.did, recipientX25519Pub: b.x25519Pub,
    })
    const wire = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: b.did })
    expect(await receiveAt(sodium, b, wire, "family")).toEqual({ state: "rejected", reason: "malformed_plaintext" })
  })
})
