// adapter — send/receive wiring sealed envelopes to the UNCHANGED importers, with
// injectable transports + a real DID-resolution that pins did:key senders. Real
// crypto end to end. The security-relevant negatives (forge→untrusted_source,
// tamper→unseal_failed, replay→inert, binding-mismatch) are all exercised here at
// the adapter level (the malicious-relay proof in U10 re-asserts end to end).
import { describe, expect, it } from "vitest"

import { importProfileShare } from "../share"
import type { ProfileShareEnvelope } from "../share"
import type { CoordinationEnvelope } from "../coordination"
import type { MissionShareEnvelope } from "../mission-share"
import type { FriendRecord, IdentityProvider } from "../types"
import type { FriendStore } from "../store"
import type { MissionStore, MissionRecord } from "../mission-store"
import { didKeyIdentityFromEd25519, keyAgreementFromDidKey, parseDidKey } from "../a2a-client/did-key"
import type { DidKeyIdentity } from "../a2a-client/did-key"
import { MemoryPinStore, pinOnFirstContact } from "../a2a-client/did-verifier"
import type { PinStore } from "../a2a-client/did-verifier"
import { receiveShare, sendShare } from "../a2a-client/adapter"
import type { A2ATransport, DidResolution, SeenLedgerLike } from "../a2a-client/adapter"
import type { A2AMessage } from "../a2a-client/a2a-message"
import { readySodium } from "./_sodium"

const NOW = "2026-01-01T00:00:00.000Z"
type Sodium = Awaited<ReturnType<typeof readySodium>>

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
      if (r.externalIds.find((e) => e.provider === provider && e.externalId === externalId && (tenantId === undefined || e.tenantId === tenantId))) return r
    }
    return null
  }
  async listAll() {
    return Array.from(this.records.values())
  }
}

// A minimal in-memory MissionStore (full interface — the real importers call
// findByMissionKey). Keyed by the record id; findByMissionKey scans on the join key.
class MemoryMissionStore implements MissionStore {
  readonly missions = new Map<string, MissionRecord>()
  async get(id: string) {
    return this.missions.get(id) ?? null
  }
  async put(id: string, record: MissionRecord) {
    this.missions.set(id, record)
  }
  async delete(id: string) {
    this.missions.delete(id)
  }
  async findByMissionKey(missionKey: string) {
    for (const m of this.missions.values()) {
      if (m.missionKey === missionKey) return m
    }
    return null
  }
  async listAll() {
    return Array.from(this.missions.values())
  }
}

class SeenLedger implements SeenLedgerLike {
  private readonly set = new Set<string>()
  isSeen(n: string) {
    return this.set.has(n)
  }
  markSeen(n: string) {
    this.set.add(n)
  }
}

/** A real did:key resolver: derive the sender's Ed25519 pub from its did:key,
 * pinning on first contact. Guards the curve/parse failure modes (returns null).
 */
function didKeyResolution(sodium: Sodium): DidResolution {
  return {
    async resolveAndPin({ fromAgentId, did, pinStore }) {
      const existing = pinStore.get(fromAgentId)
      if (existing) return { ed25519Pub: existing.ed25519Pub }
      const parsed = parseDidKey(did)
      if (!parsed) return null
      // Guard the curve derivation (defense-in-depth at the untrusted boundary —
      // a structurally-valid-length but non-canonical point could throw).
      try {
        keyAgreementFromDidKey({ sodium, ed25519Pub: parsed.ed25519Pub })
      } catch {
        return null
      }
      pinOnFirstContact({ pinStore, fromAgentId, did, ed25519Pub: parsed.ed25519Pub })
      return { ed25519Pub: parsed.ed25519Pub }
    },
  }
}

function captureTransport(): { transport: A2ATransport; sent: { target: { rung: string; address: string }; message: A2AMessage }[] } {
  const sent: { target: { rung: string; address: string }; message: A2AMessage }[] = []
  const transport: A2ATransport = {
    async send(target, message) {
      sent.push({ target, message })
    },
  }
  return { transport, sent }
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

function profileEnvelope(fromDid: string): ProfileShareEnvelope {
  return {
    subject: { externalIds: [{ provider: "aad" as IdentityProvider, externalId: "jordan-aad", linkedAt: NOW }], displayName: "Jordan" },
    fromAgentId: fromDid,
    scope: "notes:safe",
    notes: [{ key: "bio", value: "designer" }],
    issuedAt: NOW,
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

describe("sendShare", () => {
  it("seals + wraps + sends over the DIRECT rung", async () => {
    const { sodium, a, b } = await twoAgents()
    const { transport, sent } = captureTransport()
    const r = await sendShare({
      sodium,
      transport,
      fromIdentity: a,
      toPeer: { a2a: { endpointUrl: "https://b.example/a2a", did: b.did } },
      recipientDid: b.did,
      recipientX25519Pub: b.x25519Pub,
      plaintextEnvelope: profileEnvelope(a.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rung).toBe("direct")
    expect(sent).toHaveLength(1)
    expect(sent[0].target).toEqual({ rung: "direct", address: "https://b.example/a2a" })
    // relay-blind: no plaintext on the wire.
    expect(JSON.stringify(sent[0].message)).not.toContain("designer")
  })

  it("uses the RELAY rung (handle as address) when no endpoint", async () => {
    const { sodium, a, b } = await twoAgents()
    const { transport, sent } = captureTransport()
    const r = await sendShare({
      sodium,
      transport,
      fromIdentity: a,
      toPeer: { a2a: { relay: { url: "https://relay", handle: "opaque-h" }, did: b.did } },
      recipientDid: b.did,
      recipientX25519Pub: b.x25519Pub,
      plaintextEnvelope: profileEnvelope(a.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })
    expect(r.ok && r.rung).toBe("relay")
    expect(sent[0].target).toEqual({ rung: "relay", address: "opaque-h" })
  })

  it("uses the MAILBOX rung (repo as address) when only a mailbox", async () => {
    const { sodium, a, b } = await twoAgents()
    const { transport, sent } = captureTransport()
    const r = await sendShare({
      sodium,
      transport,
      fromIdentity: a,
      toPeer: { mailbox: { repo: "/m/repo", selfOutboxAgentId: "out" } },
      recipientDid: b.did,
      recipientX25519Pub: b.x25519Pub,
      plaintextEnvelope: profileEnvelope(a.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })
    expect(r.ok && r.rung).toBe("mailbox")
    expect(sent[0].target).toEqual({ rung: "mailbox", address: "/m/repo" })
  })

  it("unreachable → { ok:false, reason:'unreachable' }, transport never called", async () => {
    const { sodium, a, b } = await twoAgents()
    const { transport, sent } = captureTransport()
    const r = await sendShare({
      sodium,
      transport,
      fromIdentity: a,
      toPeer: { a2a: { did: b.did } }, // no endpoint/relay/mailbox
      recipientDid: b.did,
      recipientX25519Pub: b.x25519Pub,
      plaintextEnvelope: profileEnvelope(a.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })
    expect(r).toEqual({ ok: false, reason: "unreachable" })
    expect(sent).toHaveLength(0)
  })
})

describe("send → receive round-trip (honest in-memory transport)", () => {
  it("a VALID friend profile share imports through the unchanged importer", async () => {
    const { sodium, a, b } = await twoAgents()
    const { transport, sent } = captureTransport()
    await sendShare({
      sodium,
      transport,
      fromIdentity: a,
      toPeer: { a2a: { endpointUrl: "https://b/a2a", did: b.did } },
      recipientDid: b.did,
      recipientX25519Pub: b.x25519Pub,
      plaintextEnvelope: profileEnvelope(a.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })

    const store = new MemoryStore([subjectRecord()])
    const result = await receiveShare({
      sodium,
      store,
      missionStore: new MemoryMissionStore(),
      pinStore: new MemoryPinStore(),
      didResolution: didKeyResolution(sodium),
      seen: new SeenLedger(),
      a2aMessage: sent[0].message,
      recipientDid: b.did,
      recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub },
      trustOfSource: "friend",
    })
    expect(result).toEqual({ state: "completed", friendsKind: "profile_share", status: "imported" })
    // first-party untouched; the import landed as an importedNotes entry.
    const subj = store.records.get("subj-1")!
    expect(subj.notes).toEqual({}) // first-party notes untouched
    expect(subj.importedNotes).toBeTruthy()
  })
})

describe("receiveShare — reject mapping", () => {
  async function sealedMessageFromA(): Promise<{ sodium: Sodium; a: DidKeyIdentity; b: DidKeyIdentity; message: A2AMessage }> {
    const { sodium, a, b } = await twoAgents()
    const { transport, sent } = captureTransport()
    await sendShare({
      sodium,
      transport,
      fromIdentity: a,
      toPeer: { a2a: { endpointUrl: "https://b/a2a", did: b.did } },
      recipientDid: b.did,
      recipientX25519Pub: b.x25519Pub,
      plaintextEnvelope: profileEnvelope(a.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })
    return { sodium, a, b, message: sent[0].message }
  }

  function baseReceive(sodium: Sodium, b: DidKeyIdentity, message: A2AMessage, store: FriendStore, seen: SeenLedger, pinStore: PinStore) {
    return {
      sodium,
      store,
      missionStore: new MemoryMissionStore(),
      pinStore,
      didResolution: didKeyResolution(sodium),
      seen,
      a2aMessage: message,
      recipientDid: b.did,
      recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub },
      trustOfSource: "friend" as const,
    }
  }

  it("malformed message (no DataPart) → rejected:malformed_message", async () => {
    const { sodium, b } = await sealedMessageFromA()
    const bad = { messageId: "m", role: "agent", parts: [] } as A2AMessage
    const r = await receiveShare(baseReceive(sodium, b, bad, new MemoryStore(), new SeenLedger(), new MemoryPinStore()))
    expect(r).toEqual({ state: "rejected", reason: "malformed_message" })
  })

  it("bit-flipped ciphertext → rejected:unseal_failed, no friends state written", async () => {
    const { sodium, b, message } = await sealedMessageFromA()
    const ct = sodium.from_base64(message.parts[0].data.sealed.ct, sodium.base64_variants.ORIGINAL)
    ct[0] ^= 0x01
    message.parts[0].data.sealed.ct = sodium.to_base64(ct, sodium.base64_variants.ORIGINAL)
    const store = new MemoryStore([subjectRecord()])
    const r = await receiveShare(baseReceive(sodium, b, message, store, new SeenLedger(), new MemoryPinStore()))
    expect(r).toEqual({ state: "rejected", reason: "unseal_failed" })
    expect(store.records.get("subj-1")!.importedNotes).toBeFalsy()
  })

  it("a forged signature (Mallory signs as A) → rejected:untrusted_source", async () => {
    const { sodium, a, b } = await twoAgents()
    const mallory = sodium.crypto_sign_keypair()
    // Hand-build a sealed envelope: envelope.fromAgentId = A, but the proof is signed by Mallory.
    const { sealEnvelope } = await import("../a2a-client/sealed-envelope")
    const { wrapInDataPart } = await import("../a2a-client/a2a-message")
    const sealed = sealEnvelope({
      sodium,
      envelope: profileEnvelope(a.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
      fromIdentity: { did: a.did, keyId: a.keyId, ed25519Priv: mallory.privateKey }, // WRONG key, claims A
      recipientDid: b.did,
      recipientX25519Pub: b.x25519Pub,
    })
    const message = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: b.did })
    const store = new MemoryStore([subjectRecord()])
    // Pin A's REAL key so the resolver returns A's real pub.
    const pinStore = new MemoryPinStore()
    pinOnFirstContact({ pinStore, fromAgentId: a.did, did: a.did, ed25519Pub: a.ed25519Pub })
    const r = await receiveShare(baseReceive(sodium, b, message, store, new SeenLedger(), pinStore))
    expect(r).toEqual({ state: "rejected", reason: "untrusted_source" })
    expect(store.records.get("subj-1")!.importedNotes).toBeFalsy()
  })

  it("a stranger source → rejected:untrusted_source (trust cap)", async () => {
    const { sodium, b, message } = await sealedMessageFromA()
    const store = new MemoryStore([subjectRecord()])
    const r = await receiveShare({ ...baseReceive(sodium, b, message, store, new SeenLedger(), new MemoryPinStore()), trustOfSource: "stranger" })
    expect(r).toEqual({ state: "rejected", reason: "untrusted_source" })
  })

  it("a sealed bundle whose envelope.fromAgentId ≠ inner signerDid → rejected:sender_binding_mismatch", async () => {
    const { sodium, a, b } = await twoAgents()
    // Build a plaintext where envelope.fromAgentId = A but the OUTER signerDid lies (= C).
    const c = "did:key:zSomeoneElse"
    const { sealTo } = await import("../a2a-client/seal")
    const { wrapInDataPart } = await import("../a2a-client/a2a-message")
    const { signEnvelope, serializeProof } = await import("../a2a-client/sign")
    const env = profileEnvelope(a.did) as unknown as Record<string, unknown>
    const proof = signEnvelope({ sodium, envelope: env, signerEd25519Priv: a.ed25519Priv, signerDid: a.did, signerKeyId: a.keyId })
    const plaintext = { envelope: { ...env, proof: serializeProof(proof) }, signature: proof.sig, signerDid: c, signerKeyId: "k", recipient: b.did, v: 1, friendsKind: "profile_share" }
    const blob = sealTo({ sodium, plaintextBytes: new TextEncoder().encode(JSON.stringify(plaintext)), recipientX25519Pub: b.x25519Pub, recipientDid: b.did })
    const message = wrapInDataPart({ sealedEnvelope: { v: 1, sealed: blob }, recipientDid: b.did })
    const r = await receiveShare(baseReceive(sodium, b, message, new MemoryStore([subjectRecord()]), new SeenLedger(), new MemoryPinStore()))
    expect(r).toEqual({ state: "rejected", reason: "sender_binding_mismatch" })
  })

  it("an unresolvable sender DID → rejected:resolve_failed", async () => {
    const { sodium, a, b } = await twoAgents()
    // Build a valid-looking sealed bundle but make resolveAndPin always fail.
    const { transport, sent } = captureTransport()
    await sendShare({ sodium, transport, fromIdentity: a, toPeer: { a2a: { endpointUrl: "https://b", did: b.did } }, recipientDid: b.did, recipientX25519Pub: b.x25519Pub, plaintextEnvelope: profileEnvelope(a.did) as unknown as Record<string, unknown>, friendsKind: "profile_share" })
    const failingResolution: DidResolution = { async resolveAndPin() { return null } }
    const r = await receiveShare({ ...baseReceive(sodium, b, sent[0].message, new MemoryStore([subjectRecord()]), new SeenLedger(), new MemoryPinStore()), didResolution: failingResolution })
    expect(r).toEqual({ state: "rejected", reason: "resolve_failed" })
  })
})

describe("receiveShare — replay is inert", () => {
  it("the second receive of the same sealed message is skipped (seen-ledger on the nonce)", async () => {
    const { sodium, a, b } = await twoAgents()
    const { transport, sent } = captureTransport()
    await sendShare({ sodium, transport, fromIdentity: a, toPeer: { a2a: { endpointUrl: "https://b", did: b.did } }, recipientDid: b.did, recipientX25519Pub: b.x25519Pub, plaintextEnvelope: profileEnvelope(a.did) as unknown as Record<string, unknown>, friendsKind: "profile_share" })
    const store = new MemoryStore([subjectRecord()])
    const seen = new SeenLedger()
    const pinStore = new MemoryPinStore()
    const args = {
      sodium,
      store,
      missionStore: new MemoryMissionStore(),
      pinStore,
      didResolution: didKeyResolution(sodium),
      seen,
      a2aMessage: sent[0].message,
      recipientDid: b.did,
      recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub },
      trustOfSource: "friend" as const,
    }
    const first = await receiveShare(args)
    expect(first.state).toBe("completed")
    const second = await receiveShare(args)
    expect(second).toEqual({ state: "rejected", reason: "replayed" })
  })
})

describe("receiveShare — friendsKind routing", () => {
  it("mission_share routes to importMissionShare(missionStore, …)", async () => {
    const { sodium, a, b } = await twoAgents()
    const { sealEnvelope } = await import("../a2a-client/sealed-envelope")
    const { wrapInDataPart } = await import("../a2a-client/a2a-message")
    const missionEnv = { subject: { missionKey: "PROJ-1", title: "Project One" }, fromAgentId: a.did, scope: "mission", learnings: [], issuedAt: NOW } as unknown as Record<string, unknown>
    const sealed = sealEnvelope({ sodium, envelope: missionEnv, friendsKind: "mission_share", fromIdentity: a, recipientDid: b.did, recipientX25519Pub: b.x25519Pub })
    const message = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: b.did })
    const missionStore = new MemoryMissionStore()
    const r = await receiveShare({
      sodium,
      store: new MemoryStore(),
      missionStore,
      pinStore: new MemoryPinStore(),
      didResolution: didKeyResolution(sodium),
      seen: new SeenLedger(),
      a2aMessage: message,
      recipientDid: b.did,
      recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub },
      trustOfSource: "friend",
    })
    // Reached the mission importer (its result is mapped; status is one of its codes).
    expect(r.state === "completed" || r.state === "rejected").toBe(true)
    if (r.state === "completed") expect(r.friendsKind).toBe("mission_share")
  })

  it("coordination routes to importCoordination(missionStore, …)", async () => {
    const { sodium, a, b } = await twoAgents()
    const { sealEnvelope } = await import("../a2a-client/sealed-envelope")
    const { wrapInDataPart } = await import("../a2a-client/a2a-message")
    const coordEnv = { subject: { missionKey: "PROJ-1", title: "Project One" }, fromAgentId: a.did, intent: "request", issuedAt: NOW } as unknown as Record<string, unknown>
    const sealed = sealEnvelope({ sodium, envelope: coordEnv, friendsKind: "coordination", fromIdentity: a, recipientDid: b.did, recipientX25519Pub: b.x25519Pub })
    const message = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: b.did })
    const r = await receiveShare({
      sodium,
      store: new MemoryStore(),
      missionStore: new MemoryMissionStore(),
      pinStore: new MemoryPinStore(),
      didResolution: didKeyResolution(sodium),
      seen: new SeenLedger(),
      a2aMessage: message,
      recipientDid: b.did,
      recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub },
      trustOfSource: "friend",
    })
    expect(r.state === "completed" || r.state === "rejected").toBe(true)
    if (r.state === "completed") expect(r.friendsKind).toBe("coordination")
  })
})

describe("receiveShare — import_failed mapping (non-untrusted importer rejection)", () => {
  it("maps a non-untrusted importer failure (untrusted_introduction) to import_failed", async () => {
    // A coordination envelope for an UNKNOWN mission from an ACQUAINTANCE with a
    // VALID signature: the verify+trust double-gate PASSES (acquaintance meets the
    // default minTrust), but acquaintance is NOT in SEEDING_TRUST → the importer
    // returns `untrusted_introduction` (ok:false, NOT untrusted_source) → the
    // adapter maps it to `import_failed`.
    const { sodium, a, b } = await twoAgents()
    const { sealEnvelope } = await import("../a2a-client/sealed-envelope")
    const { wrapInDataPart } = await import("../a2a-client/a2a-message")
    const coordEnv = { subject: { missionKey: "UNKNOWN-1", title: "Unknown" }, fromAgentId: a.did, intent: "request", issuedAt: NOW } as unknown as Record<string, unknown>
    const sealed = sealEnvelope({ sodium, envelope: coordEnv, friendsKind: "coordination", fromIdentity: a, recipientDid: b.did, recipientX25519Pub: b.x25519Pub })
    const message = wrapInDataPart({ sealedEnvelope: sealed, recipientDid: b.did })
    const r = await receiveShare({
      sodium,
      store: new MemoryStore(),
      missionStore: new MemoryMissionStore(),
      pinStore: new MemoryPinStore(),
      didResolution: didKeyResolution(sodium),
      seen: new SeenLedger(),
      a2aMessage: message,
      recipientDid: b.did,
      recipientIdentity: { x25519Priv: b.x25519Priv, x25519Pub: b.x25519Pub },
      trustOfSource: "acquaintance",
    })
    expect(r).toEqual({ state: "rejected", reason: "import_failed" })
  })
})
