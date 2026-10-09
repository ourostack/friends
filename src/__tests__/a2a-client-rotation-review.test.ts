import { describe, it, expect } from "vitest"

import { didKeyIdentityFromEd25519 } from "../a2a-client/did-key"
import type { DidKeyIdentity } from "../a2a-client/did-key"
import { didKeyResolutionFor } from "./_did-key-resolution"
import {
  applyAcceptedRotation,
  evaluateRotation,
  getPinned,
  MemoryPinStore,
  pinOnFirstContact,
  signSuccessor,
} from "../a2a-client/did-verifier"
import { receiveShare, sendShare } from "../a2a-client/adapter"
import type { A2AMessage, } from "../a2a-client/a2a-message"
import type { A2ATransport, SeenLedgerLike } from "../a2a-client/adapter"
import { prepareMessage } from "../message"
import type { FriendRecord, FriendStore } from "../index"
import { readySodium } from "./_sodium"

const T1 = "2026-10-01T00:00:00.000Z"
const NOW = new Date("2026-10-05T00:00:00.000Z")

async function mint(sodium: Awaited<ReturnType<typeof readySodium>>): Promise<DidKeyIdentity> {
  const kp = sodium.crypto_sign_keypair()
  return didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
}

async function setup() {
  const sodium = await readySodium()
  const [a, c, victim, me] = [await mint(sodium), await mint(sodium), await mint(sodium), await mint(sodium)]
  const pinStore = new MemoryPinStore()
  pinOnFirstContact({ pinStore, fromAgentId: a.did, did: a.did, ed25519Pub: a.ed25519Pub })
  const rotateTo = (newDid: string, newPub: Uint8Array, extra: Record<string, unknown> = {}) =>
    evaluateRotation({
      sodium, pinStore, fromAgentId: a.did, trustOfSource: "friend", newDid, newEd25519Pub: newPub,
      rotationProof: signSuccessor({ sodium, oldEd25519Priv: a.ed25519Priv, newDid, newEd25519Pub: newPub, issuedAt: T1 }),
      issuedAt: T1, now: NOW, ...extra,
    })
  return { sodium, a, c, victim, me, pinStore, rotateTo }
}

describe("a rotation must bind the successor DID to the successor key (review item 1)", () => {
  it("rejects a friend rotating to a victim's unpinned did:key with its own key, and writes no pin", async () => {
    const s = await setup()
    const result = s.rotateTo(s.victim.did, s.c.ed25519Pub)
    expect(result).toEqual({ decision: "rejected", reason: "successor_key_mismatch" })
    expect(s.pinStore.get(s.victim.did)).toBeUndefined()
    expect(getPinned(s.pinStore, s.a.did)).toBeDefined()
  })

  it("rejects a same-DID rotation whose key does not match the did:key", async () => {
    const s = await setup()
    expect(s.rotateTo(s.a.did, s.c.ed25519Pub)).toEqual({ decision: "rejected", reason: "successor_key_mismatch" })
    expect(getPinned(s.pinStore, s.a.did)?.ed25519Pub).toEqual(s.a.ed25519Pub)
  })

  it("still accepts a legitimate rotation to the new did:key", async () => {
    const s = await setup()
    expect(s.rotateTo(s.c.did, s.c.ed25519Pub)).toEqual({ decision: "accepted" })
    expect(getPinned(s.pinStore, s.c.did)?.ed25519Pub).toEqual(s.c.ed25519Pub)
  })

  it("rejects a rotation to a different non-did:key DID without a resolved successor key", async () => {
    const s = await setup()
    expect(s.rotateTo("did:web:new.example", s.c.ed25519Pub)).toEqual({ decision: "rejected", reason: "successor_key_mismatch" })
    expect(s.pinStore.get("did:web:new.example")).toBeUndefined()
  })

  it("rejects when the resolved successor key differs, accepts when it matches", async () => {
    const s = await setup()
    expect(s.rotateTo("did:web:new.example", s.c.ed25519Pub, { resolvedSuccessorPub: s.victim.ed25519Pub }))
      .toEqual({ decision: "rejected", reason: "successor_key_mismatch" })
    expect(s.rotateTo("did:web:new.example", s.c.ed25519Pub, { resolvedSuccessorPub: s.c.ed25519Pub }))
      .toEqual({ decision: "accepted" })
  })
})

class Seen implements SeenLedgerLike {
  private readonly set = new Set<string>()
  isSeen(n: string) { return this.set.has(n) }
  markSeen(n: string) { this.set.add(n) }
}

function memStore(initial: FriendRecord[]): FriendStore {
  const records = new Map(initial.map((r) => [r.id, r]))
  return {
    async get(id) { return records.get(id) ?? null },
    async put(id, r) { records.set(id, r) },
    async delete(id) { records.delete(id) },
    async findByExternalId(provider, externalId) {
      for (const r of records.values()) if (r.externalIds.some((e) => e.provider === provider && e.externalId === externalId)) return r
      return null
    },
    async listAll() { return [...records.values()] },
  } as FriendStore
}

function peerRecord(did: string): FriendRecord {
  return {
    id: "peer-rec", name: "Peer", role: "friend", trustLevel: "friend", admissionState: "active",
    capabilityProfileId: "prof", delegationGrant: { scope: "principal_commands", grantedAt: T1, source: "operator" },
    connections: [], externalIds: [{ provider: "a2a-agent", externalId: did, linkedAt: T1 }],
    tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: T1, updatedAt: T1, schemaVersion: 1,
    kind: "agent",
    agentMeta: { bundleName: "peer", familiarity: 0, sharedMissions: [], outcomes: [], a2a: { agentId: did, did }, identity: { did, pinnedKey: "K" } },
  }
}

async function wireFrom(s: Awaited<ReturnType<typeof setup>>, from: DidKeyIdentity): Promise<A2AMessage> {
  const sent: A2AMessage[] = []
  const transport: A2ATransport = { async send(_t, m) { sent.push(m) } }
  const prepared = prepareMessage({ fromAgentId: from.did, text: "hello", now: () => NOW.toISOString() })
  if (!prepared.ok) throw new Error(prepared.status)
  const r = await sendShare({
    sodium: s.sodium, transport, fromIdentity: from,
    toPeer: { a2a: { endpointUrl: "https://me.example/a2a", did: s.me.did } },
    recipientDid: s.me.did, recipientX25519Pub: s.me.x25519Pub,
    plaintextEnvelope: prepared.envelope as unknown as Record<string, unknown>, friendsKind: "message",
  })
  expect(r.ok).toBe(true)
  return sent[0]
}

function receive(s: Awaited<ReturnType<typeof setup>>, wire: A2AMessage) {
  return receiveShare({
    sodium: s.sodium, store: memStore([]), missionStore: undefined as never, pinStore: s.pinStore,
    didResolution: didKeyResolutionFor(s.sodium), seen: new Seen(), a2aMessage: wire,
    recipientDid: s.me.did, recipientIdentity: { x25519Priv: s.me.x25519Priv, x25519Pub: s.me.x25519Pub },
    trustOfSource: "friend", options: { now: NOW },
  })
}

describe("a retired pin no longer verifies in receiveShare (review item 2)", () => {
  it("rejects a message signed with the old key as the old DID after a rotation", async () => {
    const s = await setup()
    const before = await wireFrom(s, s.a)
    expect((await receive(s, before)).state).toBe("completed")
    expect(s.rotateTo(s.c.did, s.c.ed25519Pub)).toEqual({ decision: "accepted" })
    const after = await wireFrom(s, s.a)
    expect(await receive(s, after)).toEqual({ state: "rejected", reason: "retired_pin" })
  })
})

describe("applyAcceptedRotation keeps the relationship across a rotation (review item 3)", () => {
  it("moves the record to the new DID, keeps trust, grant and profile, and the new DID resolves to it", async () => {
    const s = await setup()
    const store = memStore([peerRecord(s.a.did)])
    expect(s.rotateTo(s.c.did, s.c.ed25519Pub)).toEqual({ decision: "accepted" })
    const applied = await applyAcceptedRotation({ store, pinStore: s.pinStore, oldDid: s.a.did, newDid: s.c.did })
    expect(applied.ok).toBe(true)
    const found = await store.findByExternalId("a2a-agent", s.c.did)
    expect(found?.id).toBe("peer-rec")
    expect(found?.trustLevel).toBe("friend")
    expect(found?.admissionState).toBe("active")
    expect(found?.capabilityProfileId).toBe("prof")
    expect(found?.delegationGrant).toBeDefined()
    expect(found?.trustReset).toBeUndefined()
    expect(found?.agentMeta?.a2a?.did).toBe(s.c.did)
    expect(found?.agentMeta?.a2a?.agentId).toBe(s.c.did)
    expect(found?.agentMeta?.identity?.did).toBe(s.c.did)
    expect(found?.agentMeta?.identity?.pinnedKey).toBeUndefined()
    expect(await store.findByExternalId("a2a-agent", s.a.did)).toBeNull()
    // And a message from the new DID is received.
    expect((await receive(s, await wireFrom(s, s.c))).state).toBe("completed")
  })

  it("refuses a forged call when no rotation was accepted", async () => {
    const s = await setup()
    const store = memStore([peerRecord(s.a.did)])
    const forged = await applyAcceptedRotation({ store, pinStore: s.pinStore, oldDid: s.a.did, newDid: s.victim.did })
    expect(forged).toEqual({ ok: false, reason: "rotation_not_accepted" })
    expect((await store.get("peer-rec"))?.externalIds[0].externalId).toBe(s.a.did)
  })

  it("refuses when the successor pin is not live, no record holds the old DID, or another record holds the new one", async () => {
    const s = await setup()
    expect(s.rotateTo(s.c.did, s.c.ed25519Pub)).toEqual({ decision: "accepted" })
    s.pinStore.retire(s.c.did, s.victim.did, T1)
    const store = memStore([peerRecord(s.a.did)])
    expect(await applyAcceptedRotation({ store, pinStore: s.pinStore, oldDid: s.a.did, newDid: s.c.did }))
      .toEqual({ ok: false, reason: "rotation_not_accepted" })

    const s2 = await setup()
    expect(s2.rotateTo(s2.c.did, s2.c.ed25519Pub)).toEqual({ decision: "accepted" })
    expect(await applyAcceptedRotation({ store: memStore([]), pinStore: s2.pinStore, oldDid: s2.a.did, newDid: s2.c.did }))
      .toEqual({ ok: false, reason: "record_not_found" })
    const other = { ...peerRecord(s2.c.did), id: "other" }
    expect(await applyAcceptedRotation({ store: memStore([peerRecord(s2.a.did), other]), pinStore: s2.pinStore, oldDid: s2.a.did, newDid: s2.c.did }))
      .toEqual({ ok: false, reason: "successor_already_linked" })
  })

  it("is idempotent: a second call after success reports the record as already moved", async () => {
    const s = await setup()
    const store = memStore([peerRecord(s.a.did)])
    s.rotateTo(s.c.did, s.c.ed25519Pub)
    await applyAcceptedRotation({ store, pinStore: s.pinStore, oldDid: s.a.did, newDid: s.c.did })
    expect(await applyAcceptedRotation({ store, pinStore: s.pinStore, oldDid: s.a.did, newDid: s.c.did }))
      .toEqual({ ok: false, reason: "record_not_found" })
  })

  it("handles records with no agent meta, no identity or no a2a coordinates, and keeps unrelated external ids", async () => {
    const variants: Array<(r: FriendRecord) => FriendRecord> = [
      (r) => { const { agentMeta: _m, ...rest } = r; return rest },
      (r) => ({ ...r, agentMeta: { ...r.agentMeta!, identity: undefined, a2a: undefined } }),
      (r) => ({ ...r, agentMeta: { ...r.agentMeta!, identity: { did: r.externalIds[0].externalId, handle: "h" } } }),
      (r) => ({ ...r, externalIds: [{ provider: "telegram-user", externalId: "9", linkedAt: T1 }, ...r.externalIds] }),
    ]
    for (const variant of variants) {
      const s = await setup()
      const store = memStore([variant(peerRecord(s.a.did))])
      s.rotateTo(s.c.did, s.c.ed25519Pub)
      const result = await applyAcceptedRotation({ store, pinStore: s.pinStore, oldDid: s.a.did, newDid: s.c.did })
      expect(result.ok).toBe(true)
      expect(await store.findByExternalId("a2a-agent", s.c.did)).not.toBeNull()
    }
  })
})
