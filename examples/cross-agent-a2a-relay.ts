// The malicious-relay proof — friends' E2E sign-then-seal overlay survives a
// HOSTILE relay. THIS PROOF IS THE SECURITY CLAIM (spec §3.9).
//
// A friends exchange rides REAL A2A (`message/send` → one DataPart) but every
// envelope is SIGNED by the sender (Ed25519) and SEALED to the recipient
// (XChaCha20-Poly1305 AEAD over ephemeral X25519 ECDH, recipient DID bound into the
// AEAD AD). A relay between two agents is therefore UNTRUSTED INFRASTRUCTURE: it
// carries ciphertext + a routing handle and nothing else. This script stands up a
// deliberately-MALICIOUS in-process relay and proves — with hard asserts — that it
// can never read, forge, tamper, re-target, replay-to-effect, or escalate.
//
// NO real infra: an in-process relay stub + did:key identities (the agent's DID is
// its Ed25519 key; the X25519 keyAgreement is derived from the same key, so no
// fixture did.json is needed). did:web is exercised in the unit tests via an
// injected resolver — not required here.
//
// Two agents A and B exchange a sealed+signed profile share; a third identity C is
// used for the re-target attack. Every invariant is a HARD assert — any violation
// throws → red banner, exit 1. If ANY assertion reveals a genuine weakness (the
// relay can read / forge / re-target / replay-to-effect, or a forged/replayed
// message moves protected state), that is a REAL SECURITY HOLE — the proof MUST
// fail loudly, never paper it over.
//
// Run it:  npm run example:cross-agent-a2a-relay
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileFriendStore, FileMissionStore, missionsDirFor } from "../src/index"
import type { FriendRecord, IdentityProvider, TrustLevel } from "../src/index"
import {
  DidVerifier,
  didKeyIdentityFromEd25519,
  keyAgreementFromDidKey,
  MemoryPinStore,
  openSealedEnvelope,
  parseDidKey,
  pinOnFirstContact,
  ready,
  receiveShare,
  resolveReachability,
  sealEnvelope,
  sendShare,
  unwrapDataPart,
  wrapInDataPart,
} from "../src/a2a-client"
import type {
  A2AMessage,
  A2ATransport,
  DidKeyIdentity,
  DidResolution,
  SealedEnvelope,
  Sodium,
} from "../src/a2a-client"

let stepNum = 0
function step(title: string): void {
  stepNum += 1
  console.log(`\n━━ STEP ${stepNum}: ${title}`)
}
function ok(msg: string): void {
  console.log(`   ✓ ${msg}`)
}

const NOW = "2026-01-01T00:00:00.000Z"

// Recognizable values we will hunt for in the relay's forwarded bytes.
const SUBJECT_JOIN_KEY = "teams:proof-subject-xyz"
const SECRET_NOTE = "super-secret-note-do-not-leak"

// ── The deliberately-MALICIOUS relay ──────────────────────────────────────────
// It implements the host's A2ATransport (direct + relay are both "send an A2A
// message"). It RECORDS every byte it forwards and exposes attack methods.
class MaliciousRelay implements A2ATransport {
  /** Every message it was asked to forward, serialized (the relay's full view). */
  readonly forwarded: string[] = []
  /** The last message it forwarded (the attacker's working copy). */
  last: A2AMessage | null = null

  async send(_target: { rung: string; address: string }, message: A2AMessage): Promise<void> {
    this.forwarded.push(JSON.stringify(message))
    this.last = JSON.parse(JSON.stringify(message)) as A2AMessage
  }

  /** Attempt to fabricate a SealedEnvelope "from" A without A's Ed25519 key. The
   * relay can only produce a structurally-valid DataPart; it cannot sign as A. */
  forge(sodium: Sodium, attackerSigningPriv: Uint8Array, claimAs: DidKeyIdentity, recipient: DidKeyIdentity): A2AMessage {
    const envelope = profileEnvelope(claimAs.did)
    // The relay signs with ITS OWN key but stamps A's DID in the proof + plaintext.
    const sealed = sealEnvelope({
      sodium,
      envelope: envelope as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
      fromIdentity: { did: claimAs.did, keyId: claimAs.keyId, ed25519Priv: attackerSigningPriv },
      recipientDid: recipient.did,
      recipientX25519Pub: recipient.x25519Pub,
    })
    return wrapInDataPart({ sealedEnvelope: sealed, recipientDid: recipient.did })
  }

  /** Bit-flip a forwarded ciphertext byte. */
  tamperCipher(sodium: Sodium): A2AMessage {
    const msg = JSON.parse(JSON.stringify(this.last)) as A2AMessage
    const ct = sodium.from_base64(msg.parts[0].data.sealed.ct, sodium.base64_variants.ORIGINAL)
    ct[0] ^= 0x01
    msg.parts[0].data.sealed.ct = sodium.to_base64(ct, sodium.base64_variants.ORIGINAL)
    return msg
  }

  /** Redirect a forwarded blob to a different recipient C (re-target). */
  retarget(toC: DidKeyIdentity): A2AMessage {
    const msg = JSON.parse(JSON.stringify(this.last)) as A2AMessage
    // The relay rewrites the routing handle to C and tries to deliver B's blob to C.
    msg.parts[0].data.recipientDid = toC.did
    return msg
  }

  /** Re-forward a previously-delivered blob (replay). */
  replay(): A2AMessage {
    return JSON.parse(JSON.stringify(this.last)) as A2AMessage
  }
}

function profileEnvelope(fromDid: string) {
  return {
    subject: { externalIds: [{ provider: "teams" as IdentityProvider, externalId: SUBJECT_JOIN_KEY, linkedAt: NOW }], displayName: "Jordan" },
    fromAgentId: fromDid,
    scope: "notes:safe" as const,
    notes: [{ key: "bio", value: SECRET_NOTE }],
    issuedAt: NOW,
  }
}

/** A real did:key resolver: derive the sender's Ed25519 pub from its did:key,
 * pin on first contact. Guards the parse/curve failure modes. */
function didKeyResolution(sodium: Sodium): DidResolution {
  return {
    async resolveAndPin({ fromAgentId, did, pinStore }) {
      const existing = pinStore.get(fromAgentId)
      if (existing) return { ed25519Pub: existing.ed25519Pub }
      const parsed = parseDidKey(did)
      if (!parsed) return null
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

class SeenLedger {
  private readonly set = new Set<string>()
  isSeen(n: string): boolean {
    return this.set.has(n)
  }
  markSeen(n: string): void {
    this.set.add(n)
  }
}

// A subject record B already holds, with FIRST-PARTY notes the import must NOT touch.
function subjectInB(): FriendRecord {
  return {
    id: "subj-P",
    name: "Jordan",
    role: "friend",
    trustLevel: "acquaintance",
    connections: [],
    externalIds: [{ provider: "teams" as IdentityProvider, externalId: SUBJECT_JOIN_KEY, linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: { role: { value: "B's own first-party guess", savedAt: NOW, provenance: { origin: "first_party" } } },
    learnings: {},
    status: { state: "active", note: "B-first-party-status", updatedAt: NOW },
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  } as FriendRecord
}

async function main(): Promise<void> {
  const sodium = await ready()

  const dirB = mkdtempSync(join(tmpdir(), "friends-relay-B-"))
  try {
    // ── Identities: A (sender), B (recipient), C (re-target victim) ──
    const aKp = sodium.crypto_sign_keypair()
    const bKp = sodium.crypto_sign_keypair()
    const cKp = sodium.crypto_sign_keypair()
    const A = didKeyIdentityFromEd25519({ sodium, ed25519Pub: aKp.publicKey, ed25519Priv: aKp.privateKey })
    const B = didKeyIdentityFromEd25519({ sodium, ed25519Pub: bKp.publicKey, ed25519Priv: bKp.privateKey })
    const C = didKeyIdentityFromEd25519({ sodium, ed25519Pub: cKp.publicKey, ed25519Priv: cKp.privateKey })

    const storeB = new FileFriendStore(join(dirB, "friends"))
    const missionsB = new FileMissionStore(missionsDirFor(dirB))
    await storeB.put("subj-P", subjectInB())

    const relay = new MaliciousRelay()

    // A sends a sealed+signed profile share to B THROUGH the malicious relay (B has
    // no direct endpoint — only a relay handle).
    step("A sends a sealed+signed profile share to B through the malicious relay")
    const sendResult = await sendShare({
      sodium,
      transport: relay,
      fromIdentity: A,
      toPeer: { a2a: { relay: { url: "https://malicious.relay", handle: "B-opaque-handle" }, did: B.did } },
      recipientDid: B.did,
      recipientX25519Pub: B.x25519Pub,
      plaintextEnvelope: profileEnvelope(A.did) as unknown as Record<string, unknown>,
      friendsKind: "profile_share",
    })
    assert.equal(sendResult.ok, true, "the send must succeed over the relay rung")
    assert.equal(sendResult.ok && sendResult.rung, "relay", "B must be reached via the relay rung")
    ok("A → relay → (B): one A2A message forwarded, addressed by an opaque handle")

    const receiveArgs = () => ({
      sodium,
      store: storeB,
      missionStore: missionsB,
      pinStore: new MemoryPinStore(),
      didResolution: didKeyResolution(sodium),
      seen: new SeenLedger(),
      recipientDid: B.did,
      recipientIdentity: { x25519Priv: B.x25519Priv, x25519Pub: B.x25519Pub },
      trustOfSource: "friend" as TrustLevel,
    })

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 1 — the relay sees ONLY ciphertext.
    // ════════════════════════════════════════════════════════════════════════
    step("ASSERTION 1 — the relay sees ONLY ciphertext (content-blindness)")
    assert.ok(relay.forwarded.length > 0, "the relay must have forwarded at least one message")
    for (const bytes of relay.forwarded) {
      assert.equal(bytes.includes(SUBJECT_JOIN_KEY), false, "the subject join-key must NOT appear in relay bytes")
      assert.equal(bytes.includes(SECRET_NOTE), false, "the note value must NOT appear in relay bytes")
      assert.equal(bytes.includes("profile_share"), false, "the friendsKind must NOT appear in relay bytes")
      assert.equal(bytes.includes(A.did), false, "the sender DID must NOT appear in relay bytes")
      // Only the opaque blob + routing handle.
      const msg = JSON.parse(bytes) as A2AMessage
      const data = msg.parts[0].data
      assert.deepEqual(Object.keys(data).sort(), ["recipientDid", "sealed", "v"], "the DataPart carries ONLY { recipientDid, sealed, v }")
      assert.deepEqual(Object.keys(data.sealed).sort(), ["ct", "ePk", "n", "v"], "the sealed blob carries ONLY { ct, ePk, n, v }")
    }
    ok("relay bytes carry no join-key / note / friendsKind / sender DID — only the opaque sealed blob + recipient handle")

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 2 — the relay CAN'T forge.
    // ════════════════════════════════════════════════════════════════════════
    step("ASSERTION 2 — the relay CAN'T forge a share 'from' A (no A Ed25519 key)")
    const relayKp = sodium.crypto_sign_keypair() // the relay's own key
    const forged = relay.forge(sodium, relayKp.privateKey, A, B)
    const beforeForge = await storeB.get("subj-P")
    const forgeResult = await receiveShare({ ...receiveArgs(), a2aMessage: forged })
    assert.equal(forgeResult.state, "rejected", "a forged share must be REJECTED")
    if (forgeResult.state === "rejected") {
      assert.equal(forgeResult.reason, "untrusted_source", "the forge must map to untrusted_source (DidVerifier.verify false)")
    }
    const afterForge = await storeB.get("subj-P")
    assert.deepEqual(afterForge, beforeForge, "ZERO friends state may change on a forged share")
    ok("forged share rejected (untrusted_source); B's record byte-identical — the relay cannot sign as A")

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 3 — the relay CAN'T tamper.
    // ════════════════════════════════════════════════════════════════════════
    step("ASSERTION 3 — the relay CAN'T tamper (AEAD + sealed signature)")
    const beforeTamper = await storeB.get("subj-P")
    const tampered = relay.tamperCipher(sodium)
    const tamperResult = await receiveShare({ ...receiveArgs(), a2aMessage: tampered })
    assert.equal(tamperResult.state, "rejected", "a tampered ciphertext must be REJECTED")
    if (tamperResult.state === "rejected") {
      assert.equal(tamperResult.reason, "unseal_failed", "a bit-flipped ct must fail at the AEAD (unseal_failed)")
    }
    // A signed-field tamper is impossible: the signature is INSIDE the seal, so any
    // mutation that survives to B fails either the AEAD tag or the signature.
    const afterTamper = await storeB.get("subj-P")
    assert.deepEqual(afterTamper, beforeTamper, "B's first-party notes/status/trustLevel must be byte-UNTOUCHED")
    assert.equal(afterTamper!.notes.role.value, "B's own first-party guess", "B's first-party note is intact")
    assert.equal(afterTamper!.trustLevel, "acquaintance", "B's trustLevel is intact")
    ok("tampered ciphertext rejected (unseal_failed); a signed-field tamper is impossible (sig is sealed); first-party untouched")

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 4 — the relay CAN'T re-target.
    // ════════════════════════════════════════════════════════════════════════
    step("ASSERTION 4 — the relay CAN'T re-target B's blob to C (AEAD AD mismatch)")
    const retargeted = relay.retarget(C)
    // C tries to open B's blob; C reconstructs ITS OWN DID as the AEAD AD → tag fails.
    const cOpen = openSealedEnvelope({
      sodium,
      sealedEnvelope: { v: retargeted.parts[0].data.v, sealed: retargeted.parts[0].data.sealed },
      recipientDid: C.did,
      recipientIdentity: { x25519Priv: C.x25519Priv, x25519Pub: C.x25519Pub },
    })
    assert.equal(cOpen.ok, false, "C must NOT be able to open a blob sealed to B")
    if (!cOpen.ok) {
      assert.equal(cOpen.error, "unseal_failed", "the re-target must fail at the AEAD tag (unseal_failed), not a post-unseal check")
    }
    // And through the full receive path with C as the recipient: still rejected.
    const cStoreDir = mkdtempSync(join(tmpdir(), "friends-relay-C-"))
    try {
      const storeC = new FileFriendStore(join(cStoreDir, "friends"))
      const missionsC = new FileMissionStore(missionsDirFor(cStoreDir))
      const cReceive = await receiveShare({
        sodium,
        store: storeC,
        missionStore: missionsC,
        pinStore: new MemoryPinStore(),
        didResolution: didKeyResolution(sodium),
        seen: new SeenLedger(),
        a2aMessage: retargeted,
        recipientDid: C.did,
        recipientIdentity: { x25519Priv: C.x25519Priv, x25519Pub: C.x25519Pub },
        trustOfSource: "friend",
      })
      assert.equal(cReceive.state, "rejected", "C's full receive of a re-targeted blob must be rejected")
    } finally {
      rmSync(cStoreDir, { recursive: true, force: true })
    }
    ok("re-target to C fails at the AEAD tag (the recipient DID is bound into the AD) — the relay cannot redirect a sealed blob")

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 6 — moat invariants hold E2E (do this BEFORE replay so there's a
    // real delivery to replay). A VALID friend share imports as an attributed,
    // quarantined importedNotes entry; first-party + trust UNTOUCHED.
    // ════════════════════════════════════════════════════════════════════════
    step("ASSERTION 6 — a VALID friend share imports as attributed/quarantined; first-party + trust untouched")
    const seenShared = new SeenLedger()
    const honestReceive = await receiveShare({ ...receiveArgs(), seen: seenShared, a2aMessage: relay.replay() })
    assert.equal(honestReceive.state, "completed", "a valid friend share must import (completed)")
    if (honestReceive.state === "completed") {
      assert.equal(honestReceive.status, "imported", "the import status is `imported`")
    }
    const afterImport = await storeB.get("subj-P")
    // First-party note UNTOUCHED (non-transitive — the import never clobbers first-party).
    assert.equal(afterImport!.notes.role.value, "B's own first-party guess", "first-party `role` note must be UNTOUCHED")
    assert.equal(afterImport!.trustLevel, "acquaintance", "trustLevel must be UNCHANGED (non-transitive)")
    // The imported fact landed in the importedNotes NAMESPACE (structurally
    // separate from first-party `notes`), ATTRIBUTED to A (assertedBy + importedAt)
    // — that separation IS the non-laundering / quarantine guarantee.
    const importedForA = afterImport!.importedNotes?.[A.did]
    assert.ok(importedForA, "the import must land under A's agentId in importedNotes")
    assert.equal(importedForA!.bio.value, SECRET_NOTE, "the imported note value is present, quarantined under importedNotes")
    assert.equal(importedForA!.bio.assertedBy?.agentId, A.did, "the imported note records A as the asserter (attributed, can't be re-shared as first-party)")
    assert.ok(importedForA!.bio.importedAt, "the imported note is stamped importedAt")
    // And it did NOT leak into first-party notes (the `bio` key is absent there).
    assert.equal(afterImport!.notes.bio, undefined, "the imported fact must NOT appear in first-party `notes`")
    ok("valid friend share → attributed quarantined importedNotes (assertedBy A, importedAt) in a namespace separate from first-party; trustLevel untouched")

    step("ASSERTION 6b — a STRANGER source writes NOTHING")
    const beforeStranger = await storeB.get("subj-P")
    const strangerReceive = await receiveShare({ ...receiveArgs(), seen: new SeenLedger(), trustOfSource: "stranger", a2aMessage: relay.replay() })
    assert.equal(strangerReceive.state, "rejected", "a stranger source must be rejected")
    if (strangerReceive.state === "rejected") {
      assert.equal(strangerReceive.reason, "untrusted_source", "stranger → untrusted_source (trust cap)")
    }
    assert.deepEqual(await storeB.get("subj-P"), beforeStranger, "NOTHING may be written for a stranger source")
    ok("stranger share rejected (untrusted_source); B's record unchanged")

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 5 — replay is inert (re-forward the delivered blob → skipped).
    // ════════════════════════════════════════════════════════════════════════
    step("ASSERTION 5 — replay is inert (the seen-ledger on the seal nonce skips it)")
    const importedCountBefore = Object.keys((await storeB.get("subj-P"))!.importedNotes?.[A.did] ?? {}).length
    const replayed = relay.replay()
    const replayResult = await receiveShare({ ...receiveArgs(), seen: seenShared, a2aMessage: replayed })
    assert.equal(replayResult.state, "rejected", "a replayed message must be rejected")
    if (replayResult.state === "rejected") {
      assert.equal(replayResult.reason, "replayed", "the replay is skipped via the seen-ledger (reason replayed)")
    }
    const importedCountAfter = Object.keys((await storeB.get("subj-P"))!.importedNotes?.[A.did] ?? {}).length
    assert.equal(importedCountAfter, importedCountBefore, "a replay must import NOTHING new (count unchanged)")
    ok("replayed blob skipped (seen-ledger keyed on the seal nonce); importedNotes count unchanged")

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 7 — direct delivery imports IDENTICALLY (the relay is a pure conduit).
    // ════════════════════════════════════════════════════════════════════════
    step("ASSERTION 7 — direct delivery (no relay) imports IDENTICALLY")
    const dirB2 = mkdtempSync(join(tmpdir(), "friends-relay-B2-"))
    try {
      const storeB2 = new FileFriendStore(join(dirB2, "friends"))
      const missionsB2 = new FileMissionStore(missionsDirFor(dirB2))
      await storeB2.put("subj-P", subjectInB())

      // An HONEST direct transport — captures the message, no tampering.
      const captured: A2AMessage[] = []
      const honestTransport: A2ATransport = { async send(_t, m) { captured.push(m) } }
      await sendShare({
        sodium,
        transport: honestTransport,
        fromIdentity: A,
        toPeer: { a2a: { endpointUrl: "https://b2.example/a2a", did: B.did } },
        recipientDid: B.did,
        recipientX25519Pub: B.x25519Pub,
        plaintextEnvelope: profileEnvelope(A.did) as unknown as Record<string, unknown>,
        friendsKind: "profile_share",
      })
      const directReceive = await receiveShare({
        sodium,
        store: storeB2,
        missionStore: missionsB2,
        pinStore: new MemoryPinStore(),
        didResolution: didKeyResolution(sodium),
        seen: new SeenLedger(),
        a2aMessage: captured[0],
        recipientDid: B.did,
        recipientIdentity: { x25519Priv: B.x25519Priv, x25519Pub: B.x25519Pub },
        trustOfSource: "friend",
      })
      assert.equal(directReceive.state, "completed", "direct delivery must import (completed)")
      const directRecord = await storeB2.get("subj-P")
      // Equivalent resulting state: same imported note under A, same untouched first-party.
      assert.equal(directRecord!.importedNotes?.[A.did]?.bio.value, SECRET_NOTE, "direct import lands the same imported note")
      assert.equal(directRecord!.notes.role.value, "B's own first-party guess", "direct import leaves first-party untouched")
      assert.equal(directRecord!.trustLevel, "acquaintance", "direct import leaves trustLevel unchanged")
    } finally {
      rmSync(dirB2, { recursive: true, force: true })
    }
    ok("the SAME SealedEnvelope delivered DIRECT imports identically — the relay is a pure conduit the security doesn't depend on")

    // ════════════════════════════════════════════════════════════════════════
    // ASSERTION 8 — the reachability ladder (direct → relay → mailbox → unreachable).
    // ════════════════════════════════════════════════════════════════════════
    step("ASSERTION 8 — the reachability ladder: direct → relay → mailbox → unreachable")
    assert.deepEqual(resolveReachability({ endpointUrl: "https://ep", did: B.did }, undefined), { rung: "direct", endpointUrl: "https://ep" }, "endpoint → direct")
    assert.deepEqual(resolveReachability({ relay: { url: "https://r", handle: "h" }, did: B.did }, undefined), { rung: "relay", relay: { url: "https://r", handle: "h" } }, "no endpoint, relay → relay")
    assert.deepEqual(resolveReachability({ did: B.did }, { repo: "/m", selfOutboxAgentId: "o" }), { rung: "mailbox", mailbox: { repo: "/m", selfOutboxAgentId: "o" } }, "no endpoint/relay, mailbox → mailbox")
    assert.deepEqual(resolveReachability({ did: B.did }, undefined), { rung: "unreachable" }, "nothing → unreachable")
    ok("the ladder resolves direct → relay → mailbox → unreachable deterministically")

    // ── A defensive cross-check: the DataPart unwrap + the sealed open are the only
    //    way to read content; the relay never possessed B's X25519 key. ──
    step("Cross-check — only B's keys open the blob; the relay's view is inert")
    const payload = unwrapDataPart(relay.replay())
    assert.ok(payload, "the DataPart unwraps to the routing payload")
    // A bound DidVerifier with the WRONG (relay) key cannot validate B's content.
    const wrongVerifier = new DidVerifier({ sodium, pinnedEd25519Pub: relayKp.publicKey, pinnedDid: A.did, envelope: { fromAgentId: A.did } })
    assert.equal(wrongVerifier.verify(A.did, undefined), false, "a verifier with the relay's key cannot validate A's envelope")
    ok("the relay holds no key that reads or validates content — its view is structurally inert")

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log("✅  MALICIOUS-RELAY PROOF PASSED — friends' E2E sign-then-seal")
    console.log("    overlay keeps the relay UNTRUSTED. All 8 hard assertions hold:")
    console.log("    (1) ciphertext-only  (2) can't-forge  (3) can't-tamper")
    console.log("    (4) can't-re-target  (5) replay-inert (6) moat-invariants")
    console.log("    (7) direct-equivalence  (8) reachability-ladder.")
    console.log("    The relay carries ciphertext + a routing handle and nothing more —")
    console.log("    it can never read, forge, tamper, re-target, replay-to-effect, or")
    console.log("    escalate. Worst residual: deny / delay / observe handle metadata.")
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  } finally {
    rmSync(dirB, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error("\n❌  MALICIOUS-RELAY PROOF FAILED — this is a REAL SECURITY REGRESSION, not a flake.")
  console.error("    If the relay could read / forge / re-target / replay-to-effect, or a forged/replayed")
  console.error("    message moved protected state, that is a genuine security hole — STOP and investigate.")
  console.error(err)
  process.exit(1)
})
