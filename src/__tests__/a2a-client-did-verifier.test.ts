// DidVerifier — the AgentVerifier seam impl: agentId===did binding, TOFU pin,
// trust-tiered key rotation. Real did:key identities + real Ed25519. The importer
// integration proves a valid signed share is ACCEPTED through this verifier and a
// forged one is mapped to `untrusted_source`.
import { describe, expect, it } from "vitest"

import { importProfileShare } from "../share"
import type { ProfileShareEnvelope } from "../share"
import type { FriendRecord, IdentityProvider } from "../types"
import type { FriendStore } from "../store"
import { didKeyIdentityFromEd25519 } from "../a2a-client/did-key"
import type { DidKeyIdentity } from "../a2a-client/did-key"
import {
  DidVerifier,
  evaluateRotation,
  getPinned,
  isPinned,
  MemoryPinStore,
  pinOnFirstContact,
  signSuccessor,
  verifyCardDidBinding,
} from "../a2a-client/did-verifier"
import { serializeProof, signEnvelope } from "../a2a-client/sign"
import { readySodium } from "./_sodium"

const NOW = "2026-01-01T00:00:00.000Z"

class MemoryStore implements FriendStore {
  readonly records = new Map<string, FriendRecord>()
  constructor(initial: FriendRecord[] = []) {
    for (const f of initial) this.records.set(f.id, f)
  }
  async get(id: string) {
    return this.records.get(id) ?? null
  }
  async put(id: string, record: FriendRecord) {
    this.records.set(id, record)
  }
  async delete(id: string) {
    this.records.delete(id)
  }
  async findByExternalId(provider: string, externalId: string, tenantId?: string) {
    for (const r of this.records.values()) {
      if (r.externalIds.find((e) => e.provider === provider && e.externalId === externalId && (tenantId === undefined || e.tenantId === tenantId))) {
        return r
      }
    }
    return null
  }
  async listAll() {
    return Array.from(this.records.values())
  }
}

function subjectRecord(): FriendRecord {
  return {
    id: "subj-1",
    name: "Jordan",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [{ provider: "aad" as IdentityProvider, externalId: "jordan-aad", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  }
}

async function mintIdentity(): Promise<{ sodium: Awaited<ReturnType<typeof readySodium>>; id: DidKeyIdentity }> {
  const sodium = await readySodium()
  const kp = sodium.crypto_sign_keypair()
  const id = didKeyIdentityFromEd25519({ sodium, ed25519Pub: kp.publicKey, ed25519Priv: kp.privateKey })
  return { sodium, id }
}

function unsignedEnvelope(fromAgentId: string): ProfileShareEnvelope {
  return {
    subject: { externalIds: [{ provider: "aad" as IdentityProvider, externalId: "jordan-aad", linkedAt: NOW }], displayName: "Jordan" },
    fromAgentId,
    scope: "notes:safe",
    notes: [{ key: "role", value: "designer" }],
    issuedAt: NOW,
  }
}

describe("DidVerifier.verify — happy path + importer integration", () => {
  it("a signed envelope from a pinned peer (signerDid===fromAgentId) verifies true", async () => {
    const { sodium, id } = await mintIdentity()
    const env = unsignedEnvelope(id.did)
    const proof = signEnvelope({ sodium, envelope: env, signerEd25519Priv: id.ed25519Priv, signerDid: id.did, signerKeyId: id.keyId })
    const envWithProof = { ...env, proof: serializeProof(proof) }
    const verifier = new DidVerifier({ sodium, pinnedEd25519Pub: id.ed25519Pub, pinnedDid: id.did, envelope: envWithProof })
    expect(verifier.verify(id.did, serializeProof(proof))).toBe(true)
  })

  it("the importer ACCEPTS a valid friend share gated by the DidVerifier (not untrusted_source)", async () => {
    const { sodium, id } = await mintIdentity()
    const store = new MemoryStore([subjectRecord()])
    const env = unsignedEnvelope(id.did)
    const proof = signEnvelope({ sodium, envelope: env, signerEd25519Priv: id.ed25519Priv, signerDid: id.did, signerKeyId: id.keyId })
    const envWithProof: ProfileShareEnvelope = { ...env, proof: serializeProof(proof) }
    const verifier = new DidVerifier({ sodium, pinnedEd25519Pub: id.ed25519Pub, pinnedDid: id.did, envelope: envWithProof })

    const result = await importProfileShare(store, { envelope: envWithProof, fromAgentId: id.did, trustOfSource: "friend" }, { verifier })
    expect(result.ok).toBe(true)
    expect(result.status).toBe("imported")
  })

  it("the importer REJECTS a forged proof as untrusted_source (DidVerifier.verify false)", async () => {
    const { sodium, id } = await mintIdentity()
    const mallory = sodium.crypto_sign_keypair()
    const store = new MemoryStore([subjectRecord()])
    const env = unsignedEnvelope(id.did)
    // Mallory signs claiming to be `id.did`, but the verifier is pinned to id's REAL key.
    const forged = signEnvelope({ sodium, envelope: env, signerEd25519Priv: mallory.privateKey, signerDid: id.did, signerKeyId: id.keyId })
    const envWithForged: ProfileShareEnvelope = { ...env, proof: serializeProof(forged) }
    const verifier = new DidVerifier({ sodium, pinnedEd25519Pub: id.ed25519Pub, pinnedDid: id.did, envelope: envWithForged })

    const result = await importProfileShare(store, { envelope: envWithForged, fromAgentId: id.did, trustOfSource: "friend" }, { verifier })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
  })
})

describe("DidVerifier.verify — binding & reject branches", () => {
  it("undefined proof → false", async () => {
    const { sodium, id } = await mintIdentity()
    const verifier = new DidVerifier({ sodium, pinnedEd25519Pub: id.ed25519Pub, pinnedDid: id.did, envelope: unsignedEnvelope(id.did) })
    expect(verifier.verify(id.did, undefined)).toBe(false)
  })

  it("unparseable proof → false", async () => {
    const { sodium, id } = await mintIdentity()
    const verifier = new DidVerifier({ sodium, pinnedEd25519Pub: id.ed25519Pub, pinnedDid: id.did, envelope: unsignedEnvelope(id.did) })
    expect(verifier.verify(id.did, "{not json")).toBe(false)
  })

  it("signerDid !== fromAgentId → false (agentId≠did spoof rejected)", async () => {
    const { sodium, id } = await mintIdentity()
    const env = unsignedEnvelope(id.did)
    const proof = signEnvelope({ sodium, envelope: env, signerEd25519Priv: id.ed25519Priv, signerDid: id.did, signerKeyId: id.keyId })
    const verifier = new DidVerifier({ sodium, pinnedEd25519Pub: id.ed25519Pub, pinnedDid: id.did, envelope: { ...env, proof: serializeProof(proof) } })
    // The arriving agentId differs from the proof's signerDid → reject.
    expect(verifier.verify("did:key:zSomeoneElse", serializeProof(proof))).toBe(false)
  })

  it("signerDid !== pinnedDid → false (proof claims a different DID than pinned)", async () => {
    const { sodium, id } = await mintIdentity()
    const other = await mintIdentity()
    const env = unsignedEnvelope(other.id.did)
    const proof = signEnvelope({ sodium, envelope: env, signerEd25519Priv: other.id.ed25519Priv, signerDid: other.id.did, signerKeyId: other.id.keyId })
    // Pinned to `id`, but the proof (and fromAgentId) claim `other`.
    const verifier = new DidVerifier({ sodium, pinnedEd25519Pub: id.ed25519Pub, pinnedDid: id.did, envelope: { ...env, proof: serializeProof(proof) } })
    expect(verifier.verify(other.id.did, serializeProof(proof))).toBe(false)
  })

  it("a valid binding but a signature by the wrong key → false (forge)", async () => {
    const { sodium, id } = await mintIdentity()
    const mallory = sodium.crypto_sign_keypair()
    const env = unsignedEnvelope(id.did)
    const forged = signEnvelope({ sodium, envelope: env, signerEd25519Priv: mallory.privateKey, signerDid: id.did, signerKeyId: id.keyId })
    const verifier = new DidVerifier({ sodium, pinnedEd25519Pub: id.ed25519Pub, pinnedDid: id.did, envelope: { ...env, proof: serializeProof(forged) } })
    expect(verifier.verify(id.did, serializeProof(forged))).toBe(false)
  })
})

describe("verifyCardDidBinding", () => {
  it("did:key (didDoc null): true when card.did === did", () => {
    expect(verifyCardDidBinding({ card: { did: "did:key:zA" }, didDoc: null, did: "did:key:zA" })).toBe(true)
  })

  it("did:key: false when card.did !== did", () => {
    expect(verifyCardDidBinding({ card: { did: "did:key:zB" }, didDoc: null, did: "did:key:zA" })).toBe(false)
  })

  it("did:key: false when card.did is missing/non-string", () => {
    expect(verifyCardDidBinding({ card: {}, didDoc: null, did: "did:key:zA" })).toBe(false)
    expect(verifyCardDidBinding({ card: { did: 42 }, didDoc: null, did: "did:key:zA" })).toBe(false)
  })

  it("did:web: true when card.did === did === didDoc.id AND service references the card URL", () => {
    expect(
      verifyCardDidBinding({
        card: { did: "did:web:ex.com", url: "https://ex.com/card.json" },
        didDoc: { id: "did:web:ex.com", cardServiceUrl: "https://ex.com/card.json" },
        did: "did:web:ex.com",
      }),
    ).toBe(true)
  })

  it("did:web: false when didDoc.id !== did", () => {
    expect(
      verifyCardDidBinding({
        card: { did: "did:web:ex.com", url: "https://ex.com/card.json" },
        didDoc: { id: "did:web:other.com", cardServiceUrl: "https://ex.com/card.json" },
        did: "did:web:ex.com",
      }),
    ).toBe(false)
  })

  it("did:web: false when no card URL is present", () => {
    expect(
      verifyCardDidBinding({
        card: { did: "did:web:ex.com" },
        didDoc: { id: "did:web:ex.com", cardServiceUrl: "https://ex.com/card.json" },
        did: "did:web:ex.com",
      }),
    ).toBe(false)
  })

  it("did:web: false when the service does NOT reference the card URL", () => {
    expect(
      verifyCardDidBinding({
        card: { did: "did:web:ex.com", url: "https://ex.com/card.json" },
        didDoc: { id: "did:web:ex.com", cardServiceUrl: "https://ex.com/OTHER.json" },
        did: "did:web:ex.com",
      }),
    ).toBe(false)
  })
})

describe("TOFU pin", () => {
  it("first contact pins; isPinned/getPinned reflect it", async () => {
    const { id } = await mintIdentity()
    const pinStore = new MemoryPinStore()
    expect(isPinned(pinStore, id.did)).toBe(false)
    expect(getPinned(pinStore, id.did)).toBeUndefined()
    const pinned = pinOnFirstContact({ pinStore, fromAgentId: id.did, did: id.did, ed25519Pub: id.ed25519Pub })
    expect(pinned.did).toBe(id.did)
    expect(isPinned(pinStore, id.did)).toBe(true)
    expect(getPinned(pinStore, id.did)!.ed25519Pub).toEqual(id.ed25519Pub)
  })
})

describe("evaluateRotation — every trust-tier branch (Fork 11)", () => {
  async function pinnedFixture() {
    const { sodium, id } = await mintIdentity()
    const pinStore = new MemoryPinStore()
    pinOnFirstContact({ pinStore, fromAgentId: id.did, did: id.did, ed25519Pub: id.ed25519Pub })
    const next = await mintIdentity() // the rotation target
    return { sodium, id, pinStore, next }
  }

  it("an unpinned peer → rejected:not_pinned", async () => {
    const { sodium, next } = await pinnedFixture()
    const pinStore = new MemoryPinStore()
    const d = evaluateRotation({ sodium, pinStore, fromAgentId: "did:key:zUnknown", trustOfSource: "friend", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub })
    expect(d).toEqual({ decision: "rejected", reason: "not_pinned" })
  })

  it("an unchanged key → unchanged", async () => {
    const { sodium, id, pinStore } = await pinnedFixture()
    const d = evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "friend", newDid: id.did, newEd25519Pub: id.ed25519Pub })
    expect(d).toEqual({ decision: "unchanged" })
  })

  it("friend + VALID signed successor proof → accepted (re-pinned to the new key)", async () => {
    const { sodium, id, pinStore, next } = await pinnedFixture()
    const rotationProof = signSuccessor({ sodium, oldEd25519Priv: id.ed25519Priv, newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub })
    const d = evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "friend", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub, rotationProof })
    expect(d).toEqual({ decision: "accepted" })
    // re-pinned:
    expect(getPinned(pinStore, id.did)!.ed25519Pub).toEqual(next.id.ed25519Pub)
    expect(getPinned(pinStore, id.did)!.did).toBe(next.id.did)
  })

  it("family + VALID signed successor proof → accepted", async () => {
    const { sodium, id, pinStore, next } = await pinnedFixture()
    const rotationProof = signSuccessor({ sodium, oldEd25519Priv: id.ed25519Priv, newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub })
    expect(evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "family", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub, rotationProof }).decision).toBe("accepted")
  })

  it("friend + MISSING proof → rejected:bad_rotation_proof", async () => {
    const { sodium, id, pinStore, next } = await pinnedFixture()
    const d = evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "friend", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub })
    expect(d).toEqual({ decision: "rejected", reason: "bad_rotation_proof" })
    // NOT re-pinned: still the old key.
    expect(getPinned(pinStore, id.did)!.ed25519Pub).toEqual(id.ed25519Pub)
  })

  it("friend + INVALID proof (signed by the wrong key) → rejected:bad_rotation_proof", async () => {
    const { sodium, id, pinStore, next } = await pinnedFixture()
    const wrong = sodium.crypto_sign_keypair()
    const rotationProof = signSuccessor({ sodium, oldEd25519Priv: wrong.privateKey, newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub })
    expect(evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "friend", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub, rotationProof })).toEqual({ decision: "rejected", reason: "bad_rotation_proof" })
  })

  it("friend + proof over the WRONG successor → rejected:bad_rotation_proof", async () => {
    const { sodium, id, pinStore, next } = await pinnedFixture()
    const decoy = await mintIdentity()
    // Old key signs a statement about `decoy`, but we present `next`.
    const rotationProof = signSuccessor({ sodium, oldEd25519Priv: id.ed25519Priv, newDid: decoy.id.did, newEd25519Pub: decoy.id.ed25519Pub })
    expect(evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "friend", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub, rotationProof })).toEqual({ decision: "rejected", reason: "bad_rotation_proof" })
  })

  it("friend + non-base64 proof → rejected:bad_rotation_proof", async () => {
    const { sodium, id, pinStore, next } = await pinnedFixture()
    expect(evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "friend", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub, rotationProof: "!!!not-base64!!!" })).toEqual({ decision: "rejected", reason: "bad_rotation_proof" })
  })

  it("friend + wrong-LENGTH signature → rejected:bad_rotation_proof (verify_detached throws, caught)", async () => {
    const { sodium, id, pinStore, next } = await pinnedFixture()
    const short = sodium.to_base64(new Uint8Array([1, 2, 3]), sodium.base64_variants.ORIGINAL)
    expect(evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "friend", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub, rotationProof: short })).toEqual({ decision: "rejected", reason: "bad_rotation_proof" })
  })

  it("acquaintance + even a VALID proof → rejected:rotation_requires_reconfirm", async () => {
    const { sodium, id, pinStore, next } = await pinnedFixture()
    const rotationProof = signSuccessor({ sodium, oldEd25519Priv: id.ed25519Priv, newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub })
    expect(evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "acquaintance", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub, rotationProof })).toEqual({ decision: "rejected", reason: "rotation_requires_reconfirm" })
    // NOT re-pinned.
    expect(getPinned(pinStore, id.did)!.ed25519Pub).toEqual(id.ed25519Pub)
  })

  it("stranger + any → rejected:rotation_requires_reconfirm", async () => {
    const { sodium, id, pinStore, next } = await pinnedFixture()
    expect(evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "stranger", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub }).decision).toBe("rejected")
    expect(evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "stranger", newDid: next.id.did, newEd25519Pub: next.id.ed25519Pub }).decision).toBe("rejected")
  })

  it("a SAME-did but DIFFERENT-key presentation is a rotation (not unchanged)", async () => {
    const { sodium, id, pinStore } = await pinnedFixture()
    const otherKey = sodium.crypto_sign_keypair()
    // Same DID string, different key bytes → bytesEqual false → goes through rotation.
    const d = evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "friend", newDid: id.did, newEd25519Pub: otherKey.publicKey })
    expect(d).toEqual({ decision: "rejected", reason: "bad_rotation_proof" })
  })

  it("a SAME-did but WRONG-LENGTH key is a rotation (bytesEqual length-mismatch branch)", async () => {
    const { sodium, id, pinStore } = await pinnedFixture()
    // A truncated key for the same DID → bytesEqual returns false on the length
    // check (not the byte loop) → treated as a rotation, missing proof → rejected.
    const d = evaluateRotation({ sodium, pinStore, fromAgentId: id.did, trustOfSource: "friend", newDid: id.did, newEd25519Pub: new Uint8Array([1, 2, 3]) })
    expect(d).toEqual({ decision: "rejected", reason: "bad_rotation_proof" })
  })
})
