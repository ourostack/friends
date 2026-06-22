// Cross-agent own-fleet DELEGATION — the LOCAL north-star proof (p11 increment 2).
//
// The north-star demo, proven LOCALLY: two of the OWNER'S OWN agents (A + B) on separate
// stores/processes (simulating two machines), roster-linked as same-owner `family` via
// `same_account`, get CONNECTED by the owner (connect_to), then:
//
//   A delegates a task to B  →  B performs it  →  B returns the RESULT to A
//
// over the already-built sealed transport (here the in-repo git-mailbox, hermetic +
// CI-runnable). Every invariant is a HARD assert — exit 0 = the own-fleet delegation
// mechanism works end-to-end; exit 1 (loud red banner) on any violation.
//
// ZERO Ouroboros (or any harness) code is in the loop: the MCP side spawns the package's
// own built `dist/mcp/bin.js` twice (A, B); the transport is the pure `../src/mailbox`
// fns; the roster/membership is the package's own `evaluateAccountMembership` +
// `ed25519RosterVerifier`. The only thing crossing between the stores is envelope JSON.
//
//   Agent A  →  owns dirA  →  delegates task PROJ-1234 to B (coordinate request + task-spec)
//   Agent B  →  owns dirB  →  performs it, returns a MissionResult deliverable to A
//
// The capabilities proven (see the numbered STEPs below):
//   • two separate stores            — A, B never share a directory (two machines)
//   • same-account family            — a SIGNED roster on both stores → evaluateAccountMembership
//                                       → family_same_account on BOTH sides (real ed25519)
//   • owner connect_to               — the owner links A↔B on the owner-only stdio path (local
//                                       management sense) → action:"connect" control-plane audit
//   • delegate (task-spec)           — A's coordinate request carries a task; B imports it
//                                       quarantined under importedDelegations (first-party untouched)
//   • return (result-return)         — B's MissionResult crosses kind:"mission_result"; A imports it
//                                       quarantined under importedResults, attributed to B, correlated
//   • every safety invariant         — no UUID on the wire, first-party inviolable, trust cap bites,
//                                       orphan-result rejected, replay inert, no third-party leak
//
// Run it:  npm run example:cross-agent-delegation
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { randomUUID } from "node:crypto"

import { buildOutgoing, readIncoming, markSeen } from "../src/mailbox"
import type { SeenLedger } from "../src/mailbox"
import { evaluateAccountMembership, verifiedCandidate, MemoryRosterStore, machineOwnerUsername } from "../src"
import type { AccountRoster } from "../src"
import { ready, signRoster, ed25519RosterVerifier, ed25519PubToDidKey } from "../src/a2a-client"

// The built MCP entrypoint. The npm script runs `npm run build` first so it exists.
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
    // two-separate-stores property that makes them genuinely two agents (two machines).
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
// The mailbox routing agentIds. Each owner's record `id` EQUALS its routing agentId, so
// whoami(self).selfFriendId === the routing id — the producer's first-party records and
// the peer's imported records then name the holder by the SAME string across stores.
const AGENT_A_ID = "agent-a"
const AGENT_B_ID = "agent-b"
// The shared owner account id (same owner owns A + B — that is the whole point).
const ACCOUNT_ID = "owner-account-1"

/** Pre-seed a friend record JSON directly into a store dir BEFORE its server starts. */
function seedFriend(dir: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8")
}

/** Pre-seed a mission record JSON directly into a store's sibling `_missions/` dir. */
function seedMission(dir: string, record: Record<string, unknown>): void {
  const missionsDir = join(dir, "_missions")
  mkdirSync(missionsDir, { recursive: true })
  writeFileSync(join(missionsDir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8")
}

/** An owner/self record whose `id` IS its routing agentId. Its `local` externalId is
 * the REAL OS user so whoami resolves it by the PRIMARY local-id match — deterministic
 * even after connect_to adds `family` peer records (the family-fallback alone would be
 * ambiguous once two family records exist). `family` too (the owner is never a stranger).
 * `ownerExternalId` is kept as a second local id for provenance/readability. */
function ownerRecord(agentId: string, ownerExternalId: string, now: string): Record<string, unknown> {
  const osUser = machineOwnerUsername()
  const localIds = [{ provider: "local", externalId: ownerExternalId, linkedAt: now }]
  // Add the real OS user as a local id so whoami's isLocalMachineOwnerIdentity match
  // finds THIS record first (independent of the family-fallback ordering).
  if (osUser && osUser !== ownerExternalId) {
    localIds.push({ provider: "local", externalId: osUser, linkedAt: now })
  }
  return {
    id: agentId,
    name: `Owner ${agentId}`,
    role: "primary",
    trustLevel: "family",
    externalIds: localIds,
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

/** The SAME mission by missionKey, with a distinct local UUID + a first-party learning +
 * status the delegation flow must leave physically untouched. */
function missionRecord(localId: string, now: string): Record<string, unknown> {
  return {
    id: localId,
    missionKey: MISSION_KEY,
    title: "Ship the delegation brick",
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

/** Read the control-plane audit log a spawned server wrote (the FileAuditSink JSONL at
 * `<dir>/_audit/control.jsonl`). Returns [] when the file does not exist yet. */
function readAuditRecords(dir: string): Array<Record<string, unknown>> {
  const auditPath = join(dir, "_audit", "control.jsonl")
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, "utf-8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function main(): Promise<void> {
  const sodium = await ready()
  const dirA = mkdtempSync(join(tmpdir(), "friends-deleg-A-"))
  const dirB = mkdtempSync(join(tmpdir(), "friends-deleg-B-"))
  const mailboxDir = mkdtempSync(join(tmpdir(), "friends-deleg-mailbox-"))
  let agentA: (Agent & { agentId: string }) | undefined
  let agentB: (Agent & { agentId: string }) | undefined

  try {
    const now = new Date().toISOString()

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1 — Two stores, the SAME mission (same missionKey), different local
    // UUIDs. Each owner's record id == its routing agentId (whoami self == mailbox id).
    // ════════════════════════════════════════════════════════════════════════
    step("Two separate stores (two machines) know mission PROJ-1234 by the same missionKey")

    seedFriend(dirA, ownerRecord(AGENT_A_ID, "owner-a", now))
    seedFriend(dirB, ownerRecord(AGENT_B_ID, "owner-b", now))

    const missionInA = randomUUID()
    const missionInB = randomUUID()
    seedMission(dirA, missionRecord(missionInA, now))
    seedMission(dirB, missionRecord(missionInB, now))
    assert.ok(missionInA !== missionInB, "each store must give the mission a distinct local UUID")
    ok(`two stores, same missionKey ${MISSION_KEY}, distinct local UUIDs`)

    agentA = Object.assign(new Agent("A", dirA), { agentId: AGENT_A_ID })
    agentB = Object.assign(new Agent("B", dirB), { agentId: AGENT_B_ID })
    await agentA.initialize()
    await agentB.initialize()

    // whoami resolves each owner to an id == its routing agentId.
    assert.equal((await agentA.tool("whoami", {})).payload.selfFriendId, AGENT_A_ID)
    assert.equal((await agentB.tool("whoami", {})).payload.selfFriendId, AGENT_B_ID)
    ok("both MCP servers up; whoami resolves each owner's self to its routing id")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2 — Same-account FAMILY via a SIGNED account roster. The owner's account
    // signs a roster listing BOTH A's and B's DIDs; evaluateAccountMembership (the
    // increment-1 payoff) grants `family_same_account` ONLY for a key-verified, in-roster,
    // DID-control-proven candidate — asserted on BOTH sides with the real ed25519 verifier.
    // (The MCP resolve_party does NOT wire a roster context — matching increment-1, the
    // proof asserts membership directly via the library, exactly as the owner's harness would.)
    // ════════════════════════════════════════════════════════════════════════
    step("Same-account family — a SIGNED roster → evaluateAccountMembership → family_same_account on BOTH sides")

    // A real account signing key + per-agent did:key identities (A, B).
    const accountKp = sodium.crypto_sign_keypair()
    const rosterKey = sodium.to_base64(accountKp.publicKey, sodium.base64_variants.ORIGINAL)
    const aKp = sodium.crypto_sign_keypair()
    const bKp = sodium.crypto_sign_keypair()
    const aDid = ed25519PubToDidKey(aKp.publicKey)
    const bDid = ed25519PubToDidKey(bKp.publicKey)
    assert.ok(aDid.startsWith("did:key:") && bDid.startsWith("did:key:"), "both agents have did:key identities")

    // The owner's account roster lists BOTH agents; the account key signs it (epoch 1).
    const rosterBody = { accountId: ACCOUNT_ID, members: [{ handle: AGENT_A_ID, did: aDid }, { handle: AGENT_B_ID, did: bDid }], epoch: 1 }
    const rosterSig = signRoster({ sodium, accountKeyPriv: accountKp.privateKey, roster: rosterBody })
    const roster: AccountRoster = { ...rosterBody, sig: rosterSig }
    const verifier = ed25519RosterVerifier(sodium)

    // A's side evaluates B (the candidate whose DID-control A has authenticated out of band):
    // a fresh TOFU roster-store pins the account key on first contact, the ed25519 verifier
    // (grantsFamily:true) accepts the signed roster, B's DID is in it → family_same_account.
    const membershipBfromA = await evaluateAccountMembership({
      roster,
      candidate: verifiedCandidate(bDid),
      rosterKey,
      store: new MemoryRosterStore(),
      verifier,
    })
    assert.equal(membershipBfromA.decision, "family_same_account", "A must recognize B as same-account family (not unverified/not_member)")
    ok(`A → B: ${membershipBfromA.decision} (signed roster, real ed25519, B's did in the roster)`)

    // B's side evaluates A symmetrically.
    const membershipAfromB = await evaluateAccountMembership({
      roster,
      candidate: verifiedCandidate(aDid),
      rosterKey,
      store: new MemoryRosterStore(),
      verifier,
    })
    assert.equal(membershipAfromB.decision, "family_same_account", "B must recognize A as same-account family")
    ok(`B → A: ${membershipAfromB.decision}`)

    // Negative control: a stranger DID NOT in the roster is NOT family.
    const strangerDid = ed25519PubToDidKey(sodium.crypto_sign_keypair().publicKey)
    const strangerMembership = await evaluateAccountMembership({
      roster,
      candidate: verifiedCandidate(strangerDid),
      rosterKey,
      store: new MemoryRosterStore(),
      verifier,
    })
    assert.equal(strangerMembership.decision, "not_member", "a DID absent from the roster must NOT be family (not_member)")
    ok(`stranger DID absent from roster → ${strangerMembership.decision} (the roster gate is real, not a blanket allow)`)
    // NOTE: the family peer records are NOT pre-seeded here — the owner's connect_to
    // (STEP 3) is what INTRODUCES each peer at `family`, which is the whole point of the
    // capability. aDid/bDid stay in scope for the connect_to + delegation steps below.

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3 — The owner LINKS A↔B via connect_to. On the owner-only stdio path the
    // dispatch supplies the gate a `local` management sense → COMMIT: each side upserts
    // the other as a `family` agent-peer AND writes an action:"connect" control-plane
    // audit record (read back from the FileAuditSink JSONL). A single connect_to operates
    // on ONE store; the owner runs the introduction on EACH side (the bidirectional link).
    // ════════════════════════════════════════════════════════════════════════
    step("Owner connect_to links A↔B — a local management-sense COMMIT + an action:\"connect\" audit on each side")

    // A's owner introduces B into A's fleet (with B's did so the link carries identity).
    const linkBintoA = await agentA.tool("connect_to", { agentId: AGENT_B_ID, did: bDid, name: `Peer ${AGENT_B_ID}` })
    assert.equal(linkBintoA.isError, false, "connect_to on the owner-only stdio path must COMMIT (local management sense)")
    assert.equal(linkBintoA.payload.ok, true, "connect_to returns ok:true")
    assert.equal(linkBintoA.payload.status, "connected", "connect_to status is connected")
    assert.equal(linkBintoA.payload.record.trustLevel, "family", "the linked own-fleet peer defaults to family")
    ok(`A connected B → ${linkBintoA.payload.status} at trust ${linkBintoA.payload.record.trustLevel}`)

    // B's owner introduces A into B's fleet (the other half of the bidirectional link).
    const linkAintoB = await agentB.tool("connect_to", { agentId: AGENT_A_ID, did: aDid, name: `Peer ${AGENT_A_ID}` })
    assert.equal(linkAintoB.payload.status, "connected", "B connected A")
    assert.equal(linkAintoB.payload.record.trustLevel, "family", "A is linked at family on B's side")
    ok(`B connected A → ${linkAintoB.payload.status} at trust ${linkAintoB.payload.record.trustLevel}`)

    // Assert the control-plane AUDIT — each side wrote exactly one action:"connect" record
    // (actor = the stdio owner boundary, originSense = "stdio").
    const auditA = readAuditRecords(dirA)
    const connectAuditA = auditA.find((r) => r.action === "connect")
    assert.ok(connectAuditA, "A's control-plane log must contain an action:connect record")
    assert.equal(connectAuditA!.level, "family", "the connect audit records the family link level")
    assert.equal(connectAuditA!.actor, "owner:stdio", "the connect audit attributes to the stdio owner boundary")
    assert.equal(connectAuditA!.originSense, "stdio", "the connect audit carries originSense stdio")
    const auditB = readAuditRecords(dirB)
    assert.ok(auditB.some((r) => r.action === "connect"), "B's control-plane log must contain an action:connect record")
    ok(`action:"connect" audit written on BOTH sides (actor owner:stdio, originSense stdio, level family)`)

    // The link is real + PERSISTED: re-resolve B's peer record (by its local id from the
    // connect_to result) from A's store on a fresh tool call — still a family agent-peer.
    const bPeerIdInA = linkBintoA.payload.record.id as string
    const bInA = await agentA.tool("get_friend", { friendId: bPeerIdInA })
    assert.equal(bInA.payload.trustLevel, "family", "A's store resolves B as a family peer after connect_to")
    assert.equal(bInA.payload.kind, "agent", "B is an agent-peer record")
    // and B's join-key agentId is on the record (the a2a-agent externalId the consent layer reads).
    assert.ok(
      (bInA.payload.externalIds as Array<{ provider: string; externalId: string }>).some((e) => e.provider === "a2a-agent" && e.externalId === AGENT_B_ID),
      "B's peer record is keyed by its routing agentId",
    )
    ok("A↔B are now linked own-fleet family peers (the introduce effect persisted)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 4 — The NORTH STAR: A delegates a task to B → B performs it → B returns
    // the result to A. The task-spec rides a coordination `request` (kind:"coordination");
    // the deliverable rides a result-return (kind:"mission_result"). Both cross the
    // in-repo mailbox. Each import lands QUARANTINED + attributed; the result correlates
    // to A's delegation by missionKey + requestId.
    // ════════════════════════════════════════════════════════════════════════
    step("A delegates (task-spec) → B performs → B returns the result → A imports it")

    // (1) A DELEGATES — a coordinate request carrying a task. The producer mints the
    // requestId and records the delegation first-party under A's delegations[requestId].
    const delegateOut = await agentA.tool("coordinate", {
      missionId: missionInA,
      toAgentId: AGENT_B_ID,
      intent: "request",
      note: "please audit the auth module",
      task: JSON.stringify({ summary: "Audit the auth module", details: "focus on the token path", inputs: { repo: "friends", pr: "12" } }),
    })
    assert.equal(delegateOut.isError, false, "A's delegation request must be consented (B is family)")
    const reqEnvelope = delegateOut.payload.envelope
    assert.ok(reqEnvelope.task, "the coordination request carries a task-spec")
    const requestId = reqEnvelope.task.requestId as string
    assert.ok(requestId && requestId.length > 0, "the producer minted a requestId")
    assert.equal(reqEnvelope.subject.missionKey, MISSION_KEY, "the request names the mission by missionKey")
    assert.equal(JSON.stringify(reqEnvelope).includes(missionInA), false, "A's local mission UUID must NOT be on the wire")
    ok(`A delegated task ${requestId} (mission named by missionKey, no local UUID on the wire)`)

    // A holds the delegation FIRST-PARTY (the correlation anchor the result-import checks).
    const aMissionAfterDelegate = (await agentA.tool("get_mission", { missionId: missionInA })).payload
    assert.ok(aMissionAfterDelegate.delegations && aMissionAfterDelegate.delegations[requestId], "A records the delegation first-party under delegations[requestId]")
    assert.equal(aMissionAfterDelegate.delegations[requestId].provenance.origin, "first_party", "A's delegation is first-party")
    ok(`A holds the delegation first-party under delegations[${requestId}] (the result-correlation anchor)`)

    // The request crosses the mailbox as kind:"coordination"; B reads + imports it.
    const reqMsg = buildOutgoing({ envelope: reqEnvelope, fromAgentId: AGENT_A_ID, toAgentId: AGENT_B_ID, kind: "coordination" })
    mailboxWrite(mailboxDir, reqMsg.relativePath, reqMsg.bytes)
    const reqFiles = mailboxEnumerate(mailboxDir, AGENT_B_ID)
    const reqReady = readIncoming({ files: reqFiles, selfAgentId: AGENT_B_ID, seen: { seen: {} } }).ready.find((m) => m.messageId === reqMsg.messageId)
    assert.ok(reqReady, "the coordination request is ready for B")
    assert.equal(reqReady!.kind, "coordination", "the request rides kind:coordination")
    const importDeleg = await agentB.tool("import_coordination", { envelope: reqReady!.envelope, fromAgentId: AGENT_A_ID, trustOfSource: "family" })
    assert.equal(importDeleg.payload.ok, true, "B imports A's delegation request")

    // B's store lands the task-spec QUARANTINED under importedDelegations[A][requestId].
    const bMissionAfterImport = (await agentB.tool("get_mission", { missionId: missionInB })).payload
    const landedTask = bMissionAfterImport.importedDelegations?.[AGENT_A_ID]?.[requestId]
    assert.ok(landedTask, "B lands the task-spec under importedDelegations[A][requestId] (quarantined)")
    assert.equal(landedTask.task.summary, "Audit the auth module", "the imported task carries B's brief")
    assert.equal(landedTask.provenance.origin, "imported", "the imported task is stamped origin:imported")
    assert.equal(landedTask.provenance.assertedBy.agentId, AGENT_A_ID, "the imported task is attributed to A")
    // B's first-party learnings are untouched by the import.
    assert.equal(bMissionAfterImport.learnings.gotcha.value, "rebase, never merge", "B's first-party learnings are untouched by the delegation import")
    ok(`B imported the task quarantined under importedDelegations[${AGENT_A_ID}][${requestId}] (attributed to A, first-party untouched)`)

    // (2) B PERFORMS it — the example FABRICATES B's deliverable (the proof is the
    // MECHANISM, not real work). B returns it via send_result, attributed to B,
    // correlated by missionKey + requestId.
    const sendOut = await agentB.tool("send_result", {
      missionId: missionInB,
      toAgentId: AGENT_A_ID,
      requestId,
      result: JSON.stringify({ summary: "Auth module audited: 2 findings (token replay, weak nonce)", outputs: { findings: "2", severity: "high" } }),
    })
    assert.equal(sendOut.isError, false, "B's result-return must be consented (A is family)")
    const resultEnvelope = sendOut.payload.envelope
    assert.equal(resultEnvelope.fromAgentId, AGENT_B_ID, "the result is attributed to B (fromAgentId)")
    assert.equal(resultEnvelope.requestId, requestId, "the result correlates to A's delegation by requestId")
    assert.equal(resultEnvelope.subject.missionKey, MISSION_KEY, "the result names the mission by missionKey")
    assert.equal(JSON.stringify(resultEnvelope).includes(missionInB), false, "B's local mission UUID must NOT be on the wire")
    ok(`B performed + returned result for ${requestId} (attributed to B, correlated, no local UUID on the wire)`)

    // (3) B RETURNS — the result crosses the mailbox as kind:"mission_result"; A reads it.
    const resMsg = buildOutgoing({ envelope: resultEnvelope, fromAgentId: AGENT_B_ID, toAgentId: AGENT_A_ID, kind: "mission_result" })
    mailboxWrite(mailboxDir, resMsg.relativePath, resMsg.bytes)
    const resFiles = mailboxEnumerate(mailboxDir, AGENT_A_ID)
    const resReady = readIncoming({ files: resFiles, selfAgentId: AGENT_A_ID, seen: { seen: {} } }).ready.find((m) => m.messageId === resMsg.messageId)
    assert.ok(resReady, "the result is ready for A")
    assert.equal(resReady!.kind, "mission_result", "the result rides kind:mission_result on the wire")
    ok(`B's result crossed the mailbox as kind:"mission_result"`)

    // A IMPORTS it — lands QUARANTINED under importedResults[B][requestId], attributed to B.
    const importRes = await agentA.tool("import_result", { envelope: resReady!.envelope, fromAgentId: AGENT_B_ID, trustOfSource: "family" })
    assert.equal(importRes.isError, false, "A imports B's result")
    assert.equal(importRes.payload.status, "imported", "the result import status is imported")

    const aMissionAfterResult = (await agentA.tool("get_mission", { missionId: missionInA })).payload
    const landedResult = aMissionAfterResult.importedResults?.[AGENT_B_ID]?.[requestId]
    assert.ok(landedResult, "A's store holds B's deliverable under importedResults[B][requestId]")
    assert.ok(landedResult.summary.includes("2 findings"), "the deliverable summary value is present")
    assert.equal(landedResult.provenance.origin, "imported", "the imported result is stamped origin:imported")
    assert.equal(landedResult.provenance.assertedBy.agentId, AGENT_B_ID, "the imported result is attributed to B")
    assert.equal(landedResult.requestId, requestId, "the imported result's requestId matches A's original delegation")
    // and it's correlated to A's first-party delegation.
    assert.ok(aMissionAfterResult.delegations[requestId], "A still holds the original first-party delegation the result correlates to")
    ok(`A imported B's deliverable under importedResults[${AGENT_B_ID}][${requestId}] — attributed to B, quarantined, correlated to A's delegation`)

    // ════════════════════════════════════════════════════════════════════════
    // STEP 5 — The full hard-assert INVARIANT BATTERY (the safety surface). Every
    // delegation/result guarantee that makes this safe, asserted; any violation throws.
    // ════════════════════════════════════════════════════════════════════════
    step("Invariant battery — first-party inviolable, trust cap, orphan-reject, replay-inert, no UUID/third-party leak")

    // (i) NO local mission UUID on ANY wire byte — walk every message in the mailbox.
    const allMail = mailboxEnumerate(mailboxDir)
    assert.ok(allMail.length >= 2, "the mailbox carried the request + the result")
    for (const file of allMail) {
      assert.equal(file.bytes.includes(missionInA), false, `${file.relativePath} must not leak A's local mission UUID`)
      assert.equal(file.bytes.includes(missionInB), false, `${file.relativePath} must not leak B's local mission UUID`)
      assert.ok(file.bytes.includes(MISSION_KEY), `${file.relativePath} names the mission by missionKey`)
    }
    ok(`walked ${allMail.length} wire messages — missionKey only, NO local UUID leaked`)

    // (ii) NO third-party / reputation field on any delegation or result wire byte.
    for (const file of allMail) {
      for (const banned of ['"standing"', '"tier"', '"familiarity"', '"totalTokens"']) {
        assert.equal(file.bytes.includes(banned), false, `${file.relativePath} must not carry ${banned}`)
      }
    }
    ok(`no standing/tier/third-party field on any delegation or result wire byte`)

    // (iii) FIRST-PARTY INVIOLABLE / non-transitive — after BOTH imports, A's + B's
    // first-party learnings + status are byte-untouched.
    const aMissionFinal = (await agentA.tool("get_mission", { missionId: missionInA })).payload
    const bMissionFinal = (await agentB.tool("get_mission", { missionId: missionInB })).payload
    assert.equal(aMissionFinal.status, "active", "A's mission status is untouched by the result import (non-transitive)")
    assert.equal(aMissionFinal.learnings.gotcha.value, "rebase, never merge", "A's first-party learnings are physically untouched")
    assert.equal(bMissionFinal.status, "active", "B's mission status is untouched by the delegation import")
    assert.equal(bMissionFinal.learnings.gotcha.value, "rebase, never merge", "B's first-party learnings are physically untouched")
    // the imported result lives ONLY in the quarantined namespace, never in first-party results.
    assert.equal(aMissionFinal.results, undefined, "A produced no first-party results (B's deliverable is quarantined, not first-party)")
    ok("first-party learnings + status byte-untouched on BOTH sides; B's deliverable stays quarantined (non-transitive)")

    // (iv) TRUST CAP — a STRANGER returning a "result" for A's delegation writes NOTHING.
    const strangerResult = {
      subject: { missionKey: MISSION_KEY, title: "Ship the delegation brick" },
      fromAgentId: "agent-evil",
      requestId, // even with the RIGHT correlation id, a stranger is refused at the cap
      result: { requestId, summary: "malicious injected deliverable" },
      issuedAt: new Date().toISOString(),
    }
    const strangerImport = await agentA.tool("import_result", { envelope: strangerResult, fromAgentId: "agent-evil", trustOfSource: "stranger" })
    assert.equal(strangerImport.payload.ok, false, "a stranger result must be refused")
    assert.equal(strangerImport.payload.status, "untrusted_source", "the refusal reason is untrusted_source (trust cap)")
    const aAfterStranger = (await agentA.tool("get_mission", { missionId: missionInA })).payload
    assert.equal(aAfterStranger.importedResults["agent-evil"], undefined, "the stranger wrote NOTHING to importedResults")
    assert.deepEqual(Object.keys(aAfterStranger.importedResults), [AGENT_B_ID], "only B's legitimate deliverable is present")
    ok("a STRANGER returning a result (even with the right requestId) → REFUSED (untrusted_source), wrote nothing")

    // (v) ORPHAN result — a result whose requestId matches NO prior delegation is rejected.
    const orphanReq = "req-never-delegated"
    const orphanResult = {
      subject: { missionKey: MISSION_KEY, title: "Ship the delegation brick" },
      fromAgentId: AGENT_B_ID,
      requestId: orphanReq,
      result: { requestId: orphanReq, summary: "result for work A never delegated" },
      issuedAt: new Date().toISOString(),
    }
    const orphanImport = await agentA.tool("import_result", { envelope: orphanResult, fromAgentId: AGENT_B_ID, trustOfSource: "family" })
    assert.equal(orphanImport.payload.ok, false, "an orphan result (no prior delegation) must be rejected")
    assert.equal(orphanImport.payload.status, "no_delegation", "the rejection reason is no_delegation (correlation honesty)")
    ok("an ORPHAN result (requestId A never delegated) → REJECTED (no_delegation) — A only accepts results for work it delegated")

    // (vi) REPLAY-INERT — re-importing the SAME result envelope is idempotent.
    const replayImport = await agentA.tool("import_result", { envelope: resReady!.envelope, fromAgentId: AGENT_B_ID, trustOfSource: "family" })
    assert.equal(replayImport.payload.ok, true, "a replayed result import still returns ok (idempotent)")
    const aAfterReplay = (await agentA.tool("get_mission", { missionId: missionInA })).payload
    assert.equal(Object.keys(aAfterReplay.importedResults[AGENT_B_ID]).length, 1, "replay did NOT double-land the deliverable")
    assert.equal(
      aAfterReplay.importedResults[AGENT_B_ID][requestId].provenance.importedAt,
      aMissionFinal.importedResults[AGENT_B_ID][requestId].provenance.importedAt,
      "replay did NOT re-stamp the importedAt (the original landing is preserved)",
    )
    ok("REPLAY of the result envelope is inert (idempotent — no double-land, no re-stamp)")

    // (vii) the connect_to audit record carries action:"connect" + actor + originSense (re-assert).
    const connectAudit = readAuditRecords(dirA).find((r) => r.action === "connect")
    assert.ok(connectAudit && connectAudit.action === "connect" && connectAudit.actor === "owner:stdio" && connectAudit.originSense === "stdio", "the connect_to audit carries action:connect + actor + originSense")
    ok(`connect_to control-plane audit verified: action="connect", actor="owner:stdio", originSense="stdio"`)

    void markSeen

    // ════════════════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log("✅  CROSS-AGENT OWN-FLEET DELEGATION PROVEN — two of the owner's own")
    console.log("    agents on separate stores, recognized as same-account FAMILY via a")
    console.log("    signed roster, LINKED by the owner via connect_to (audited), then:")
    console.log("    A delegated a task → B performed it → B returned the deliverable →")
    console.log("    A imported it. Every invariant held: missionKey-not-UUID on the wire,")
    console.log("    first-party inviolable, non-transitive, trust-capped (stranger wrote")
    console.log("    nothing), orphan-result rejected, replay-inert, no third-party leak.")
    console.log("    The own-fleet delegation mechanism works end-to-end.")
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
  console.error("\n❌  DELEGATION PROOF FAILED — this is a real safety regression, not a flake:")
  console.error(err)
  process.exit(1)
})
