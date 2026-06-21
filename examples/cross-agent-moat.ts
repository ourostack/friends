// Cross-agent multiplayer moat — end-to-end proof (the capstone demonstration).
//
// This is the proof that the cross-agent moat works between TWO DIFFERENT agents
// (different owners, SEPARATE bundles/stores), over the real harness-agnostic
// path a second harness would use: two independent `friends-mcp` processes, each
// pointed at its OWN `--dir`, exchanging a `ProfileShareEnvelope` as JSON.
//
// There is ZERO Ouroboros (or any harness) code in the loop. The script imports
// only Node built-ins, spawns the package's own `dist/mcp/bin.js` twice, and
// speaks JSON-RPC 2.0 over stdio. The two child processes never share a store —
// the only thing that crosses between them is the envelope JSON, exactly as it
// would cross a network between two real agents.
//
// Every safety invariant of the moat is asserted with a HARD failure. Any
// violation throws, and the script exits NON-ZERO — this proof exists precisely
// to catch a regression in the moat, so it must never paper one over.
//
//   Agent A  →  owns dirA  →  knows party P as "Staff Engineer" (first-party)
//   Agent B  →  owns dirB  →  knows the SAME party P as "B's private guess"
//
// The invariants proven (see the numbered STEPs below):
//   • two separate stores            — A and B never share a directory
//   • join-key reference agreement   — both name P by `aad:p@contoso.com`, never a local UUID
//   • peer onboarding                — A and B onboard each other at `friend` trust
//   • tiered consent gate            — content share refused without a grant; identity share allowed
//   • scope filtering                — `notes:safe` carries only the `shareable` note
//   • no-UUID-on-the-wire            — the envelope names P by join key, never A's local UUID
//   • first-party-wins               — B's own `role` note is untouched by the import
//   • attribution                    — A's claim lands under A's agentId in B's importedNotes
//   • trust non-transitive           — the import never changes P's trust level in B's store
//   • no laundering                  — the imported fact records A as asserter (can't be re-shared as first-party)
//   • revoke + audit                 — list_shares shows the grant; after revoke the content share is refused again
//   • Fork-E introduction            — a friend peer may seed a NEW party; a stranger peer may not
//
// Run it:  npm run example:cross-agent-moat
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

// The built MCP entrypoint. The `npm run example:cross-agent-moat` script runs
// `npm run build` first so it exists; fail fast with a clear message otherwise.
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
    // Each agent is its OWN process pointed at its OWN directory. This is the
    // two-separate-stores property that makes them genuinely two agents.
    this.child = spawn("node", [BIN_PATH, "--dir", dir], { stdio: ["pipe", "pipe", "pipe"] })
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf-8")
      this.drain()
    })
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Surface any server-side crash output; never silently swallow it.
      process.stderr.write(`[${label} stderr] ${chunk.toString("utf-8")}`)
    })
  }

  private drain(): void {
    // The server auto-detects framing from the first message; we speak
    // newline-delimited JSON, so it answers newline-delimited.
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
// UUID — is the cross-agent currency.
const P_JOIN_KEY = { provider: "aad", externalId: "p@contoso.com" } as const

/** Pre-seed a friend record JSON directly into a store dir BEFORE its server
 * starts. Used to construct precise note fixtures (with `shareable` + first-party
 * provenance) that the MCP `save_note` surface intentionally can't express. The
 * live moat flow (grant / share / import) still runs entirely through the two
 * servers — only the static fixtures are seeded here. */
function seedFriend(dir: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8")
}

async function main(): Promise<void> {
  const dirA = mkdtempSync(join(tmpdir(), "friends-agentA-"))
  const dirB = mkdtempSync(join(tmpdir(), "friends-agentB-"))
  let agentA: Agent | undefined
  let agentB: Agent | undefined

  try {
    const now = new Date().toISOString()

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1 — Both agents know the SAME party P by the SAME join key, with
    // their OWN first-party knowledge. (Reference agreement + sets up the
    // first-party-wins clobber test.) Seeded on disk so we can mark notes
    // `shareable` and stamp first-party provenance precisely.
    // ════════════════════════════════════════════════════════════════════════
    step("Both stores know party P by the same join key, each with its own first-party notes")

    // Agent A's owner/self record — a `family` record so A's `whoami` resolves a
    // stable self identity (the asserter tag stamped on A's first-party shares).
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

    // Party P in Agent A's store: first-party role + a shareable note + a NOT-
    // shareable note. `role` here is a NOTE KEY (the thing first-party-wins
    // protects), distinct from the record's `role` field.
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
        role: {
          value: "Staff Engineer",
          savedAt: now,
          shareable: false,
          provenance: { origin: "first_party" },
        },
        team: {
          value: "Platform",
          savedAt: now,
          shareable: true, // ← the ONLY note a notes:safe share may carry
          provenance: { origin: "first_party" },
        },
        salary: {
          value: "$private",
          savedAt: now,
          shareable: false, // ← must be WITHHELD from a notes:safe share
          provenance: { origin: "first_party" },
        },
      },
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      kind: "human",
    })

    // Agent B's owner/self record (B is a different owner — different store).
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

    // The SAME party P in Agent B's store (same join key) — but with B's OWN
    // first-party guess for `role`. This is what the import must NOT clobber.
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
        role: {
          value: "B's private guess",
          savedAt: now,
          shareable: false,
          provenance: { origin: "first_party" },
        },
      },
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      kind: "human",
    })

    // The two local UUIDs for P MUST differ — that's the whole point of a join
    // key: the same person has a different local id in every store.
    assert.notEqual(pInAId, pInBId, "the two stores must give P different local UUIDs")
    ok(`Agent A store ${dirA.split("/").pop()} knows P (local id ${pInAId.slice(0, 8)}…) as "Staff Engineer"`)
    ok(`Agent B store ${dirB.split("/").pop()} knows P (local id ${pInBId.slice(0, 8)}…) as "B's private guess"`)
    ok("two SEPARATE stores; same join key aad:p@contoso.com; different local UUIDs")

    // Boot both agents (two processes, two stores).
    agentA = new Agent("A", dirA)
    agentB = new Agent("B", dirB)
    await agentA.initialize()
    await agentB.initialize()

    // Confirm each agent reads only its OWN P, and whoami resolves each owner.
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
    // STEP 2 — A and B onboard EACH OTHER as agent peers at `friend` trust.
    // (Agent-to-agent acquaintance — the relationship the consent layer gates on.)
    // ════════════════════════════════════════════════════════════════════════
    step("A and B onboard each other as agent peers at `friend` trust")
    const AGENT_A_ID = "agent-a"
    const AGENT_B_ID = "agent-b"
    const bAsPeerOfA = await agentA.tool("onboard_agent", { name: "Agent B", agentId: AGENT_B_ID, trustLevel: "friend" })
    assert.equal(bAsPeerOfA.payload.kind, "agent")
    assert.equal(bAsPeerOfA.payload.trustLevel, "friend")
    const aAsPeerOfB = await agentB.tool("onboard_agent", { name: "Agent A", agentId: AGENT_A_ID, trustLevel: "friend" })
    assert.equal(aAsPeerOfB.payload.kind, "agent")
    assert.equal(aAsPeerOfB.payload.trustLevel, "friend")
    ok(`A knows ${AGENT_B_ID} as a friend peer; B knows ${AGENT_A_ID} as a friend peer`)

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3 — Tiered consent gate. A content-scope share to B with NO grant is
    // REFUSED (no_consent); an identity-scope share succeeds on peer trust alone.
    // (Proves the tiered posture: trust agrees on WHO, content needs consent.)
    // ════════════════════════════════════════════════════════════════════════
    step("Consent gate (tiered): content share refused without a grant; identity share allowed on trust")
    const contentNoGrant = await agentA.tool("share_profile", { friendId: pInAId, toAgentId: AGENT_B_ID, scope: "notes:safe" })
    assert.equal(contentNoGrant.payload.ok, false, "a content share with NO grant must be refused")
    assert.equal(contentNoGrant.payload.status, "no_consent", "refusal reason must be no_consent")
    assert.equal(contentNoGrant.isError, true)
    ok("notes:safe share with no grant → REFUSED (no_consent)")

    const identityShare = await agentA.tool("share_profile", { friendId: pInAId, toAgentId: AGENT_B_ID, scope: "identity" })
    assert.equal(identityShare.payload.ok, true, "an identity share must succeed on peer trust ≥ friend")
    assert.equal(identityShare.payload.envelope.scope, "identity")
    assert.equal(identityShare.payload.envelope.notes, undefined, "an identity share carries NO note content")
    ok("identity share with no grant → ALLOWED on friend-trust alone (carries only the join key)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 4 — A grants B a content share, then A PREPARES it → envelope.
    // Assert: names P by join key (never A's local UUID); only the granted scope;
    // for notes:safe, only the `shareable` note (the non-shareable ones withheld).
    // ════════════════════════════════════════════════════════════════════════
    step("A grants B a content share, then prepares the envelope (join-key only, scope-filtered)")
    const grant = await agentA.tool("grant_share", { subjectFriendId: pInAId, recipientAgentId: AGENT_B_ID, scope: "notes:safe" })
    const grantId = grant.payload.id as string
    assert.ok(grantId, "grant_share must return a grant id")
    ok(`A granted B a notes:safe share of P (grant ${grantId.slice(0, 8)}…)`)

    const share = await agentA.tool("share_profile", { friendId: pInAId, toAgentId: AGENT_B_ID, scope: "notes:safe" })
    assert.equal(share.payload.ok, true, "the content share must now succeed (grant present)")
    const envelope = share.payload.envelope
    const envelopeJson = JSON.stringify(envelope)

    // Names P by JOIN KEY, never A's local UUID.
    assert.deepEqual(
      envelope.subject.externalIds.map((e: any) => ({ provider: e.provider, externalId: e.externalId })),
      [{ provider: P_JOIN_KEY.provider, externalId: P_JOIN_KEY.externalId }],
      "envelope must name P by its join key",
    )
    assert.equal(envelopeJson.includes(pInAId), false, "A's local UUID for P must NEVER appear on the wire")
    ok("envelope names P by join key aad:p@contoso.com — A's local UUID is absent from the wire")

    // Only the granted scope.
    assert.equal(envelope.scope, "notes:safe", "envelope must carry only the granted scope")

    // notes:safe ⇒ only the `shareable` note. `team` (shareable) present; `role`
    // and `salary` (not shareable) withheld.
    const sharedKeys = (envelope.notes as Array<{ key: string; value: string }>).map((n) => n.key).sort()
    assert.deepEqual(sharedKeys, ["team"], "notes:safe must carry ONLY the note marked shareable")
    const teamNote = (envelope.notes as Array<{ key: string; value: string }>).find((n) => n.key === "team")
    assert.equal(teamNote?.value, "Platform")
    assert.equal(envelopeJson.includes("$private"), false, "the non-shareable salary note must be WITHHELD")
    assert.equal(envelopeJson.includes("Staff Engineer"), false, "the non-shareable role note must be WITHHELD")
    ok("notes:safe carried ONLY the shareable note (team=Platform); role + salary withheld")

    // The envelope attributes the shared first-party note back to Agent A (its
    // self id), so the consumer can attribute without laundering.
    assert.equal(teamNote && (teamNote as any).originallyAssertedBy?.agentId, ownerAId, "shared first-party note must be attributed to A's self id")
    ok("shared note is attributed to Agent A as original asserter")

    // ════════════════════════════════════════════════════════════════════════
    // The envelope crosses the agent boundary HERE — as plain JSON, exactly as it
    // would cross a network. Nothing else passes between the two stores.
    // ════════════════════════════════════════════════════════════════════════

    // ════════════════════════════════════════════════════════════════════════
    // STEP 5 — B IMPORTS the envelope. Assert the four core safety invariants
    // against B's OWN store.
    // ════════════════════════════════════════════════════════════════════════
    step("B imports the envelope — first-party-wins, attribution, trust non-transitive, no laundering")

    // Capture B's view of P BEFORE the import, to prove what the import leaves be.
    const pBeforeImport = await agentB.tool("get_friend", { friendId: pInBId })
    const trustBefore = pBeforeImport.payload.trustLevel as string
    const roleBefore = pBeforeImport.payload.notes.role.value as string
    assert.equal(roleBefore, "B's private guess")

    // B imports, naming A as the source agent (agent-a) at the friend trust B
    // holds for A. The import namespaces facts under THIS fromAgentId.
    const imported = await agentB.tool("import_profile", { envelope, fromAgentId: AGENT_A_ID, trustOfSource: "friend" })
    assert.equal(imported.payload.ok, true, "import from a trusted peer must succeed")
    assert.equal(imported.payload.status, "imported", "P already existed in B's store → imported (not seeded)")
    assert.equal(imported.payload.record.id, pInBId, "the import must resolve to B's existing P by join key")
    ok("B resolved the envelope to its existing P by join key and imported it")

    // Re-read P from B's store and assert every invariant on persisted state.
    const pAfter = await agentB.tool("get_friend", { friendId: pInBId })

    // (a) FIRST-PARTY WINS — B's own `role` note is byte-for-byte untouched.
    assert.equal(pAfter.payload.notes.role.value, "B's private guess", "INVARIANT first-party-wins: B's own role note must be untouched")
    assert.equal(pAfter.payload.notes.role.value, roleBefore)
    ok("first-party-wins: B's role note is STILL \"B's private guess\" (untouched by the import)")

    // (b) ATTRIBUTION — A's `team` claim is present in importedNotes under A's
    // agentId (agent-a), kept structurally apart from first-party notes.
    const importedForA = pAfter.payload.importedNotes?.[AGENT_A_ID]
    assert.ok(importedForA, "INVARIANT attribution: importedNotes must have a namespace for agent-a")
    assert.equal(importedForA.team?.value, "Platform", "A's team claim must land under agent-a in importedNotes")
    assert.equal(pAfter.payload.notes.team, undefined, "the imported fact must NOT leak into first-party notes")
    ok("attribution: A's team=Platform claim landed under importedNotes[agent-a] — not in first-party notes")

    // (c) TRUST NON-TRANSITIVE — P's trust level in B's store is UNCHANGED.
    assert.equal(pAfter.payload.trustLevel, trustBefore, "INVARIANT trust-non-transitive: import must NOT change P's trust")
    assert.equal(pAfter.payload.trustLevel, "acquaintance")
    ok(`trust non-transitive: P's trust is STILL "${trustBefore}" (the import did not touch it)`)

    // (d) NO LAUNDERING — the imported fact records A as asserter (both the
    // importing agent and the original asserter), so B cannot silently re-present
    // it as its own first-party knowledge.
    assert.equal(importedForA.team.assertedBy?.agentId, AGENT_A_ID, "INVARIANT no-laundering: imported fact must record agent-a as asserter")
    assert.equal(importedForA.team.originallyAssertedBy?.agentId, ownerAId, "imported fact must preserve A's original-asserter id")
    assert.ok(importedForA.team.importedAt, "imported fact must be stamped importedAt")
    ok("no laundering: the imported fact records A as asserter + carries importedAt (can't be re-shared as first-party)")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 6 — Revoke + audit. list_shares shows the grant; revoke it; a
    // subsequent content share is refused again. (Consent is real + revocable.)
    // ════════════════════════════════════════════════════════════════════════
    step("Revoke + audit — list_shares shows the grant; after revoke, the content share is refused again")
    const sharesBefore = await agentA.tool("list_shares", { subjectFriendId: pInAId })
    const listed = sharesBefore.payload as Array<{ id: string; effective: boolean; scope: string }>
    const theGrant = listed.find((g) => g.id === grantId)
    assert.ok(theGrant, "list_shares must surface the grant")
    assert.equal(theGrant!.effective, true, "the grant must be effective before revoke")
    ok(`list_shares shows the grant as effective (scope ${theGrant!.scope})`)

    const revoked = await agentA.tool("revoke_share", { grantId })
    assert.equal(revoked.payload.status, "revoked", "revoke_share must tombstone the grant")
    ok("A revoked the grant")

    const contentAfterRevoke = await agentA.tool("share_profile", { friendId: pInAId, toAgentId: AGENT_B_ID, scope: "notes:safe" })
    assert.equal(contentAfterRevoke.payload.ok, false, "a content share after revoke must be refused")
    assert.equal(contentAfterRevoke.payload.status, "no_consent", "post-revoke refusal must be no_consent")
    ok("after revoke, the notes:safe share is REFUSED again (no_consent) — consent is revocable")

    const effectiveAfter = await agentA.tool("list_shares", { effectiveOnly: "true" })
    assert.equal((effectiveAfter.payload as unknown[]).length, 0, "no effective grants must remain after revoke")
    ok("list_shares (effectiveOnly) is empty after revoke — the audit trail survives, the consent does not")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 7 — Fork-E introduction. Only a friend/family peer may introduce a
    // PREVIOUSLY-UNKNOWN party (seeded at acquaintance). A non-friend/family peer
    // may not seed — refused along one of two gates, both proven here:
    //   • a STRANGER source is refused at the acceptance cap (untrusted_source) —
    //     its facts don't count at all;
    //   • an ACQUAINTANCE source passes the accept cap but may not SEED an unknown
    //     party (untrusted_introduction).
    // Each sub-case uses a DISTINCT unknown join key so the cases never shadow
    // one another (a refused import must leave the store untouched).
    // ════════════════════════════════════════════════════════════════════════
    step("Fork-E introduction — only a friend/family peer may seed a NEW party")

    function introEnvelopeFor(externalId: string, displayName: string): Record<string, unknown> {
      return {
        subject: { externalIds: [{ provider: "aad", externalId, linkedAt: now }], displayName },
        fromAgentId: AGENT_A_ID,
        scope: "identity",
        issuedAt: now,
      }
    }

    // (a) STRANGER source → REFUSED at the acceptance cap (its facts never count).
    const strangerKey = "stranger-intro@contoso.com"
    const strangerIntro = await agentB.tool("import_profile", {
      envelope: introEnvelopeFor(strangerKey, "StrangerIntro"),
      fromAgentId: "agent-stranger",
      trustOfSource: "stranger",
    })
    assert.equal(strangerIntro.payload.ok, false, "a stranger source must not be able to seed a new party")
    assert.equal(strangerIntro.payload.status, "untrusted_source", "a stranger source is refused at the acceptance cap")
    // Confirm nothing was written: the FIRST resolve of this key must create it.
    const strangerProbe = await agentB.tool("resolve_party", { provider: "aad", externalId: strangerKey, displayName: "Probe", channel: "mcp" })
    assert.equal(strangerProbe.payload.created, true, "the stranger introduction must not have created the party")
    ok("stranger source introducing an unknown party → REFUSED (untrusted_source); nothing written")

    // (b) ACQUAINTANCE source → passes the accept cap, but may NOT seed (Fork E).
    const acqKey = "acquaintance-intro@contoso.com"
    const acqIntro = await agentB.tool("import_profile", {
      envelope: introEnvelopeFor(acqKey, "AcqIntro"),
      fromAgentId: "agent-acq",
      trustOfSource: "acquaintance",
    })
    assert.equal(acqIntro.payload.ok, false, "an acquaintance source must not be able to seed a new party")
    assert.equal(acqIntro.payload.status, "untrusted_introduction", "an acquaintance source is refused at the seeding gate")
    const acqProbe = await agentB.tool("resolve_party", { provider: "aad", externalId: acqKey, displayName: "Probe", channel: "mcp" })
    assert.equal(acqProbe.payload.created, true, "the acquaintance introduction must not have created the party")
    ok("acquaintance source introducing an unknown party → REFUSED (untrusted_introduction); nothing written")

    // (c) FRIEND source → SEEDED at acquaintance (never inherits the peer's trust).
    const friendKey = "friend-intro@contoso.com"
    const friendIntro = await agentB.tool("import_profile", {
      envelope: introEnvelopeFor(friendKey, "FriendIntro"),
      fromAgentId: AGENT_A_ID,
      trustOfSource: "friend",
    })
    assert.equal(friendIntro.payload.ok, true, "a friend source must be able to introduce a new party")
    assert.equal(friendIntro.payload.status, "seeded", "a friend introduction of an unknown party must be seeded")
    assert.equal(friendIntro.payload.record.trustLevel, "acquaintance", "a seeded party must start at acquaintance (never higher)")
    ok("friend source introducing an unknown party → SEEDED at acquaintance (never inherits the peer's friend trust)")

    // ════════════════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log("✅  CROSS-AGENT MOAT PROVEN — every invariant held across two")
    console.log("    separate agents, two separate stores, over the MCP wire.")
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  } finally {
    agentA?.kill()
    agentB?.kill()
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error("\n❌  MOAT PROOF FAILED — this is a real safety regression, not a flake:")
  console.error(err)
  process.exit(1)
})
