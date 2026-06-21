// Cross-agent mission ledger (shared work memory) — end-to-end proof (brick 3's capstone).
//
// The moat (examples/cross-agent-moat.ts) proves two DIFFERENT agents can agree a
// PERSON is the same and share — with consent, without clobber. This proof shows
// the same machinery re-aimed at a MISSION: two agents that did the same work
// (agreed by a `missionKey`) sharing what they collectively LEARNED, over the same
// harness-agnostic path — two independent `friends-mcp` processes exchanging a
// `MissionShareEnvelope`, carried as `kind:"mission_share"` over a git-backed
// mailbox (the brick-2 transport, here plain file I/O so the proof is hermetic).
//
// ZERO Ouroboros (or any harness) code is in the loop: the MCP side spawns the
// package's own built `dist/mcp/bin.js` twice; the transport side calls the pure
// `../src/a2a` fns. The only thing that crosses between the two stores is the
// envelope JSON, exactly as it would cross a network between two real agents.
//
// Every safety invariant is a HARD assert. Any violation throws → red banner,
// exit 1 — this proof exists precisely to catch a regression in the ledger.
//
//   Agent A  →  owns dirA  →  mission PROJ-1234: a SHAREABLE learning + a private one
//   Agent B  →  owns dirB  →  the SAME mission PROJ-1234 (different local UUID), B's own learning
//
// The invariants proven (see the numbered STEPs below):
//   • two separate stores            — A and B never share a directory
//   • join-key reference agreement   — both name the mission by `PROJ-1234`, never a local UUID
//   • tiered consent gate            — a mission share is refused without an explicit grant
//   • scope filtering                — `"mission"` carries only the `shareable` learning
//   • no-UUID-on-the-wire            — the envelope names the mission by missionKey, never A's local UUID
//   • kind:"mission_share" transport — the envelope crosses the mailbox as a mission_share wrapper
//   • first-party-wins               — B's own learning is untouched by the import
//   • attribution                    — A's learning lands under A's agentId in B's importedLearnings
//   • status non-transitive          — the import never changes the mission's status in B's store
//   • no laundering                  — the imported learning records A as asserter
//   • outcome merge + dedupe         — A's outcome lands stamped `imported`, deduped by (missionId,timestamp,assertedBy)
//   • revoke + audit                 — after revoke the mission share is refused again
//   • seeding gate                   — friend seeds a new mission; acquaintance/stranger cannot
//   • replay safety                  — a seen mailbox message is skipped
//   • hostile-mailbox tamper         — an altered learning/status lands only as a quarantined attributed note
//
// Run it:  npm run example:cross-agent-mission-memory
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { randomUUID } from "node:crypto"

import { buildOutgoing, readIncoming, markSeen } from "../src/mailbox"
import type { SeenLedger } from "../src/mailbox"

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
    // Each agent is its OWN process pointed at its OWN directory — the
    // two-separate-stores property that makes them genuinely two agents.
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

// The shared mission join key both agents use. This — never a local UUID — is the
// cross-agent currency. Generic, public-repo-safe.
const MISSION_KEY = "PROJ-1234"
const AGENT_A_ID = "agent-a"
const AGENT_B_ID = "agent-b"

/** Pre-seed a friend record JSON directly into a store dir BEFORE its server
 * starts — used to construct the owner/self records the agents resolve via whoami. */
function seedFriend(dir: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8")
}

/** Pre-seed a mission record JSON directly into a store's sibling `_missions/`
 * dir BEFORE its server starts — to build precise learning fixtures (with
 * `shareable` + first-party provenance) that the MCP `record_mission` surface
 * intentionally can't express at this fidelity. The live ledger flow (grant /
 * share / buildOutgoing / write / readIncoming / import) still runs entirely
 * through the two servers + the pure a2a fns. */
function seedMission(dir: string, record: Record<string, unknown>): void {
  const missionsDir = join(dir, "_missions")
  mkdirSync(missionsDir, { recursive: true })
  writeFileSync(join(missionsDir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8")
}

// ── The mailbox is just a directory. THIS host does the "git" (file I/O). ──

/** Write a message's bytes at its git-relative path under the mailbox root,
 * mkdir-ing the outbox dirs. The host's "git add + commit + push". */
function mailboxWrite(mailboxDir: string, relativePath: string, bytes: string): void {
  const abs = join(mailboxDir, relativePath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes, "utf-8")
}

/** Enumerate the mailbox (the host's "git pull" + walk). Returns every message
 * file under `agents/<from>/outbox/<to>/*.json`. `toFilter` narrows to one
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

async function main(): Promise<void> {
  const dirA = mkdtempSync(join(tmpdir(), "friends-mission-A-"))
  const dirB = mkdtempSync(join(tmpdir(), "friends-mission-B-"))
  const mailboxDir = mkdtempSync(join(tmpdir(), "friends-mission-mailbox-"))
  let agentA: Agent | undefined
  let agentB: Agent | undefined

  try {
    const now = new Date().toISOString()

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1 — Two stores, the SAME mission (same missionKey), different local
    // UUIDs. A has a shareable learning + a private one; B its own first-party
    // learning on the same key. Seeded on disk so we can mark learnings
    // `shareable` and stamp first-party provenance precisely.
    // ════════════════════════════════════════════════════════════════════════
    step("Both stores know mission PROJ-1234 by the same missionKey, each with its own first-party learnings")

    // Agent A's owner/self record — `family` so A's whoami resolves a stable self
    // identity (the asserter tag stamped on A's first-party shares).
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

    // Mission PROJ-1234 in A's store: a shareable learning + a NOT-shareable one +
    // a first-party outcome.
    const missionInAId = randomUUID()
    seedMission(dirA, {
      id: missionInAId,
      missionKey: MISSION_KEY,
      title: "Ship the mission ledger",
      status: "succeeded",
      participants: [{ agentId: AGENT_A_ID }],
      outcomes: [{ missionId: missionInAId, result: "success", timestamp: now, note: "A's first-party outcome" }],
      learnings: {
        approach: {
          value: "rebase, never merge",
          savedAt: now,
          shareable: true, // ← the ONLY learning a "mission" share may carry
          provenance: { origin: "first_party" },
        },
        secret: {
          value: "internal-only detail",
          savedAt: now,
          shareable: false, // ← must be WITHHELD from a "mission" share
          provenance: { origin: "first_party" },
        },
      },
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    })

    // Agent B's owner/self record (different owner — different store).
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

    // The SAME mission PROJ-1234 in B's store (same missionKey) — but with B's OWN
    // first-party learning under the SAME key `approach`. This is what the import
    // must NOT clobber.
    const missionInBId = randomUUID()
    seedMission(dirB, {
      id: missionInBId,
      missionKey: MISSION_KEY,
      title: "Ship the mission ledger",
      status: "active",
      participants: [{ agentId: AGENT_B_ID }],
      outcomes: [],
      learnings: {
        approach: {
          value: "B's own private read on the approach",
          savedAt: now,
          shareable: false,
          provenance: { origin: "first_party" },
        },
      },
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    })

    assert.notEqual(missionInAId, missionInBId, "the two stores must give the mission different local UUIDs")
    ok(`Agent A store knows PROJ-1234 (local id ${missionInAId.slice(0, 8)}…) with a shareable + a private learning`)
    ok(`Agent B store knows PROJ-1234 (local id ${missionInBId.slice(0, 8)}…) with its own first-party learning`)
    ok("two SEPARATE stores; same missionKey PROJ-1234; different local UUIDs")

    agentA = new Agent("A", dirA)
    agentB = new Agent("B", dirB)
    await agentA.initialize()
    await agentB.initialize()

    // Confirm each agent reads only its OWN mission, and whoami resolves each owner.
    const aSeesMission = await agentA.tool("get_mission", { missionId: missionInAId })
    assert.equal(aSeesMission.payload.learnings.approach.value, "rebase, never merge")
    const bSeesMission = await agentB.tool("get_mission", { missionId: missionInBId })
    assert.equal(bSeesMission.payload.learnings.approach.value, "B's own private read on the approach")
    const whoA = await agentA.tool("whoami", {})
    const whoB = await agentB.tool("whoami", {})
    assert.equal(whoA.payload.selfFriendId, ownerAId, "Agent A's whoami must resolve Owner A")
    assert.equal(whoB.payload.selfFriendId, ownerBId, "Agent B's whoami must resolve Owner B")
    ok("each agent's MCP server sees only its own mission; whoami resolves each owner")

    // Mutual onboard at `friend` WITH mailbox coords (the relationship the consent
    // layer gates on + the transport coordinates).
    const bAsPeerOfA = await agentA.tool("onboard_agent", {
      name: "Agent B",
      agentId: AGENT_B_ID,
      trustLevel: "friend",
      mailbox: JSON.stringify({ repo: mailboxDir, selfOutboxAgentId: AGENT_A_ID }),
    })
    assert.equal(bAsPeerOfA.payload.trustLevel, "friend")
    const aAsPeerOfB = await agentB.tool("onboard_agent", {
      name: "Agent A",
      agentId: AGENT_A_ID,
      trustLevel: "friend",
      mailbox: JSON.stringify({ repo: mailboxDir, selfOutboxAgentId: AGENT_B_ID }),
    })
    assert.equal(aAsPeerOfB.payload.trustLevel, "friend")
    ok("A↔B are friend peers with git-mailbox coords")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2 — Tiered consent gate. A "mission" share to B with NO grant is
    // REFUSED (no_consent) — a mission carries content, so it needs a grant.
    // ════════════════════════════════════════════════════════════════════════
    step("Consent gate (tiered): a mission share with no grant is refused")
    const noGrant = await agentA.tool("share_mission", { missionId: missionInAId, toAgentId: AGENT_B_ID, scope: "mission" })
    assert.equal(noGrant.payload.ok, false, "a mission share with NO grant must be refused")
    assert.equal(noGrant.payload.status, "no_consent", "refusal reason must be no_consent")
    assert.equal(noGrant.isError, true)
    ok("mission share with no grant → REFUSED (no_consent)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3 — A grants B a mission share (subject = the missionKey), then PREPARES
    // it → envelope. Assert: names the mission by missionKey (never A's local UUID);
    // only the shareable learning carried; attributed to A.
    // ════════════════════════════════════════════════════════════════════════
    step("A grants B a mission share, then prepares the envelope (missionKey only, shareable-only, attributed)")
    const grant = await agentA.tool("grant_share", { subjectKey: MISSION_KEY, recipientAgentId: AGENT_B_ID, scope: "mission" })
    const grantId = grant.payload.id as string
    assert.ok(grantId, "grant_share must return a grant id")
    ok(`A granted B a "mission" share of PROJ-1234 (grant ${grantId.slice(0, 8)}…)`)

    const share = await agentA.tool("share_mission", { missionId: missionInAId, toAgentId: AGENT_B_ID, scope: "mission" })
    assert.equal(share.payload.ok, true, "the mission share must now succeed (grant present)")
    const envelope = share.payload.envelope
    const envelopeJson = JSON.stringify(envelope)

    // Names the mission by missionKey, never A's local UUID.
    assert.equal(envelope.subject.missionKey, MISSION_KEY, "envelope must name the mission by its missionKey")
    assert.equal(envelope.subject.title, "Ship the mission ledger")
    assert.equal(envelopeJson.includes(missionInAId), false, "A's local UUID for the mission must NEVER appear on the wire")
    ok("envelope names the mission by missionKey PROJ-1234 — A's local UUID is absent from the wire")

    // "mission" ⇒ only the shareable learning. `approach` (shareable) present;
    // `secret` (not shareable) withheld.
    const sharedKeys = (envelope.learnings as Array<{ key: string }>).map((l) => l.key).sort()
    assert.deepEqual(sharedKeys, ["approach"], "a mission share must carry ONLY the learning marked shareable")
    const approachLearning = (envelope.learnings as Array<{ key: string; value: string }>).find((l) => l.key === "approach")
    assert.equal(approachLearning?.value, "rebase, never merge")
    assert.equal(envelopeJson.includes("internal-only detail"), false, "the non-shareable learning must be WITHHELD")
    ok("the share carried ONLY the shareable learning (approach); the private one was withheld")

    // Attributed to A as the original asserter (no laundering).
    assert.equal((approachLearning as any).originallyAssertedBy?.agentId, ownerAId, "shared first-party learning must be attributed to A's self id")
    ok("the shared learning is attributed to Agent A as original asserter")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 4 — The envelope crosses via kind:"mission_share" over the mailbox.
    // buildOutgoing computes the path + bytes; the host writes them; B enumerates +
    // readIncoming surfaces kind:"mission_share"; path-binding holds; no UUID on wire.
    // ════════════════════════════════════════════════════════════════════════
    step("Cross via kind:\"mission_share\" over the mailbox (path-binding holds; no UUID on the wire)")
    const outgoing = buildOutgoing({ envelope, fromAgentId: AGENT_A_ID, toAgentId: AGENT_B_ID, kind: "mission_share" })
    assert.match(outgoing.relativePath, /^agents\/agent-a\/outbox\/agent-b\/.+--[0-9a-f-]{36}\.json$/, "path shape must match the post-office layout")
    mailboxWrite(mailboxDir, outgoing.relativePath, outgoing.bytes)

    // The written wrapper is a mission_share carrying the mission by missionKey.
    const writtenBytes = readFileSync(join(mailboxDir, outgoing.relativePath), "utf-8")
    assert.ok(writtenBytes.includes("\"kind\": \"mission_share\""), "the wrapper on disk must be kind:mission_share")
    assert.equal(writtenBytes.includes(missionInAId), false, "the written mailbox file must NOT contain A's local UUID")
    assert.ok(writtenBytes.includes(MISSION_KEY), "the written mailbox file must name the mission by missionKey")
    ok(`A built + wrote ${outgoing.relativePath} as kind:mission_share (missionKey on the wire, not the UUID)`)

    const emptyLedger: SeenLedger = { seen: {} }
    const filesForB = mailboxEnumerate(mailboxDir, AGENT_B_ID)
    const incoming = readIncoming({ files: filesForB, selfAgentId: AGENT_B_ID, seen: emptyLedger })
    assert.equal(incoming.rejected.length, 0, "no legit message should be rejected")
    assert.equal(incoming.ready.length, 1, "exactly one message is ready for B")
    assert.equal(incoming.ready[0].kind, "mission_share", "readIncoming must surface kind:mission_share")
    assert.equal(incoming.ready[0].messageId, outgoing.messageId, "the ready message is the one A wrote")
    ok("readIncoming surfaced exactly one ready message with kind:mission_share (path-binding held)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 5 — B imports the envelope. Assert first-party-wins, attribution,
    // status non-transitive, no laundering — against B's OWN store.
    // ════════════════════════════════════════════════════════════════════════
    step("B imports the envelope — first-party-wins, attribution, status non-transitive, no laundering")
    const before = await agentB.tool("get_mission", { missionId: missionInBId })
    const statusBefore = before.payload.status as string
    const approachBefore = before.payload.learnings.approach.value as string
    assert.equal(approachBefore, "B's own private read on the approach")

    const imported = await agentB.tool("import_mission", { envelope: incoming.ready[0].envelope, fromAgentId: AGENT_A_ID, trustOfSource: "friend" })
    assert.equal(imported.payload.ok, true, "import from a trusted peer must succeed")
    assert.equal(imported.payload.status, "imported", "the mission already existed in B's store → imported (not seeded)")
    assert.equal(imported.payload.record.id, missionInBId, "the import must resolve to B's existing mission by missionKey")
    ok("B resolved the envelope to its existing mission by missionKey and imported it")

    const after = await agentB.tool("get_mission", { missionId: missionInBId })

    // (a) FIRST-PARTY WINS — B's own `approach` learning is byte-for-byte untouched.
    assert.equal(after.payload.learnings.approach.value, "B's own private read on the approach", "INVARIANT first-party-wins: B's own learning must be untouched")
    assert.equal(after.payload.learnings.approach.value, approachBefore)
    ok("first-party-wins: B's `approach` learning is STILL its own (untouched by the import)")

    // (b) ATTRIBUTION — A's `approach` learning lives in importedLearnings under A's agentId.
    const importedForA = after.payload.importedLearnings?.[AGENT_A_ID]
    assert.ok(importedForA, "INVARIANT attribution: importedLearnings must have a namespace for agent-a")
    assert.equal(importedForA.approach?.value, "rebase, never merge", "A's learning must land under agent-a in importedLearnings")
    ok("attribution: A's `approach` learning landed under importedLearnings[agent-a] — not in first-party learnings")

    // (c) STATUS NON-TRANSITIVE — the mission's status in B's store is UNCHANGED
    // (A's mission was "succeeded"; B's stays "active").
    assert.equal(after.payload.status, statusBefore, "INVARIANT status-non-transitive: import must NOT change the mission's status")
    assert.equal(after.payload.status, "active")
    ok(`status non-transitive: the mission's status is STILL "${statusBefore}" (A's "succeeded" did not leak in)`)

    // (d) NO LAUNDERING — the imported learning records A as asserter.
    assert.equal(importedForA.approach.assertedBy?.agentId, AGENT_A_ID, "INVARIANT no-laundering: imported learning must record agent-a as asserter")
    assert.equal(importedForA.approach.originallyAssertedBy?.agentId, ownerAId, "imported learning must preserve A's original-asserter id")
    assert.ok(importedForA.approach.importedAt, "imported learning must be stamped importedAt")
    ok("no laundering: the imported learning records A as asserter + carries importedAt")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 6 — Outcome merge + dedupe. A shares its OUTCOMES; B imports them; A's
    // row lands stamped `imported`, deduped by (missionId, timestamp, assertedBy).
    // A re-import is idempotent (no duplicate row).
    // ════════════════════════════════════════════════════════════════════════
    step("Outcome merge: A's outcome lands stamped imported, deduped by (missionId,timestamp,assertedBy)")
    // A grants + shares the OUTCOMES scope (a second grant — different scope).
    await agentA.tool("grant_share", { subjectKey: MISSION_KEY, recipientAgentId: AGENT_B_ID, scope: "outcomes" })
    const outcomeShare = await agentA.tool("share_mission", { missionId: missionInAId, toAgentId: AGENT_B_ID, scope: "outcomes" })
    assert.equal(outcomeShare.payload.ok, true, "the outcomes share must succeed (grant present)")
    assert.equal(outcomeShare.payload.envelope.outcomes.length, 1, "the outcomes envelope carries A's first-party outcome")

    const importOutcome1 = await agentB.tool("import_mission", { envelope: outcomeShare.payload.envelope, fromAgentId: AGENT_A_ID, trustOfSource: "friend" })
    assert.equal(importOutcome1.payload.ok, true)
    const afterOutcome = await agentB.tool("get_mission", { missionId: missionInBId })
    assert.equal(afterOutcome.payload.outcomes.length, 1, "A's outcome must be appended to B's (B had none)")
    const importedOutcome = afterOutcome.payload.outcomes[0]
    assert.equal(importedOutcome.provenance?.origin, "imported", "the imported outcome must be stamped origin:imported")
    assert.equal(importedOutcome.provenance?.assertedBy?.agentId, AGENT_A_ID, "the imported outcome must be attributed to agent-a")
    ok("A's outcome landed in B's store stamped origin:imported, attributed to agent-a")

    // Re-import the SAME outcomes envelope → idempotent (deduped by (missionId,timestamp,assertedBy.agentId)).
    const importOutcome2 = await agentB.tool("import_mission", { envelope: outcomeShare.payload.envelope, fromAgentId: AGENT_A_ID, trustOfSource: "friend" })
    assert.equal(importOutcome2.payload.ok, true)
    const afterReimport = await agentB.tool("get_mission", { missionId: missionInBId })
    assert.equal(afterReimport.payload.outcomes.length, 1, "INVARIANT dedupe: a same-peer re-import must NOT duplicate the outcome row")
    ok("re-importing the same outcome is idempotent (deduped — still exactly 1 row)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 7 — Revoke + audit. After revoke, a subsequent mission share is refused.
    // ════════════════════════════════════════════════════════════════════════
    step("Revoke + audit — after revoke, the mission share is refused again")
    const sharesBefore = await agentA.tool("list_shares", { subjectKey: MISSION_KEY })
    const listed = sharesBefore.payload as Array<{ id: string; effective: boolean; scope: string }>
    const theMissionGrant = listed.find((g) => g.id === grantId)
    assert.ok(theMissionGrant, "list_shares must surface the mission grant")
    assert.equal(theMissionGrant!.effective, true, "the grant must be effective before revoke")
    ok(`list_shares shows the mission grant as effective (scope ${theMissionGrant!.scope})`)

    const revoked = await agentA.tool("revoke_share", { grantId })
    assert.equal(revoked.payload.status, "revoked", "revoke_share must tombstone the grant")
    const afterRevoke = await agentA.tool("share_mission", { missionId: missionInAId, toAgentId: AGENT_B_ID, scope: "mission" })
    assert.equal(afterRevoke.payload.ok, false, "a mission share after revoke must be refused")
    assert.equal(afterRevoke.payload.status, "no_consent", "post-revoke refusal must be no_consent")
    ok("after revoke, the mission share is REFUSED again (no_consent) — consent is revocable")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 8 — Seeding gate at 3 trust levels. Only a friend/family peer may
    // introduce a previously-UNKNOWN mission (seeded active/empty). Each sub-case
    // uses a DISTINCT unknown missionKey so the cases never shadow one another.
    // ════════════════════════════════════════════════════════════════════════
    step("Seeding gate — only a friend/family peer may seed a NEW mission")

    function introEnvelopeFor(missionKey: string): Record<string, unknown> {
      return {
        subject: { missionKey, title: `Mission ${missionKey}` },
        fromAgentId: AGENT_A_ID,
        scope: "mission",
        learnings: [{ key: "intro", value: "introduced learning", originallyAssertedBy: { agentId: ownerAId } }],
        issuedAt: now,
      }
    }

    // (a) STRANGER source → REFUSED at the acceptance cap (its facts never count).
    const strangerKey = "repo#stranger"
    const strangerIntro = await agentB.tool("import_mission", { envelope: introEnvelopeFor(strangerKey), fromAgentId: "agent-stranger", trustOfSource: "stranger" })
    assert.equal(strangerIntro.payload.ok, false, "a stranger source must not be able to seed a new mission")
    assert.equal(strangerIntro.payload.status, "untrusted_source", "a stranger source is refused at the acceptance cap")
    ok("stranger source introducing an unknown mission → REFUSED (untrusted_source)")

    // (b) ACQUAINTANCE source → passes the accept cap, but may NOT seed.
    const acqKey = "repo#acquaintance"
    const acqIntro = await agentB.tool("import_mission", { envelope: introEnvelopeFor(acqKey), fromAgentId: "agent-acq", trustOfSource: "acquaintance" })
    assert.equal(acqIntro.payload.ok, false, "an acquaintance source must not be able to seed a new mission")
    assert.equal(acqIntro.payload.status, "untrusted_introduction", "an acquaintance source is refused at the seeding gate")
    ok("acquaintance source introducing an unknown mission → REFUSED (untrusted_introduction)")

    // (c) FRIEND source → SEEDED, status active, empty first-party learnings.
    const friendKey = "repo#friend"
    const friendIntro = await agentB.tool("import_mission", { envelope: introEnvelopeFor(friendKey), fromAgentId: AGENT_A_ID, trustOfSource: "friend" })
    assert.equal(friendIntro.payload.ok, true, "a friend source must be able to introduce a new mission")
    assert.equal(friendIntro.payload.status, "seeded", "a friend introduction of an unknown mission must be seeded")
    assert.equal(friendIntro.payload.record.status, "active", "a seeded mission must start active")
    assert.deepEqual(friendIntro.payload.record.learnings, {}, "a seeded mission must start with empty first-party learnings")
    assert.equal(friendIntro.payload.record.importedLearnings[AGENT_A_ID].intro.value, "introduced learning", "the introduced learning lands in the imported namespace")
    ok("friend source introducing an unknown mission → SEEDED (status active, empty first-party learnings)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 9 — Replay safety. Mark the original mission_share message seen; re-read
    // → it is skipped, not ready. (Exactly-once import / git-replay safety.)
    // ════════════════════════════════════════════════════════════════════════
    step("Replay safety — a seen mission_share message is skipped, never re-delivered")
    const seen2 = markSeen(emptyLedger, outgoing.messageId)
    const replay = readIncoming({ files: filesForB, selfAgentId: AGENT_B_ID, seen: seen2 })
    assert.equal(replay.ready.length, 0, "a seen message must not be ready again")
    assert.deepEqual(replay.skippedSeen, [outgoing.messageId], "the seen message must be reported as skipped")
    ok("re-reading the same mailbox with the message marked seen → 0 ready, 1 skippedSeen (exactly-once)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 10 — Hostile-mailbox tamper. A mailbox that altered CONTENT (not routing)
    // can still only land an attributed quarantined learning — never clobber first-
    // party, never change status. "Compromised mailbox can DENY or REPLAY, never ESCALATE."
    // ════════════════════════════════════════════════════════════════════════
    step("Hostile-mailbox tamper — altered content can never clobber first-party learnings or change status")
    // Take the legit envelope, inject a fake first-party-key learning + a status claim.
    const tamperedEnvelope = JSON.parse(JSON.stringify(envelope))
    tamperedEnvelope.learnings = [
      { key: "approach", value: "TAMPERED approach", originallyAssertedBy: { agentId: ownerAId } },
    ]
    // A status field on the envelope is meaningless (mission shares don't carry one) —
    // assert the import ignores any such attempt by leaving B's status untouched.
    tamperedEnvelope.status = "failed"
    const tamperMsgId = randomUUID()
    const tamperTs = new Date().toISOString()
    const tamperMessage = {
      mailboxVersion: 1,
      messageId: tamperMsgId,
      fromAgentId: AGENT_A_ID,
      toAgentId: AGENT_B_ID,
      issuedAt: tamperTs,
      kind: "mission_share",
      envelope: tamperedEnvelope,
    }
    const tamperPath = `agents/${AGENT_A_ID}/outbox/${AGENT_B_ID}/${tamperTs}--${tamperMsgId}.json`
    mailboxWrite(mailboxDir, tamperPath, JSON.stringify(tamperMessage, null, 2))

    // Path-binding can't catch content tampering — the tampered message IS ready.
    const tamperFiles = mailboxEnumerate(mailboxDir, AGENT_B_ID)
    const tamperRead = readIncoming({ files: tamperFiles, selfAgentId: AGENT_B_ID, seen: seen2 })
    const tamperReady = tamperRead.ready.find((m) => m.messageId === tamperMsgId)
    assert.ok(tamperReady, "a content-tampered-but-correctly-routed message is delivered (content trust is the import layer's job)")

    const statusBeforeTamper = (await agentB.tool("get_mission", { missionId: missionInBId })).payload.status
    const tamperImport = await agentB.tool("import_mission", { envelope: tamperReady!.envelope, fromAgentId: AGENT_A_ID, trustOfSource: "friend" })
    assert.equal(tamperImport.payload.ok, true, "the import itself succeeds (it's a trusted peer)")
    const afterTamper = await agentB.tool("get_mission", { missionId: missionInBId })
    // FIRST-PARTY UNTOUCHED — B's own `approach` is STILL its own.
    assert.equal(afterTamper.payload.learnings.approach.value, "B's own private read on the approach", "INVARIANT: a hostile mailbox can NEVER clobber B's first-party learning")
    // STATUS UNCHANGED — import never recomputes status.
    assert.equal(afterTamper.payload.status, statusBeforeTamper, "INVARIANT: a hostile mailbox can NEVER change the mission's status")
    assert.equal(afterTamper.payload.status, "active")
    // The forged "TAMPERED approach" lands ONLY as the attributed quarantined imported learning.
    assert.equal(afterTamper.payload.importedLearnings?.[AGENT_A_ID]?.approach?.value, "TAMPERED approach", "the tampered claim is quarantined under agent-a (attributed, not first-party)")
    assert.notEqual(afterTamper.payload.learnings.approach.value, "TAMPERED approach", "the tampered claim never reaches first-party learnings")
    ok("worst case over a hostile mailbox: an attributed quarantined learning under agent-a — first-party + status are structurally inviolable")

    // ════════════════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log("✅  CROSS-AGENT MISSION LEDGER PROVEN — two agents co-remembered a")
    console.log("    shared mission over the MCP wire + a kind:\"mission_share\" mailbox:")
    console.log("    consent-gated, missionKey-not-UUID, first-party-wins, attributed,")
    console.log("    status non-transitive, outcomes deduped, seeding-gated, replay-safe,")
    console.log("    and inviolable against a hostile mailbox.")
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
  console.error("\n❌  MISSION LEDGER PROOF FAILED — this is a real safety regression, not a flake:")
  console.error(err)
  process.exit(1)
})
