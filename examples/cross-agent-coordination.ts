// Cross-agent coordination / delegation — end-to-end proof (brick 5's capstone).
//
// Brick 3 proved two agents can co-remember a shared MISSION (with consent, without
// clobber). Brick 5 re-aims the same machinery at the one question the mission
// record couldn't answer: WHO is doing this mission. Five verbs — request / offer /
// accept / decline / handoff — negotiate exactly one new bounded field on the
// mission a participant already shares: its `coordination` (an `assignee` + an
// append-only log), carried as `kind:"coordination"` over the brick-2 mailbox (here
// plain file I/O so the proof is hermetic).
//
// ZERO Ouroboros (or any harness) code is in the loop: the MCP side spawns the
// package's own built `dist/mcp/bin.js` three times (A, B, C); the transport side
// calls the pure `../src/a2a` fns. The only thing that crosses between the stores is
// the envelope JSON, exactly as it would cross a network between three real agents.
//
// Every safety invariant is a HARD assert. Any violation throws → red banner, exit
// 1 — this proof exists precisely to catch a regression in the coordination
// guarantees, so it must never paper one over.
//
//   Agent A  →  owns dirA  →  asks B to take mission PROJ-1234
//   Agent B  →  owns dirB  →  accepts (becomes assignee), then HANDS OFF to C
//   Agent C  →  owns dirC  →  must ACCEPT to become assignee (a handoff never forces it)
//
// The invariants proven (see the numbered STEPs below):
//   • three separate stores         — A, B, C never share a directory
//   • join-key reference            — every message names the mission by PROJ-1234, never a local UUID
//   • kind:"coordination" transport — the envelope crosses the mailbox as a coordination wrapper
//   • request → accept → assigned   — an accept sets assignee; the accepter is the new holder
//   • offer → accept reachable      — the bid direction also sets assignee on the accept
//   • non-transitive (the big one)  — an accept NEVER changes status / learnings / trust (only assignee)
//   • handoff is non-transitive     — a handoff is logged but does NOT set the receiver's assignee
//   • handoff confirmed by accept   — the receiver's OWN accept is what moves the assignment
//   • handoff guard                 — a non-assignee handoff is refused (not_assignee)
//   • consent posture               — a friend peer may coordinate; an acquaintance is refused (no_consent)
//   • trust cap / seeding gate      — a stranger is refused; a friend may seed an unknown mission
//   • last-writer-wins              — two accepts: the later-issuedAt one is the effective assignee
//   • replay safety                 — a seen coordination message is skipped
//   • hostile-mailbox tamper        — a forged handoff can NOT force an assignee; first-party untouched
//   • standing independence         — no coordination wire byte carries a standing/third-party field
//
// Run it:  npm run example:cross-agent-coordination
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { randomUUID } from "node:crypto"

import { buildOutgoing, readIncoming, markSeen } from "../src/a2a"
import type { SeenLedger } from "../src/a2a"

// The built MCP entrypoint. The npm script runs `npm run build` first so it exists;
// fail fast with a clear message otherwise.
const BIN_PATH = join(__dirname, "..", "dist", "mcp", "bin.js")
if (!existsSync(BIN_PATH)) {
  console.error(`Missing built MCP bin at ${BIN_PATH}. Run \`npm run build\` first (the npm script does this for you).`)
  process.exit(1)
}

// ── A tiny JSON-RPC-over-stdio client for one spawned `friends-mcp` process ──
// One instance == one agent. Each agent owns exactly one store (its `--dir`).
interface JsonRpcResponse {
  jsonrpc: string
  id: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

class Agent {
  readonly label: string
  readonly dir: string
  private readonly child: ChildProcessWithoutNullStreams
  private buf = ""
  private readonly pending = new Map<number, (res: JsonRpcResponse) => void>()
  private nextId = 1

  constructor(label: string, dir: string) {
    this.label = label
    this.dir = dir
    // Each agent is its OWN process pointed at its OWN directory — the
    // three-separate-stores property that makes them genuinely three agents.
    this.child = spawn("node", [BIN_PATH, "--dir", dir], { stdio: ["pipe", "pipe", "pipe"] })
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf-8")
      this.drain()
    })
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${label} stderr] ${chunk.toString("utf-8")}`)
    })
  }

  private drain(): void {
    for (;;) {
      const nl = this.buf.indexOf("\n")
      if (nl === -1) return
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line.length === 0) continue
      const res = JSON.parse(line) as JsonRpcResponse
      const id = typeof res.id === "number" ? res.id : -1
      const resolve = this.pending.get(id)
      if (resolve) {
        this.pending.delete(id)
        resolve(res)
      }
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`[${this.label}] timeout waiting for ${method} (id ${id})`))
      }, 5000)
      this.pending.set(id, (res) => {
        clearTimeout(timer)
        resolve(res)
      })
      this.child.stdin.write(msg + "\n")
    })
  }

  async initialize(): Promise<void> {
    const res = await this.request("initialize", {})
    assert.equal(res.result?.protocolVersion, "2024-11-05", `[${this.label}] handshake failed`)
  }

  /** Call a tool; return the parsed JSON payload + isError. */
  async tool(name: string, args: Record<string, unknown>): Promise<{ payload: any; isError: boolean }> {
    const res = await this.request("tools/call", { name, arguments: args })
    if (res.error) throw new Error(`[${this.label}] ${name} errored: ${JSON.stringify(res.error)}`)
    const result = res.result as { content: Array<{ text: string }>; isError: boolean }
    return { payload: JSON.parse(result.content[0].text), isError: result.isError }
  }

  kill(): void {
    this.child.stdin.end()
    this.child.kill()
  }
}

// ── Tiny console helpers so the transcript reads as a sequence of asserted facts ──
let stepNum = 0
function step(title: string): void {
  stepNum += 1
  console.log(`\n━━ STEP ${stepNum}: ${title}`)
}
function ok(msg: string): void {
  console.log(`   ✓ ${msg}`)
}

// The shared mission join key all three agents use. This — never a local UUID — is
// the cross-agent currency. Generic, public-repo-safe.
const MISSION_KEY = "PROJ-1234"
// The mailbox routing agentIds. We make each owner's record `id` EQUAL its routing
// agentId, so whoami(self).selfFriendId === the routing id — the producer's
// first-party `assignee` and the peer's imported `assignee` then name the holder by
// the SAME string across stores (clean cross-store assertions).
const AGENT_A_ID = "agent-a"
const AGENT_B_ID = "agent-b"
const AGENT_C_ID = "agent-c"

/** Pre-seed a friend record JSON directly into a store dir BEFORE its server
 * starts — the owner/self record (resolved via whoami) and the peer records. */
function seedFriend(dir: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8")
}

/** Pre-seed a mission record JSON directly into a store's sibling `_missions/` dir
 * BEFORE its server starts — to give every store the SAME mission by missionKey with
 * its own local UUID + a first-party learning the coordination flow must never touch. */
function seedMission(dir: string, record: Record<string, unknown>): void {
  const missionsDir = join(dir, "_missions")
  mkdirSync(missionsDir, { recursive: true })
  writeFileSync(join(missionsDir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8")
}

/** An owner/self record whose `id` IS its routing agentId (so whoami resolves a
 * self whose id == the mailbox id). `family` so whoami's family-fallback resolves
 * it deterministically regardless of the host OS user. */
function ownerRecord(agentId: string, ownerExternalId: string, now: string): Record<string, unknown> {
  return {
    id: agentId,
    name: `Owner ${agentId}`,
    role: "primary",
    trustLevel: "family",
    externalIds: [{ provider: "local", externalId: ownerExternalId, linkedAt: now }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    kind: "human",
  }
}

/** The SAME mission by missionKey, with a distinct local UUID + a first-party
 * learning + status the coordination flow must leave physically untouched. */
function missionRecord(localId: string, now: string): Record<string, unknown> {
  return {
    id: localId,
    missionKey: MISSION_KEY,
    title: "Ship the coordination brick",
    status: "active",
    participants: [],
    outcomes: [],
    learnings: {
      gotcha: { value: "rebase, never merge", savedAt: now, shareable: true, provenance: { origin: "first_party" } },
    },
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  }
}

// ── The mailbox is just a directory. THIS host does the "git" (file I/O). ──

function mailboxWrite(mailboxDir: string, relativePath: string, bytes: string): void {
  const abs = join(mailboxDir, relativePath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes, "utf-8")
}

/** Enumerate the mailbox (the host's "git pull" + walk). `toFilter` narrows to one
 * recipient's routing dirs (undefined ⇒ all recipients). */
function mailboxEnumerate(mailboxDir: string, toFilter?: string): Array<{ relativePath: string; bytes: string }> {
  const out: Array<{ relativePath: string; bytes: string }> = []
  const agentsRoot = join(mailboxDir, "agents")
  if (!existsSync(agentsRoot)) return out
  for (const from of readdirSync(agentsRoot)) {
    const outboxRoot = join(agentsRoot, from, "outbox")
    if (!existsSync(outboxRoot)) continue
    for (const to of readdirSync(outboxRoot)) {
      if (toFilter !== undefined && to !== toFilter) continue
      const toDir = join(outboxRoot, to)
      for (const file of readdirSync(toDir)) {
        if (!file.endsWith(".json")) continue
        out.push({
          relativePath: `agents/${from}/outbox/${to}/${file}`,
          bytes: readFileSync(join(toDir, file), "utf-8"),
        })
      }
    }
  }
  return out
}

/** Deliver one prepared coordination envelope over the mailbox: build the wrapper as
 * kind:"coordination", write it into the sender's outbox, then have the recipient
 * enumerate + readIncoming + import_coordination. Returns the import payload + the
 * messageId (so a later replay assertion can mark it seen). Asserts path-binding +
 * no-UUID-on-the-wire along the way. */
async function deliver(
  mailboxDir: string,
  sender: { agentId: string },
  recipient: Agent & { agentId: string },
  envelope: Record<string, unknown>,
  trustOfSender: string,
  localUuidThatMustNotLeak: string,
): Promise<{ importPayload: any; messageId: string }> {
  const outgoing = buildOutgoing({ envelope: envelope as any, fromAgentId: sender.agentId, toAgentId: recipient.agentId, kind: "coordination" })
  assert.match(
    outgoing.relativePath,
    new RegExp(`^agents/${sender.agentId}/outbox/${recipient.agentId}/.+--[0-9a-f-]{36}\\.json$`),
    "path shape must match the post-office layout",
  )
  mailboxWrite(mailboxDir, outgoing.relativePath, outgoing.bytes)

  const writtenBytes = readFileSync(join(mailboxDir, outgoing.relativePath), "utf-8")
  assert.ok(writtenBytes.includes('"kind": "coordination"'), "the wrapper on disk must be kind:coordination")
  assert.equal(writtenBytes.includes(localUuidThatMustNotLeak), false, "the written mailbox file must NOT contain a local mission UUID")
  assert.ok(writtenBytes.includes(MISSION_KEY), "the written mailbox file must name the mission by missionKey")

  const files = mailboxEnumerate(mailboxDir, recipient.agentId)
  const incoming = readIncoming({ files, selfAgentId: recipient.agentId, seen: { seen: {} } })
  const ready = incoming.ready.find((m) => m.messageId === outgoing.messageId)
  assert.ok(ready, "the coordination message must be ready for the recipient")
  assert.equal(ready!.kind, "coordination", "readIncoming must surface kind:coordination")

  const imported = await recipient.tool("import_coordination", {
    envelope: ready!.envelope,
    fromAgentId: sender.agentId,
    trustOfSource: trustOfSender,
  })
  return { importPayload: imported.payload, messageId: outgoing.messageId }
}

async function main(): Promise<void> {
  const dirA = mkdtempSync(join(tmpdir(), "friends-coord-A-"))
  const dirB = mkdtempSync(join(tmpdir(), "friends-coord-B-"))
  const dirC = mkdtempSync(join(tmpdir(), "friends-coord-C-"))
  const mailboxDir = mkdtempSync(join(tmpdir(), "friends-coord-mailbox-"))
  let agentA: (Agent & { agentId: string }) | undefined
  let agentB: (Agent & { agentId: string }) | undefined
  let agentC: (Agent & { agentId: string }) | undefined

  try {
    const now = new Date().toISOString()

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1 — Three stores, the SAME mission (same missionKey), different local
    // UUIDs. Each owner's record id == its routing agentId (whoami self == mailbox
    // id). Mutual friend peers WITH mailbox coords (so the identity-tier
    // "coordinate" scope consents by trust, and the transport has coordinates).
    // ════════════════════════════════════════════════════════════════════════
    step("Three separate stores know mission PROJ-1234 by the same missionKey; A↔B↔C are friend peers")

    seedFriend(dirA, ownerRecord(AGENT_A_ID, "owner-a", now))
    seedFriend(dirB, ownerRecord(AGENT_B_ID, "owner-b", now))
    seedFriend(dirC, ownerRecord(AGENT_C_ID, "owner-c", now))

    const missionInA = randomUUID()
    const missionInB = randomUUID()
    const missionInC = randomUUID()
    seedMission(dirA, missionRecord(missionInA, now))
    seedMission(dirB, missionRecord(missionInB, now))
    seedMission(dirC, missionRecord(missionInC, now))
    assert.ok(missionInA !== missionInB && missionInB !== missionInC, "each store must give the mission a distinct local UUID")
    ok(`three stores, same missionKey ${MISSION_KEY}, distinct local UUIDs`)

    agentA = Object.assign(new Agent("A", dirA), { agentId: AGENT_A_ID })
    agentB = Object.assign(new Agent("B", dirB), { agentId: AGENT_B_ID })
    agentC = Object.assign(new Agent("C", dirC), { agentId: AGENT_C_ID })
    await agentA.initialize()
    await agentB.initialize()
    await agentC.initialize()

    // whoami resolves each owner to an id == its routing agentId.
    assert.equal((await agentA.tool("whoami", {})).payload.selfFriendId, AGENT_A_ID)
    assert.equal((await agentB.tool("whoami", {})).payload.selfFriendId, AGENT_B_ID)
    assert.equal((await agentC.tool("whoami", {})).payload.selfFriendId, AGENT_C_ID)

    // Mutual onboard at `friend` WITH mailbox coords. Each agent onboards the other
    // two by their routing agentId (the a2a-agent externalId the consent layer
    // resolves trust on). Capture B's peer-record id in A's store so we can flip its
    // trust later by its LOCAL UUID (never by name — that would write a duplicate file).
    let bPeerIdInA = ""
    for (const [self, peers] of [
      [agentA, [AGENT_B_ID, AGENT_C_ID]],
      [agentB, [AGENT_A_ID, AGENT_C_ID]],
      [agentC, [AGENT_A_ID, AGENT_B_ID]],
    ] as Array<[Agent & { agentId: string }, string[]]>) {
      for (const peer of peers) {
        const onboarded = await self.tool("onboard_agent", {
          name: `Peer ${peer}`,
          agentId: peer,
          trustLevel: "friend",
          mailbox: JSON.stringify({ repo: mailboxDir, selfOutboxAgentId: self.agentId }),
        })
        if (self.agentId === AGENT_A_ID && peer === AGENT_B_ID) bPeerIdInA = onboarded.payload.id
      }
    }
    assert.ok(bPeerIdInA, "A must have a local peer record for B")
    ok("A↔B↔C are mutual friend peers with git-mailbox coords")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2 — Consent posture. Under the tiered default, `coordinate` is an
    // identity-tier scope: a FRIEND peer may be asked without a per-mission grant;
    // an ACQUAINTANCE is refused (no_consent); re-promoting to friend unblocks.
    // ════════════════════════════════════════════════════════════════════════
    step("Consent posture — a friend peer may coordinate; an acquaintance is refused; re-promotion unblocks")
    // Temporarily demote A's view of B to acquaintance → no_consent.
    await agentA.tool("set_trust", { friendId: bPeerIdInA, trustLevel: "acquaintance" })
    const demoted = await agentA.tool("coordinate", { missionId: missionInA, toAgentId: AGENT_B_ID, intent: "request" })
    assert.equal(demoted.payload.ok, false, "coordinating to an acquaintance peer must be refused")
    assert.equal(demoted.payload.status, "no_consent", "refusal reason must be no_consent (below the identity-tier floor)")
    ok("acquaintance recipient → REFUSED (no_consent)")
    // Re-promote to friend → consent restored (identity-tier).
    await agentA.tool("set_trust", { friendId: bPeerIdInA, trustLevel: "friend" })
    ok("re-promoted B to friend — the identity-tier scope consents again")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3 — request → accept → ASSIGNED, and the NON-TRANSITIVE invariant.
    // A asks B; B accepts; A imports the accept → A's assignee === B, and the
    // mission's status / first-party learnings / B's trust are ALL untouched.
    // ════════════════════════════════════════════════════════════════════════
    step("request → accept → assigned (and an accept changes ONLY assignee — never status/learnings/trust)")

    // A → request → B. B logs it origin:imported, attributed to A.
    const reqEnvelope = (await agentA.tool("coordinate", { missionId: missionInA, toAgentId: AGENT_B_ID, intent: "request", note: "can you take this?" })).payload.envelope
    assert.equal(reqEnvelope.subject.missionKey, MISSION_KEY, "the request names the mission by missionKey")
    assert.equal(JSON.stringify(reqEnvelope).includes(missionInA), false, "A's local UUID must never be on the wire")
    const reqAtB = await deliver(mailboxDir, agentA, agentB, reqEnvelope, "friend", missionInA)
    assert.equal(reqAtB.importPayload.status, "logged", "a request lands as logged (no assignee change)")
    const bAfterReq = await agentB.tool("get_coordination", { missionId: missionInB })
    const bRequestEntry = bAfterReq.payload.log.find((e: any) => e.intent === "request")
    assert.ok(bRequestEntry, "B's log must contain the request")
    assert.equal(bRequestEntry.provenance.origin, "imported", "the request is stamped origin:imported in B's store")
    assert.equal(bRequestEntry.fromAgentId, AGENT_A_ID, "the request is attributed to A")
    assert.equal(bAfterReq.payload.assignee, undefined, "a request must NOT set an assignee")
    ok("A's request landed in B's log (origin:imported, attributed to A); no assignee yet")

    // Capture A's mission state BEFORE the accept, to prove non-transitivity after.
    const aMissionBefore = (await agentA.tool("get_mission", { missionId: missionInA })).payload
    const bTrustInABefore = (await agentA.tool("get_friend", { friendId: bPeerIdInA })).payload.trustLevel

    // B → accept → A. B's own store claims the assignment for itself; A's store, on
    // import, sets assignee = B.
    const accEnvelope = (await agentB.tool("coordinate", { missionId: missionInB, toAgentId: AGENT_A_ID, intent: "accept", note: "on it" })).payload.envelope
    const bSelfCoord = await agentB.tool("get_coordination", { missionId: missionInB })
    assert.equal(bSelfCoord.payload.assignee.agentId, AGENT_B_ID, "B's OWN store records B as the assignee on its accept")
    const accAtA = await deliver(mailboxDir, agentB, agentA, accEnvelope, "friend", missionInB)
    assert.equal(accAtA.importPayload.status, "assigned", "A importing B's accept yields status assigned")

    const aAfterAccept = await agentA.tool("get_coordination", { missionId: missionInA })
    assert.equal(aAfterAccept.payload.assignee.agentId, AGENT_B_ID, "A's store now records B as the assignee")
    assert.ok(aAfterAccept.payload.assignedAt, "assignedAt is stamped")
    ok("B accepted → A's mission assignee === agent-b (the accepter is the holder)")

    // NON-TRANSITIVE: status + first-party learnings + B's trust are byte-untouched.
    const aMissionAfter = (await agentA.tool("get_mission", { missionId: missionInA })).payload
    assert.equal(aMissionAfter.status, aMissionBefore.status, "INVARIANT non-transitive: the accept must NOT change the mission status")
    assert.equal(aMissionAfter.status, "active")
    assert.equal(aMissionAfter.learnings.gotcha.value, "rebase, never merge", "INVARIANT non-transitive: first-party learnings are physically untouched")
    const bTrustInAAfter = (await agentA.tool("get_friend", { friendId: bPeerIdInA })).payload.trustLevel
    assert.equal(bTrustInAAfter, bTrustInABefore, "INVARIANT non-transitive: the accept must NOT change B's trust")
    assert.equal(bTrustInAAfter, "friend")
    ok("non-transitive: status \"active\", learnings, and B's trust \"friend\" are ALL untouched — only assignee moved")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 4 — offer → accept reachable (the bid direction). C OFFERS to take it;
    // A's accept of that offer would set A — but to keep the running assignment on
    // B for the handoff, we assert the offer is logged and reachable, then the
    // accept direction is the same transition already proven in STEP 3.
    // ════════════════════════════════════════════════════════════════════════
    step("offer → accept reachable (the volunteer/bid direction; an offer logs, an accept assigns)")
    const offerEnvelope = (await agentC.tool("coordinate", { missionId: missionInC, toAgentId: AGENT_A_ID, intent: "offer", note: "I can take it" })).payload.envelope
    assert.equal(offerEnvelope.intent, "offer")
    const offerAtA = await deliver(mailboxDir, agentC, agentA, offerEnvelope, "friend", missionInC)
    assert.equal(offerAtA.importPayload.status, "logged", "an offer lands as logged (a bid; no assignee change)")
    const aAfterOffer = await agentA.tool("get_coordination", { missionId: missionInA })
    assert.ok(aAfterOffer.payload.log.some((e: any) => e.intent === "offer" && e.fromAgentId === AGENT_C_ID), "C's offer is in A's log")
    // The assignment is still B's (the offer did not move it).
    assert.equal(aAfterOffer.payload.assignee.agentId, AGENT_B_ID, "the offer left B as the assignee")
    ok("C's offer landed in A's log; the assignment is still B's (an offer is a bid, not a claim)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 5 — HANDOFF is non-transitive. B (the assignee) hands off to C. On C's
    // import the proposal is LOGGED but C's assignee is NOT set. C's OWN accept is
    // what moves the assignment; A/B importing that accept converge assignee → C.
    // ════════════════════════════════════════════════════════════════════════
    step("handoff is non-transitive — a handoff is logged but does NOT set the receiver's assignee; the receiver's accept does")

    // First: the handoff GUARD — a NON-assignee (A) cannot hand off.
    const badHandoff = await agentA.tool("coordinate", { missionId: missionInA, toAgentId: AGENT_C_ID, intent: "handoff", proposedAssignee: JSON.stringify({ agentId: AGENT_C_ID }) })
    assert.equal(badHandoff.payload.ok, false, "a non-assignee handoff must be refused")
    assert.equal(badHandoff.payload.status, "not_assignee", "the refusal reason must be not_assignee (you must hold it to hand it off)")
    ok("handoff guard: A (not the assignee) handing off → REFUSED (not_assignee)")

    // B (the assignee) hands off to C.
    const handoffEnvelope = (await agentB.tool("coordinate", { missionId: missionInB, toAgentId: AGENT_C_ID, intent: "handoff", proposedAssignee: JSON.stringify({ agentId: AGENT_C_ID }) })).payload.envelope
    assert.equal(handoffEnvelope.intent, "handoff")
    assert.deepEqual(handoffEnvelope.proposedAssignee, { agentId: AGENT_C_ID }, "the handoff envelope proposes C as the new assignee")
    const handoffAtC = await deliver(mailboxDir, agentB, agentC, handoffEnvelope, "friend", missionInB)
    assert.equal(handoffAtC.importPayload.status, "logged", "an inbound handoff lands as logged (a proposal), never assigned")
    const cAfterHandoff = await agentC.tool("get_coordination", { missionId: missionInC })
    assert.equal(cAfterHandoff.payload.assignee, undefined, "INVARIANT non-transitive: a handoff must NOT set C's assignee on receipt")
    assert.ok(cAfterHandoff.payload.log.some((e: any) => e.intent === "handoff" && e.fromAgentId === AGENT_B_ID), "the handoff proposal is logged in C's store")
    ok("B handed off to C → C's store LOGGED the proposal but assignee is STILL unset (a peer can't force an assignment)")

    // C's OWN accept is what actually moves the assignment to C.
    const cAcceptEnvelope = (await agentC.tool("coordinate", { missionId: missionInC, toAgentId: AGENT_B_ID, intent: "accept" })).payload.envelope
    const cSelfCoord = await agentC.tool("get_coordination", { missionId: missionInC })
    assert.equal(cSelfCoord.payload.assignee.agentId, AGENT_C_ID, "C's own accept sets C as the assignee in C's store")
    ok("C's OWN accept set assignee === agent-c (the handoff is confirmed only by the receiver's accept)")

    // B imports C's accept → B's assignee updates from B to C (assignment moved).
    const cAcceptAtB = await deliver(mailboxDir, agentC, agentB, cAcceptEnvelope, "friend", missionInC)
    assert.equal(cAcceptAtB.importPayload.status, "assigned", "B importing C's accept re-assigns")
    const bAfterCAccept = await agentB.tool("get_coordination", { missionId: missionInB })
    assert.equal(bAfterCAccept.payload.assignee.agentId, AGENT_C_ID, "the assignment MOVED to C in B's store (full log retained)")
    assert.ok(bAfterCAccept.payload.log.length >= 3, "B's append-only log retains request-era + handoff + the new accept")
    ok("B imported C's accept → assignment MOVED B → C (the append-only log retains the whole negotiation)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 6 — Trust cap + seeding gate. A coordination message from a STRANGER is
    // refused (untrusted_source). An UNKNOWN mission introduced by an ACQUAINTANCE is
    // refused (untrusted_introduction); by a FRIEND it is SEEDED (active, request logged).
    // ════════════════════════════════════════════════════════════════════════
    step("Trust cap + seeding gate — stranger refused; unknown mission seeded only by a friend")

    function introEnvelope(missionKey: string): Record<string, unknown> {
      return { subject: { missionKey, title: `Mission ${missionKey}` }, fromAgentId: "agent-x", intent: "request", note: "take this?", issuedAt: new Date().toISOString() }
    }

    // (a) STRANGER source → refused at the accept cap.
    const strangerImport = await agentA.tool("import_coordination", { envelope: introEnvelope("repo#stranger"), fromAgentId: "agent-stranger", trustOfSource: "stranger" })
    assert.equal(strangerImport.payload.ok, false, "a stranger source must be refused")
    assert.equal(strangerImport.payload.status, "untrusted_source", "a stranger is refused at the acceptance cap")
    ok("stranger source → REFUSED (untrusted_source)")

    // (b) ACQUAINTANCE source introducing an UNKNOWN mission → may not seed.
    const acqImport = await agentA.tool("import_coordination", { envelope: introEnvelope("repo#acq"), fromAgentId: "agent-acq", trustOfSource: "acquaintance" })
    assert.equal(acqImport.payload.ok, false, "an acquaintance may not seed a new mission")
    assert.equal(acqImport.payload.status, "untrusted_introduction", "an acquaintance is refused at the seeding gate")
    ok("acquaintance introducing an unknown mission → REFUSED (untrusted_introduction)")

    // (c) FRIEND source introducing an UNKNOWN mission → SEEDED (active, request logged).
    const friendSeedKey = "repo#friend-seed"
    const friendImport = await agentA.tool("import_coordination", { envelope: introEnvelope(friendSeedKey), fromAgentId: AGENT_B_ID, trustOfSource: "friend" })
    assert.equal(friendImport.payload.ok, true, "a friend may seed a new mission")
    assert.equal(friendImport.payload.status, "seeded", "a friend introduction of an unknown mission is seeded")
    assert.equal(friendImport.payload.record.status, "active", "a seeded mission starts active")
    assert.deepEqual(friendImport.payload.record.learnings, {}, "a seeded mission starts with empty first-party learnings")
    assert.equal(friendImport.payload.record.coordination.log[0].intent, "request", "the introducing request is logged on the seeded mission")
    assert.equal(friendImport.payload.record.coordination.assignee, undefined, "a seeded mission from a request has no assignee")
    ok("friend introducing an unknown mission → SEEDED (active, empty learnings, request logged)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 7 — Last-writer-wins by issuedAt. Two accepts for one fresh mission with
    // DIFFERENT issuedAt: the later-issuedAt accepter is the effective assignee; BOTH
    // appear in the append-only log (the race is fully audited). No locks, no
    // coordinator — just the mailbox's existing total order + one timestamp.
    // ════════════════════════════════════════════════════════════════════════
    step("Last-writer-wins — two accepts with different issuedAt: the later one is the effective assignee; both logged")
    const lwwKey = "repo#lww"
    // Seed the mission on C's store directly (active, no coordination) so both accepts land there.
    const lwwLocal = randomUUID()
    seedMission(dirC, { id: lwwLocal, missionKey: lwwKey, title: "LWW mission", status: "active", participants: [], outcomes: [], learnings: {}, createdAt: now, updatedAt: now, schemaVersion: 1 })
    // Restart C so it picks up the freshly-seeded mission file.
    agentC.kill()
    agentC = Object.assign(new Agent("C", dirC), { agentId: AGENT_C_ID })
    await agentC.initialize()

    const tEarly = "2026-06-21T10:00:00.000Z"
    const tLate = "2026-06-21T11:00:00.000Z"
    // The LATER accept arrives FIRST; the EARLIER accept arrives second and must NOT clobber it.
    const lateAccept = { subject: { missionKey: lwwKey, title: "LWW mission" }, fromAgentId: AGENT_A_ID, intent: "accept", issuedAt: tLate }
    const earlyAccept = { subject: { missionKey: lwwKey, title: "LWW mission" }, fromAgentId: AGENT_B_ID, intent: "accept", issuedAt: tEarly }
    const lateImport = await agentC.tool("import_coordination", { envelope: lateAccept, fromAgentId: AGENT_A_ID, trustOfSource: "friend" })
    assert.equal(lateImport.payload.status, "assigned", "the first (later-issuedAt) accept assigns")
    const earlyImport = await agentC.tool("import_coordination", { envelope: earlyAccept, fromAgentId: AGENT_B_ID, trustOfSource: "friend" })
    assert.equal(earlyImport.payload.status, "logged", "the earlier-issuedAt accept arriving later is logged, NOT effective")
    const lwwCoord = await agentC.tool("get_coordination", { missionId: lwwLocal })
    assert.equal(lwwCoord.payload.assignee.agentId, AGENT_A_ID, "LWW: the later-issuedAt accepter (A) is the effective assignee")
    assert.equal(lwwCoord.payload.assignedAt, tLate, "the assignedAt is the later issuedAt")
    assert.equal(lwwCoord.payload.log.length, 2, "BOTH accepts remain in the append-only log (the race is audited)")
    ok("LWW by issuedAt: A (later) holds it; B's earlier accept is logged but not effective; both in the log")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 8 — Replay safety. Re-feed an already-seen coordination message → the
    // seen-ledger skips it (0 ready, 1 skipped). Exactly-once over a git-replay.
    // ════════════════════════════════════════════════════════════════════════
    step("Replay safety — a seen coordination message is skipped, never re-delivered")
    const filesForB = mailboxEnumerate(mailboxDir, AGENT_B_ID)
    const seenLedger: SeenLedger = markSeen({ seen: {} }, reqAtB.messageId)
    // reqAtB went to B; mark it seen and re-read B's mailbox.
    const replay = readIncoming({ files: filesForB, selfAgentId: AGENT_B_ID, seen: seenLedger })
    assert.ok(replay.skippedSeen.includes(reqAtB.messageId), "the seen message must be reported as skipped")
    assert.ok(!replay.ready.some((m) => m.messageId === reqAtB.messageId), "a seen message must not be ready again")
    ok("re-reading the mailbox with the message marked seen → it is skipped (exactly-once)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 9 — Hostile-mailbox tamper. A mailbox that altered an envelope's intent /
    // proposedAssignee (routing path-bound, so fromAgentId is fixed) can still only
    // land an attributed, quarantined log entry — a forged HANDOFF can NEVER force an
    // assignee, and first-party status/learnings stay inviolable.
    // "A compromised mailbox can DENY or REPLAY, never ESCALATE."
    // ════════════════════════════════════════════════════════════════════════
    step("Hostile-mailbox tamper — a forged handoff can NEVER force an assignee; first-party stays inviolable")
    // Seed a fresh, UNASSIGNED mission on A so we can prove a forged handoff can't assign it.
    const tamperKey = "repo#tamper"
    const tamperLocal = randomUUID()
    seedMission(dirA, { id: tamperLocal, missionKey: tamperKey, title: "Tamper mission", status: "active", participants: [], outcomes: [], learnings: { secret: { value: "first-party only", savedAt: now, provenance: { origin: "first_party" } } }, createdAt: now, updatedAt: now, schemaVersion: 1 })
    agentA.kill()
    agentA = Object.assign(new Agent("A", dirA), { agentId: AGENT_A_ID })
    await agentA.initialize()

    // A hostile mailbox forges a handoff from B (correctly routed under B's outbox dir,
    // so path-binding can't catch it) trying to dump the assignment onto A.
    const forgedHandoff = {
      mailboxVersion: 1,
      messageId: randomUUID(),
      fromAgentId: AGENT_B_ID,
      toAgentId: AGENT_A_ID,
      issuedAt: new Date().toISOString(),
      kind: "coordination",
      envelope: { subject: { missionKey: tamperKey, title: "Tamper mission" }, fromAgentId: AGENT_B_ID, intent: "handoff", proposedAssignee: { agentId: AGENT_A_ID }, issuedAt: new Date().toISOString() },
    }
    const forgedPath = `agents/${AGENT_B_ID}/outbox/${AGENT_A_ID}/${forgedHandoff.issuedAt}--${forgedHandoff.messageId}.json`
    mailboxWrite(mailboxDir, forgedPath, JSON.stringify(forgedHandoff, null, 2))

    // Path-binding can't catch a correctly-routed forgery — it IS delivered.
    const forgedFiles = mailboxEnumerate(mailboxDir, AGENT_A_ID)
    const forgedRead = readIncoming({ files: forgedFiles, selfAgentId: AGENT_A_ID, seen: { seen: {} } })
    const forgedReady = forgedRead.ready.find((m) => m.messageId === forgedHandoff.messageId)
    assert.ok(forgedReady, "a correctly-routed forged handoff IS delivered (content trust is the import layer's job)")

    const forgedImport = await agentA.tool("import_coordination", { envelope: forgedReady!.envelope, fromAgentId: AGENT_B_ID, trustOfSource: "friend" })
    assert.equal(forgedImport.payload.ok, true, "the import itself succeeds (it's a trusted peer)")
    assert.equal(forgedImport.payload.status, "logged", "a forged handoff lands as a logged proposal, NOT assigned")
    const aTampered = await agentA.tool("get_coordination", { missionId: tamperLocal })
    assert.equal(aTampered.payload.assignee, undefined, "INVARIANT: a forged handoff can NEVER force an assignee onto A")
    const aTamperedMission = (await agentA.tool("get_mission", { missionId: tamperLocal })).payload
    assert.equal(aTamperedMission.status, "active", "INVARIANT: a hostile mailbox can NEVER change the mission status")
    assert.equal(aTamperedMission.learnings.secret.value, "first-party only", "INVARIANT: a hostile mailbox can NEVER touch first-party learnings")
    ok("worst case over a hostile mailbox: an attributed quarantined log entry — a forged handoff forced NOTHING; first-party inviolable")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 10 — Standing independence + no third-party leak on the wire. Walk EVERY
    // coordination message file in the mailbox; assert NONE carry a `standing`/`tier`
    // field, and a coordination envelope only ever names its own subject + (on a
    // handoff) a proposedAssignee — never a third party's standing.
    // ════════════════════════════════════════════════════════════════════════
    step("Standing independence — no coordination wire byte carries a standing/tier field")
    const allMailbox = mailboxEnumerate(mailboxDir)
    assert.ok(allMailbox.length > 0, "the mailbox must contain coordination messages")
    let coordCount = 0
    for (const file of allMailbox) {
      if (!file.bytes.includes('"kind": "coordination"')) continue
      coordCount += 1
      assert.equal(file.bytes.includes('"standing"'), false, `${file.relativePath} must not carry a standing field`)
      assert.equal(file.bytes.includes('"tier"'), false, `${file.relativePath} must not carry a tier field`)
    }
    assert.ok(coordCount > 0, "at least one coordination message must have crossed the mailbox")
    ok(`walked ${coordCount} coordination messages on the wire — none carry "standing" or "tier"`)

    // ════════════════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log("✅  CROSS-AGENT COORDINATION PROVEN — three agents negotiated WHO")
    console.log("    does a shared mission over the MCP wire + a kind:\"coordination\"")
    console.log("    mailbox: consent-gated, missionKey-not-UUID, request/offer/accept")
    console.log("    assigns, handoff is non-transitive (the receiver's accept confirms),")
    console.log("    the handoff guard holds, trust-capped + seeding-gated, last-writer-")
    console.log("    wins on conflicting accepts, replay-safe, and inviolable against a")
    console.log("    hostile mailbox — assignment never touches status / learnings / trust.")
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  } finally {
    agentA?.kill()
    agentB?.kill()
    agentC?.kill()
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
    rmSync(dirC, { recursive: true, force: true })
    rmSync(mailboxDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error("\n❌  COORDINATION PROOF FAILED — this is a real safety regression, not a flake:")
  console.error(err)
  process.exit(1)
})
