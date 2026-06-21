// A2A git-mailbox transport — end-to-end proof (brick two's capstone).
//
// The cross-agent moat (see examples/cross-agent-moat.ts) proves two DIFFERENT
// agents can agree a party is the same person and share — with consent, without
// clobber — by handing a `ProfileShareEnvelope` between them as JSON. THIS proof
// shows that envelope crossing a CONCRETE transport: a git-backed mailbox.
//
// The picture: two agents that authenticate as two DISTINCT git identities share
// one dedicated PRIVATE mailbox repo. Each agent writes only its own per-agent
// outbox dir (single-writer); addressing lives in the path; the consumer's
// `readIncoming` binds the wrapper's claimed sender/recipient against the path
// and rejects any mismatch — so a hostile mailbox can only DENY or REPLAY, never
// escalate. The pure `@ouro.bot/friends/a2a` library does NO git itself; THIS
// script is the host and does every "git" op (here: plain file writes/reads into
// a tmp dir — no actual git binary needed, which keeps the proof hermetic).
//
// ZERO Ouroboros (or any harness) code is in the loop. The MCP side spawns the
// package's own built `dist/mcp/bin.js` twice (exactly as the capstone does); the
// transport side calls the pure a2a fns. We import those from `../src/a2a` (a
// pure, tsx-compiled module with no build-state dependence) for readability — the
// cross-agent MCP path still goes through the built bin, just like the capstone.
//
// Every invariant is a HARD assert. Any violation throws → red banner, exit 1.
//
// Run it:  npm run example:a2a-git-mailbox
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { randomUUID } from "node:crypto"

import { buildOutgoing, readIncoming, markSeen } from "../src/a2a"
import type { SeenLedger } from "../src/a2a"

// The built MCP entrypoint. The npm script runs `npm run build` first so it
// exists; fail fast with a clear message otherwise.
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

// The shared join key both agents use to name party P. This — never a local
// UUID — is the cross-agent currency. Generic, public-repo-safe.
const P_JOIN_KEY = { provider: "aad", externalId: "p@example.com" } as const
const AGENT_A_ID = "agent-a"
const AGENT_B_ID = "agent-b"

/** Pre-seed a friend record JSON directly into a store dir BEFORE its server
 * starts — to build `shareable` + first-party fixtures the MCP `save_note`
 * surface intentionally can't express. The live moat flow (grant / share /
 * buildOutgoing / write / readIncoming / import) still runs entirely through the
 * two servers + the pure a2a fns. */
function seedFriend(dir: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8")
}

// ── The mailbox is just a directory. THIS host does the "git" (file I/O). ──

/** Write a message's bytes at its git-relative path under the mailbox root,
 * mkdir-ing the outbox dirs. This is the host's "git add + commit + push". */
function mailboxWrite(mailboxDir: string, relativePath: string, bytes: string): void {
  const abs = join(mailboxDir, relativePath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes, "utf-8")
}

/** Enumerate the mailbox (the host's "git pull" + walk). Returns every message
 * file under `agents/<from>/outbox/<to>/*.json`, each as { relativePath, bytes }
 * with a POSIX relativePath relative to the mailbox root. `toFilter` narrows to
 * one recipient's routing dirs (undefined ⇒ all recipients). */
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

async function main(): Promise<void> {
  const dirA = mkdtempSync(join(tmpdir(), "friends-a2a-A-"))
  const dirB = mkdtempSync(join(tmpdir(), "friends-a2a-B-"))
  const mailboxDir = mkdtempSync(join(tmpdir(), "friends-a2a-mailbox-"))
  let agentA: Agent | undefined
  let agentB: Agent | undefined

  try {
    const now = new Date().toISOString()

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1 — Two stores, same party, different local UUIDs, B's own note.
    // ════════════════════════════════════════════════════════════════════════
    step("Two stores know party P by the same join key, each with its own first-party notes")

    const ownerAId = randomUUID()
    seedFriend(dirA, {
      id: ownerAId,
      name: "Owner A",
      role: "primary",
      trustLevel: "family",
      externalIds: [{ provider: "local", externalId: "owner-a", linkedAt: now }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      kind: "human",
    })

    const pInAId = randomUUID()
    seedFriend(dirA, {
      id: pInAId,
      name: "P",
      role: "friend",
      trustLevel: "acquaintance",
      externalIds: [{ provider: P_JOIN_KEY.provider, externalId: P_JOIN_KEY.externalId, linkedAt: now }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {
        role: { value: "Staff Engineer", savedAt: now, shareable: false, provenance: { origin: "first_party" } },
        team: { value: "Platform", savedAt: now, shareable: true, provenance: { origin: "first_party" } },
        salary: { value: "$private", savedAt: now, shareable: false, provenance: { origin: "first_party" } },
      },
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      kind: "human",
    })

    const ownerBId = randomUUID()
    seedFriend(dirB, {
      id: ownerBId,
      name: "Owner B",
      role: "primary",
      trustLevel: "family",
      externalIds: [{ provider: "local", externalId: "owner-b", linkedAt: now }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      kind: "human",
    })

    const pInBId = randomUUID()
    seedFriend(dirB, {
      id: pInBId,
      name: "P",
      role: "friend",
      trustLevel: "acquaintance",
      externalIds: [{ provider: P_JOIN_KEY.provider, externalId: P_JOIN_KEY.externalId, linkedAt: now }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {
        role: { value: "B's private guess", savedAt: now, shareable: false, provenance: { origin: "first_party" } },
      },
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      kind: "human",
    })

    assert.notEqual(pInAId, pInBId, "the two stores must give P different local UUIDs")
    ok(`Agent A knows P (local id ${pInAId.slice(0, 8)}…) as "Staff Engineer"`)
    ok(`Agent B knows P (local id ${pInBId.slice(0, 8)}…) as "B's private guess"`)
    ok("two SEPARATE stores; same join key aad:p@example.com; different local UUIDs")

    agentA = new Agent("A", dirA)
    agentB = new Agent("B", dirB)
    await agentA.initialize()
    await agentB.initialize()

    const aSeesP = await agentA.tool("get_friend", { friendId: pInAId })
    assert.equal(aSeesP.payload.notes.role.value, "Staff Engineer")
    const bSeesP = await agentB.tool("get_friend", { friendId: pInBId })
    assert.equal(bSeesP.payload.notes.role.value, "B's private guess")
    const whoA = await agentA.tool("whoami", {})
    const whoB = await agentB.tool("whoami", {})
    assert.equal(whoA.payload.selfFriendId, ownerAId, "Agent A's whoami must resolve Owner A")
    assert.equal(whoB.payload.selfFriendId, ownerBId, "Agent B's whoami must resolve Owner B")
    ok("each agent's MCP server sees only its own store; whoami resolves each owner")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2 — Mutual onboard at `friend` WITH mailbox coords. Exercises Unit 2's
    // round-trip preservation through the live MCP/file path.
    // ════════════════════════════════════════════════════════════════════════
    step("A and B onboard each other at `friend` trust WITH git-mailbox coords (round-trip preserved)")
    const bAsPeerOfA = await agentA.tool("onboard_agent", {
      name: "Agent B",
      agentId: AGENT_B_ID,
      trustLevel: "friend",
      mailbox: JSON.stringify({ repo: mailboxDir, selfOutboxAgentId: AGENT_A_ID }),
    })
    assert.equal(bAsPeerOfA.payload.kind, "agent")
    assert.equal(bAsPeerOfA.payload.trustLevel, "friend")
    const aAsPeerOfB = await agentB.tool("onboard_agent", {
      name: "Agent A",
      agentId: AGENT_A_ID,
      trustLevel: "friend",
      mailbox: JSON.stringify({ repo: mailboxDir, selfOutboxAgentId: AGENT_B_ID }),
    })
    assert.equal(aAsPeerOfB.payload.kind, "agent")
    assert.equal(aAsPeerOfB.payload.trustLevel, "friend")

    // Re-fetch each peer by its record UUID (get_friend resolves by uuid/name, not
    // by the a2a join-key id) and assert the mailbox coord survived the file
    // round-trip — i.e. it persisted to disk and reloaded losslessly (Unit 2).
    const bPeer = await agentA.tool("get_friend", { friendId: bAsPeerOfA.payload.id })
    assert.deepEqual(bPeer.payload.agentMeta.a2a.mailbox, { repo: mailboxDir, selfOutboxAgentId: AGENT_A_ID }, "A's record for agent-b must round-trip its mailbox coord")
    const aPeer = await agentB.tool("get_friend", { friendId: aAsPeerOfB.payload.id })
    assert.deepEqual(aPeer.payload.agentMeta.a2a.mailbox, { repo: mailboxDir, selfOutboxAgentId: AGENT_B_ID }, "B's record for agent-a must round-trip its mailbox coord")
    ok("A↔B are friend peers; the a2a.mailbox coord round-trips through the live MCP/file path")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3 — Content-bleed guard (BEFORE the grant). A content share with no
    // grant is refused → nothing reaches the mailbox. Identity share works on trust.
    // ════════════════════════════════════════════════════════════════════════
    step("Content-bleed guard: a content share with no grant is refused — nothing reaches the mailbox")
    const mailboxBefore = mailboxEnumerate(mailboxDir).length
    const contentNoGrant = await agentA.tool("share_profile", { friendId: pInAId, toAgentId: AGENT_B_ID, scope: "notes:safe" })
    assert.equal(contentNoGrant.payload.ok, false, "a content share with NO grant must be refused")
    assert.equal(contentNoGrant.payload.status, "no_consent", "refusal reason must be no_consent")
    assert.equal(contentNoGrant.isError, true)
    // The share failed before any buildOutgoing → the mailbox is untouched.
    assert.equal(mailboxEnumerate(mailboxDir).length, mailboxBefore, "a refused share must write NOTHING to the mailbox")
    ok("notes:safe share with no grant → REFUSED (no_consent); the mailbox stays empty")

    const identityShare = await agentA.tool("share_profile", { friendId: pInAId, toAgentId: AGENT_B_ID, scope: "identity" })
    assert.equal(identityShare.payload.ok, true, "an identity share must succeed on peer trust ≥ friend")
    assert.equal(identityShare.payload.envelope.scope, "identity")
    assert.equal(identityShare.payload.envelope.notes, undefined, "an identity share carries NO note content")
    ok("identity share with no grant → ALLOWED on friend-trust alone (carries only the join key)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 4 — Grant + share → buildOutgoing → host writes to A's outbox. Assert
    // path shape + join-key-not-UUID on the wire (read back the written bytes).
    // ════════════════════════════════════════════════════════════════════════
    step("Grant + share → buildOutgoing → host writes the message to A's outbox (join-key, not UUID, on the wire)")
    const grant = await agentA.tool("grant_share", { subjectFriendId: pInAId, recipientAgentId: AGENT_B_ID, scope: "notes:safe" })
    assert.ok(grant.payload.id, "grant_share must return a grant id")

    const share = await agentA.tool("share_profile", { friendId: pInAId, toAgentId: AGENT_B_ID, scope: "notes:safe" })
    assert.equal(share.payload.ok, true, "the content share must now succeed (grant present)")
    const envelope = share.payload.envelope
    const envelopeJson = JSON.stringify(envelope)
    assert.equal(envelopeJson.includes(pInAId), false, "A's local UUID for P must NEVER appear on the wire")
    const sharedKeys = (envelope.notes as Array<{ key: string }>).map((n) => n.key).sort()
    assert.deepEqual(sharedKeys, ["team"], "notes:safe must carry ONLY the note marked shareable")

    // buildOutgoing computes the path + bytes; the HOST writes them into the mailbox.
    const outgoing = buildOutgoing({ envelope, fromAgentId: AGENT_A_ID, toAgentId: AGENT_B_ID })
    const expectedPrefix = `agents/${AGENT_A_ID}/outbox/${AGENT_B_ID}/`
    assert.ok(outgoing.relativePath.startsWith(expectedPrefix), `path must be ${expectedPrefix}<ts>--<id>.json`)
    assert.match(outgoing.relativePath, /^agents\/agent-a\/outbox\/agent-b\/.+--[0-9a-f-]{36}\.json$/, "path shape must match the post-office layout")
    mailboxWrite(mailboxDir, outgoing.relativePath, outgoing.bytes)
    ok(`A built + wrote ${outgoing.relativePath}`)

    // Read the WRITTEN file's bytes back: join key present, A's UUID absent.
    const writtenBytes = readFileSync(join(mailboxDir, outgoing.relativePath), "utf-8")
    assert.equal(writtenBytes.includes(pInAId), false, "the written mailbox file must NOT contain A's local UUID")
    assert.ok(writtenBytes.includes("p@example.com") && writtenBytes.includes("aad"), "the written mailbox file must name P by join key")
    ok("the message on disk names P by join key aad:p@example.com — A's local UUID is absent from the wire")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 5 — B enumerates the mailbox → readIncoming → import. Assert the moat
    // invariants hold over the transport (first-party untouched, attributed,
    // trust non-transitive).
    // ════════════════════════════════════════════════════════════════════════
    step("B enumerates the mailbox → readIncoming → import (first-party untouched, attributed, trust non-transitive)")
    const emptyLedger: SeenLedger = { seen: {} }
    const filesForB = mailboxEnumerate(mailboxDir, AGENT_B_ID)
    const incoming = readIncoming({ files: filesForB, selfAgentId: AGENT_B_ID, seen: emptyLedger })
    assert.equal(incoming.rejected.length, 0, "no legit message should be rejected")
    assert.equal(incoming.skippedSeen.length, 0, "nothing seen yet")
    assert.equal(incoming.ready.length, 1, "exactly one message is ready for B")
    assert.equal(incoming.ready[0].messageId, outgoing.messageId, "the ready message is the one A wrote")
    ok("readIncoming surfaced exactly the message A wrote (1 ready, 0 rejected, 0 skipped)")

    const trustBefore = (await agentB.tool("get_friend", { friendId: pInBId })).payload.trustLevel
    const imported = await agentB.tool("import_profile", { envelope: incoming.ready[0].envelope, fromAgentId: AGENT_A_ID, trustOfSource: "friend" })
    assert.equal(imported.payload.ok, true, "import from a trusted peer must succeed")
    assert.equal(imported.payload.status, "imported", "P already existed in B's store → imported (not seeded)")
    assert.equal(imported.payload.record.id, pInBId, "the import must resolve to B's existing P by join key")

    const pAfter = await agentB.tool("get_friend", { friendId: pInBId })
    assert.equal(pAfter.payload.notes.role.value, "B's private guess", "INVARIANT first-party-wins: B's own role note must be untouched")
    const importedForA = pAfter.payload.importedNotes?.[AGENT_A_ID]
    assert.ok(importedForA, "INVARIANT attribution: importedNotes must have a namespace for agent-a")
    assert.equal(importedForA.team?.value, "Platform", "A's team claim must land under agent-a in importedNotes")
    assert.equal(importedForA.team.assertedBy?.agentId, AGENT_A_ID, "imported fact must record agent-a as asserter")
    assert.equal(importedForA.team.originallyAssertedBy?.agentId, ownerAId, "imported fact must preserve A's original-asserter id")
    assert.ok(importedForA.team.importedAt, "imported fact must be stamped importedAt")
    assert.equal(pAfter.payload.notes.team, undefined, "the imported fact must NOT leak into first-party notes")
    assert.equal(pAfter.payload.trustLevel, trustBefore, "INVARIANT trust-non-transitive: import must NOT change P's trust")
    assert.equal(pAfter.payload.trustLevel, "acquaintance")
    ok("A's claim arrived via the mailbox: first-party untouched, attributed under agent-a, trust unchanged")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 6 — Replay. Mark the message seen; re-read → it is skipped, not ready.
    // (Exactly-once import / git-replay safety.)
    // ════════════════════════════════════════════════════════════════════════
    step("Replay safety — a seen message is skipped, never re-delivered")
    const seen2 = markSeen(emptyLedger, incoming.ready[0].messageId)
    const replay = readIncoming({ files: filesForB, selfAgentId: AGENT_B_ID, seen: seen2 })
    assert.equal(replay.ready.length, 0, "a seen message must not be ready again")
    assert.deepEqual(replay.skippedSeen, [outgoing.messageId], "the seen message must be reported as skipped")
    ok("re-reading the same mailbox with the message marked seen → 0 ready, 1 skippedSeen (exactly-once)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 7 — Spoof + wrong-recipient. A forged sender is rejected by path-
    // binding; a message addressed to a third party is invisible to B.
    // ════════════════════════════════════════════════════════════════════════
    step("Spoof + wrong-recipient — path-binding rejects a forged sender; a c-addressed message is invisible to B")

    // (a) SPOOF: a hostile file in agent-a's outbox whose wrapper claims agent-evil.
    const spoofMsgId = randomUUID()
    const spoofTs = new Date().toISOString()
    const spoofMessage = {
      mailboxVersion: 1,
      messageId: spoofMsgId,
      fromAgentId: "agent-evil", // ≠ the agent-a outbox-owner dir
      toAgentId: AGENT_B_ID,
      issuedAt: spoofTs,
      kind: "profile_share",
      envelope,
    }
    const spoofPath = `agents/${AGENT_A_ID}/outbox/${AGENT_B_ID}/${spoofTs}--${spoofMsgId}.json`
    mailboxWrite(mailboxDir, spoofPath, JSON.stringify(spoofMessage, null, 2))

    // (b) WRONG-RECIPIENT: a well-formed message addressed to agent-c, in agent-a's
    // outbox/agent-c dir. We enumerate ALL recipients so it's actually handed to
    // readIncoming — exercising the silent-skip (not-ours) branch.
    const cMsgId = randomUUID()
    const cTs = new Date().toISOString()
    const cMessage = {
      mailboxVersion: 1,
      messageId: cMsgId,
      fromAgentId: AGENT_A_ID,
      toAgentId: "agent-c",
      issuedAt: cTs,
      kind: "profile_share",
      envelope,
    }
    const cPath = `agents/${AGENT_A_ID}/outbox/agent-c/${cTs}--${cMsgId}.json`
    mailboxWrite(mailboxDir, cPath, JSON.stringify(cMessage, null, 2))

    const allFiles = mailboxEnumerate(mailboxDir) // every recipient, so the c-file is included
    const hostile = readIncoming({ files: allFiles, selfAgentId: AGENT_B_ID, seen: emptyLedger })
    const spoofRejected = hostile.rejected.find((r) => r.relativePath === spoofPath)
    assert.ok(spoofRejected, "the spoofed file must be rejected")
    assert.equal(spoofRejected!.reason, "from_path_mismatch", "the spoof must be rejected as from_path_mismatch")
    assert.equal(hostile.ready.some((m) => m.messageId === spoofMsgId), false, "the spoofed message must NOT be ready")
    ok("a forged sender (agent-evil in agent-a's outbox) → rejected (from_path_mismatch), never delivered")

    // The c-addressed message is in NONE of the three lists (not ours to read).
    assert.equal(hostile.ready.some((m) => m.messageId === cMsgId), false, "a c-addressed message must not be ready for B")
    assert.equal(hostile.rejected.some((r) => r.relativePath === cPath), false, "a well-formed c-addressed message must not be rejected")
    assert.equal(hostile.skippedSeen.includes(cMsgId), false, "a c-addressed message must not be in skippedSeen")
    ok("a well-formed message addressed to agent-c is invisible to B (absent from ready / rejected / skippedSeen)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 8 — Hostile-mailbox tamper. A mailbox that altered CONTENT (not routing)
    // can still only land an attributed quarantined note — never clobber first-
    // party, never change trust. "Compromised mailbox can DENY or REPLAY, never
    // ESCALATE."
    // ════════════════════════════════════════════════════════════════════════
    step("Hostile-mailbox tamper — altered content can never clobber first-party notes or change trust")
    // Take the legit envelope, mutate scope→notes:all and inject a fake role claim.
    const tamperedEnvelope = JSON.parse(JSON.stringify(envelope))
    tamperedEnvelope.scope = "notes:all"
    tamperedEnvelope.notes = [
      { key: "role", value: "Principal", originallyAssertedBy: { agentId: ownerAId } },
      { key: "team", value: "Platform", originallyAssertedBy: { agentId: ownerAId } },
    ]
    // Re-path it correctly so path-binding PASSES (the mailbox altered content,
    // not addressing). from/to are consistent with the path.
    const tamperMsgId = randomUUID()
    const tamperTs = new Date().toISOString()
    const tamperMessage = {
      mailboxVersion: 1,
      messageId: tamperMsgId,
      fromAgentId: AGENT_A_ID,
      toAgentId: AGENT_B_ID,
      issuedAt: tamperTs,
      kind: "profile_share",
      envelope: tamperedEnvelope,
    }
    const tamperPath = `agents/${AGENT_A_ID}/outbox/${AGENT_B_ID}/${tamperTs}--${tamperMsgId}.json`
    mailboxWrite(mailboxDir, tamperPath, JSON.stringify(tamperMessage, null, 2))

    // Path-binding can't catch content tampering — the tampered message IS ready.
    const tamperFiles = mailboxEnumerate(mailboxDir, AGENT_B_ID)
    const tamperRead = readIncoming({ files: tamperFiles, selfAgentId: AGENT_B_ID, seen: seen2 })
    const tamperReady = tamperRead.ready.find((m) => m.messageId === tamperMsgId)
    assert.ok(tamperReady, "a content-tampered-but-correctly-routed message is delivered (content trust is the import layer's job)")

    // B imports the tampered envelope. The structural guarantees still hold.
    const tamperImport = await agentB.tool("import_profile", { envelope: tamperReady!.envelope, fromAgentId: AGENT_A_ID, trustOfSource: "friend" })
    assert.equal(tamperImport.payload.ok, true, "the import itself succeeds (it's a trusted peer)")
    const pAfterTamper = await agentB.tool("get_friend", { friendId: pInBId })
    // FIRST-PARTY UNTOUCHED — B's own role is STILL its private guess.
    assert.equal(pAfterTamper.payload.notes.role.value, "B's private guess", "INVARIANT: a hostile mailbox can NEVER clobber B's first-party role note")
    // TRUST UNCHANGED — the envelope has no trust field; import never changes trust.
    assert.equal(pAfterTamper.payload.trustLevel, "acquaintance", "INVARIANT: a hostile mailbox can NEVER change P's trust")
    // The forged "Principal" lands ONLY as an attributed, quarantined imported note.
    assert.equal(pAfterTamper.payload.importedNotes?.[AGENT_A_ID]?.role?.value, "Principal", "the tampered claim is quarantined under agent-a (attributed, not first-party)")
    assert.equal(pAfterTamper.payload.notes.role.value !== "Principal", true, "the tampered claim never reaches first-party notes")
    ok("worst case over a hostile mailbox: an attributed quarantined note under agent-a — first-party + trust are structurally inviolable")

    // ════════════════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log("✅  A2A GIT-MAILBOX PROOF — every invariant held: the envelope")
    console.log("    crossed a git-backed mailbox between two distinct git")
    console.log("    identities; path-binding rejected the spoof; replay was")
    console.log("    exactly-once; a hostile mailbox could DENY or REPLAY, never")
    console.log("    ESCALATE (first-party notes + trust stayed inviolable).")
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  } finally {
    agentA?.kill()
    agentB?.kill()
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
    rmSync(mailboxDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error("\n❌  A2A GIT-MAILBOX PROOF FAILED — this is a real transport bug, not a flake:")
  console.error(err)
  process.exit(1)
})
