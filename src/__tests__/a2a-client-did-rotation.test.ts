import { describe, it, expect } from "vitest"

import { didKeyIdentityFromEd25519 } from "../a2a-client/did-key"
import {
  DidVerifier,
  evaluateRotation,
  getPinned,
  MemoryPinStore,
  pinOnFirstContact,
  signSuccessor,
} from "../a2a-client/did-verifier"
import { serializeProof, signEnvelope } from "../a2a-client/sign"
import { readySodium } from "./_sodium"

async function mint() {
  const sodium = await readySodium()
  const kp = sodium.crypto_sign_keypair()
  return { sodium, id: didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey }) }
}

const T1 = "2026-10-01T00:00:00.000Z"
const T2 = "2026-10-02T00:00:00.000Z"
const T3 = "2026-10-03T00:00:00.000Z"
const NOW = new Date("2026-10-05T00:00:00.000Z")

async function fixture() {
  const { sodium, id: a } = await mint()
  const { id: b } = await mint()
  const { id: c } = await mint()
  const pinStore = new MemoryPinStore()
  pinOnFirstContact({ pinStore, fromAgentId: a.did, did: a.did, ed25519Pub: a.ed25519Pub })
  return { sodium, a, b, c, pinStore }
}

function rotate(
  f: Awaited<ReturnType<typeof fixture>>,
  from: { did: string; ed25519Priv: Uint8Array },
  to: { did: string; ed25519Pub: Uint8Array },
  issuedAt?: string,
) {
  const rotationProof = signSuccessor({ sodium: f.sodium, oldEd25519Priv: from.ed25519Priv, newDid: to.did, newEd25519Pub: to.ed25519Pub, ...(issuedAt ? { issuedAt } : {}) })
  return evaluateRotation({
    sodium: f.sodium,
    pinStore: f.pinStore,
    fromAgentId: from.did,
    trustOfSource: "friend",
    newDid: to.did,
    newEd25519Pub: to.ed25519Pub,
    rotationProof,
    ...(issuedAt ? { issuedAt } : {}),
    now: NOW,
  })
}

describe("key rotation to a new DID (audit finding 22)", () => {
  it("moves the pin to the new DID so messages signed by the new DID verify, and retires the old pin", async () => {
    const f = await fixture()
    expect(rotate(f, f.a, f.b, T1)).toEqual({ decision: "accepted" })

    expect(getPinned(f.pinStore, f.a.did)).toBeUndefined()
    const pinned = getPinned(f.pinStore, f.b.did)
    expect(pinned?.did).toBe(f.b.did)

    const env = { fromAgentId: f.b.did, scope: "name", issuedAt: T2 }
    const proof = serializeProof(signEnvelope({ sodium: f.sodium, envelope: env, signerEd25519Priv: f.b.ed25519Priv, signerDid: f.b.did, signerKeyId: f.b.keyId }))
    const verifier = new DidVerifier({ sodium: f.sodium, pinnedEd25519Pub: pinned!.ed25519Pub, pinnedDid: pinned!.did, envelope: { ...env, proof } })
    expect(verifier.verify(f.b.did, proof)).toBe(true)
  })

  it("rejects a successor statement that is not newer than the current pin", async () => {
    const f = await fixture()
    expect(rotate(f, f.a, f.b, T2).decision).toBe("accepted")
    expect(rotate(f, f.b, f.c, T2)).toEqual({ decision: "rejected", reason: "stale_rotation" })
    expect(rotate(f, f.b, f.c, T1)).toEqual({ decision: "rejected", reason: "stale_rotation" })
    expect(getPinned(f.pinStore, f.b.did)).toBeDefined()
    expect(rotate(f, f.b, f.c, T3).decision).toBe("accepted")
    expect(getPinned(f.pinStore, f.b.did)).toBeUndefined()
    expect(getPinned(f.pinStore, f.c.did)).toBeDefined()
  })

  it("rejects a successor statement dated in the future", async () => {
    const f = await fixture()
    expect(rotate(f, f.a, f.b, "2026-12-01T00:00:00.000Z")).toEqual({ decision: "rejected", reason: "stale_rotation" })
  })

  it("accepts the old statement shape (no issuedAt) only for the very first rotation", async () => {
    const f = await fixture()
    expect(rotate(f, f.a, f.b).decision).toBe("accepted")
    expect(rotate(f, f.b, f.c)).toEqual({ decision: "rejected", reason: "stale_rotation" })
    // A dated statement signed after the first rotation was accepted still works.
    expect(rotate(f, f.b, f.c, "2026-10-05T00:01:00.000Z").decision).toBe("accepted")
  })

  it("a statement signed without issuedAt does not verify when issuedAt is claimed", async () => {
    const f = await fixture()
    const rotationProof = signSuccessor({ sodium: f.sodium, oldEd25519Priv: f.a.ed25519Priv, newDid: f.b.did, newEd25519Pub: f.b.ed25519Pub })
    expect(evaluateRotation({ sodium: f.sodium, pinStore: f.pinStore, fromAgentId: f.a.did, trustOfSource: "friend", newDid: f.b.did, newEd25519Pub: f.b.ed25519Pub, rotationProof, issuedAt: T1, now: NOW }))
      .toEqual({ decision: "rejected", reason: "bad_rotation_proof" })
  })
})
