// Earned standing — end-to-end cross-agent proof (brick four).
//
// This proves earned standing is a strictly first-party, derived, ADVISORY
// assessment that NEVER writes trust and NEVER crosses the wire — across TWO
// DIFFERENT agents (different owners, SEPARATE bundles/stores), over the real
// harness-agnostic path a second harness would use: two independent
// `friends-mcp` processes, each pointed at its OWN `--dir`.
//
// There is ZERO Ouroboros (or any harness) code in the loop. The script imports
// only Node built-ins, spawns the package's own `dist/mcp/bin.js` twice, and
// speaks JSON-RPC 2.0 over stdio. The two child processes never share a store.
// Standing is computed on read INSIDE each store and returned to the caller —
// nothing standing-shaped ever crosses between them. That locality IS the
// security property.
//
// Every firewall is asserted with a HARD failure. Any violation throws and the
// script exits NON-ZERO — this proof exists precisely to catch a regression in
// the non-transitivity guarantees, so it must never paper one over.
//
//   Agent A  →  owns dirA  →  recorded 3 FIRST-PARTY successes with peer B
//   Agent B  →  owns dirB  →  recorded NOTHING first-party with peer A (only an
//                             imported, peer-asserted outcome)
//
// The invariants proven (see the numbered STEPs below):
//   • two separate stores         — A and B never share a directory
//   • EARNED + per-store          — A's standing of B is "proven"; B's of A is "untested"
//   • firewall 1 (first-party)    — an imported outcome on B's A-peer does NOT count
//   • firewall 2 (inert on trust) — trustLevel is byte-identical before/after every assess+explain
//   • firewall 3 (never on wire)  — no store JSON under either dir carries a `standing`/`tier` field
//   • firewall 4 (advisory)       — explain's advisory carries the "does not change trust level" guardrail
//   • troubled reachable          — a peer with failures > successes reads "troubled"
//
// Run it:  npm run example:cross-agent-standing
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

// The built MCP entrypoint. The `npm run example:cross-agent-standing` script
// runs `npm run build` first so it exists; fail fast with a clear message otherwise.
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

/** Pre-seed a friend record JSON directly into a store dir BEFORE its server
 * starts. Used to construct precise agent-peer fixtures (with `agentMeta` +
 * outcomes, including a peer-asserted imported one) that the MCP surface
 * intentionally can't express in one shot. The live standing flow (assess /
 * explain) still runs entirely through the two servers. */
function seedFriend(dir: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf-8")
}

/** Build an agent-peer friend record. CRITICAL: `agentMeta.bundleName` MUST be a
 * string or `FileFriendStore` normalize drops the whole `agentMeta` on read and
 * standing always reads "untested". */
function agentPeer(opts: {
  id: string
  name: string
  agentId: string
  bundleName: string
  familiarity: number
  outcomes: Array<Record<string, unknown>>
  now: string
}): Record<string, unknown> {
  return {
    id: opts.id,
    name: opts.name,
    role: "agent-peer",
    trustLevel: "acquaintance",
    externalIds: [{ provider: "a2a-agent", externalId: opts.agentId, linkedAt: opts.now }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: opts.now,
    updatedAt: opts.now,
    schemaVersion: 1,
    kind: "agent",
    agentMeta: {
      bundleName: opts.bundleName,
      familiarity: opts.familiarity,
      sharedMissions: [],
      outcomes: opts.outcomes,
    },
  }
}

function ownerRecord(id: string, name: string, externalId: string, now: string): Record<string, unknown> {
  return {
    id,
    name,
    role: "primary",
    trustLevel: "family",
    externalIds: [{ provider: "local", externalId, linkedAt: now }],
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

/** Read every `*.json` file under `dir` (recursively) and return their contents. */
function readAllStoreJson(dir: string): Array<{ path: string; content: string }> {
  const entries = readdirSync(dir, { recursive: true }) as string[]
  const out: Array<{ path: string; content: string }> = []
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue
    out.push({ path: entry, content: readFileSync(join(dir, entry), "utf-8") })
  }
  return out
}

async function main(): Promise<void> {
  const dirA = mkdtempSync(join(tmpdir(), "friends-standingA-"))
  const dirB = mkdtempSync(join(tmpdir(), "friends-standingB-"))
  let agentA: Agent | undefined
  let agentB: Agent | undefined

  try {
    const now = new Date().toISOString()

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1 — Two SEPARATE stores. Each agent has its own owner (so whoami
    // resolves) and its own view of the OTHER agent as a peer. The peer fixtures
    // encode the asymmetry the proof rests on:
    //   • A's peer B  → 3 FIRST-PARTY successes + familiarity 3   (A earned a lot)
    //   • B's peer A  → exactly ONE IMPORTED (peer-asserted) success (B earned nothing)
    //   • A's peer C  → 1 success + 2 failed                        (the troubled path)
    // ════════════════════════════════════════════════════════════════════════
    step("Two separate stores; A recorded first-party wins with B, B recorded nothing first-party with A")

    const ownerAId = randomUUID()
    const ownerBId = randomUUID()
    seedFriend(dirA, ownerRecord(ownerAId, "Owner A", "owner-a", now))
    seedFriend(dirB, ownerRecord(ownerBId, "Owner B", "owner-b", now))

    const AGENT_A_ID = "agent-a"
    const AGENT_B_ID = "agent-b"
    const AGENT_C_ID = "agent-c"

    // A's store: peer B with 3 first-party successes (no provenance ⇒ first-party).
    const bInAId = randomUUID()
    seedFriend(dirA, agentPeer({
      id: bInAId,
      name: "Agent B",
      agentId: AGENT_B_ID,
      bundleName: "agent-b",
      familiarity: 3,
      outcomes: [
        { missionId: "m1", result: "success", timestamp: now },
        { missionId: "m2", result: "success", timestamp: now },
        { missionId: "m3", result: "success", timestamp: now },
      ],
      now,
    }))

    // A's store: peer C with failures outnumbering successes (the troubled path).
    const cInAId = randomUUID()
    seedFriend(dirA, agentPeer({
      id: cInAId,
      name: "Agent C",
      agentId: AGENT_C_ID,
      bundleName: "agent-c",
      familiarity: 3,
      outcomes: [
        { missionId: "c1", result: "success", timestamp: now },
        { missionId: "c2", result: "failed", timestamp: now },
        { missionId: "c3", result: "failed", timestamp: now },
      ],
      now,
    }))

    // B's store: peer A with NOTHING first-party — only a single IMPORTED outcome
    // (a peer-asserted claim, e.g. relayed via a brick-3 mission share). This ONE
    // fixture proves BOTH "B earned nothing first-party with A" AND "an imported
    // outcome does not count" — firewall 1, non-transitivity, in a single assert.
    const aInBId = randomUUID()
    seedFriend(dirB, agentPeer({
      id: aInBId,
      name: "Agent A",
      agentId: AGENT_A_ID,
      bundleName: "agent-a",
      familiarity: 0,
      outcomes: [
        { missionId: "x1", result: "success", timestamp: now, provenance: { origin: "imported", assertedBy: { agentId: "agent-x" } } },
      ],
      now,
    }))

    assert.notEqual(bInAId, aInBId, "the two stores must give their peers different local UUIDs")
    ok(`Agent A store ${dirA.split("/").pop()} recorded 3 first-party successes with B`)
    ok(`Agent B store ${dirB.split("/").pop()} recorded only an imported (peer-asserted) outcome with A`)
    ok("two SEPARATE stores; standing will be EARNED per-store, never symmetric")

    // Boot both agents (two processes, two stores).
    agentA = new Agent("A", dirA)
    agentB = new Agent("B", dirB)
    await agentA.initialize()
    await agentB.initialize()

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2 — EARNED + per-store. A assesses B from A's OWN first-party outcomes
    // → "proven", basisCount 3. (Standing is earned from what you personally lived.)
    // ════════════════════════════════════════════════════════════════════════
    step("A assesses B → proven (earned from 3 first-party successes)")
    const aAssessB = await agentA.tool("assess_standing", { friendId: bInAId })
    assert.equal(aAssessB.isError, false)
    assert.equal(aAssessB.payload.tier, "proven", "A's standing of B must be proven")
    assert.equal(aAssessB.payload.basisCount, 3, "basisCount must be the 3 first-party successes")
    assert.deepEqual(aAssessB.payload.tally, { success: 3, partial: 0, failed: 0 })
    ok(`A.assess_standing(B) → tier "proven", basisCount 3 (earned from A's own outcomes)`)

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3 — Non-symmetric + firewall 1. B assesses A → "untested", basisCount
    // 0. B recorded nothing first-party with A; the lone IMPORTED outcome is
    // EXCLUDED. This is the non-transitivity proof: a peer-asserted outcome can't
    // be laundered into B's earned standing of A.
    // ════════════════════════════════════════════════════════════════════════
    step("B assesses A → untested (firewall 1: the imported outcome is excluded; reputation can't be laundered)")
    const bAssessA = await agentB.tool("assess_standing", { friendId: aInBId })
    assert.equal(bAssessA.isError, false)
    assert.equal(bAssessA.payload.tier, "untested", "B's standing of A must be untested (nothing first-party)")
    assert.equal(bAssessA.payload.basisCount, 0, "the imported outcome must NOT count toward basis")
    assert.deepEqual(bAssessA.payload.tally, { success: 0, partial: 0, failed: 0 }, "no first-party outcomes ⇒ empty tally")
    ok(`B.assess_standing(A) → tier "untested", basisCount 0 — the imported outcome was excluded`)

    // ════════════════════════════════════════════════════════════════════════
    // STEP 4 — Firewall 4 (advisory, never a gate). explain_standing's advisory
    // carries the guardrail that standing does NOT change the peer's trust level.
    // ════════════════════════════════════════════════════════════════════════
    step("A explains B's standing → advisory carries the 'does not change trust level' guardrail")
    const aExplainB = await agentA.tool("explain_standing", { friendId: bInAId })
    assert.equal(aExplainB.isError, false)
    assert.equal(aExplainB.payload.standing.tier, "proven")
    const advisory = aExplainB.payload.advisory as string[]
    assert.ok(Array.isArray(advisory) && advisory.length > 0, "explain must carry advisory notes")
    assert.ok(
      advisory.some((a) => a.includes("does not change") && a.includes("trust level")),
      "advisory must include the guardrail that standing does not change trust level",
    )
    ok("explain_standing(B).advisory includes the manual-trust-decision guardrail")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 5 — Troubled reachable. A's peer C (failures > successes) → "troubled".
    // ════════════════════════════════════════════════════════════════════════
    step("A assesses C (failures > successes) → troubled")
    const aAssessC = await agentA.tool("assess_standing", { friendId: cInAId })
    assert.equal(aAssessC.payload.tier, "troubled", "a peer with failures > successes must read troubled")
    assert.equal(aAssessC.payload.basisCount, 3)
    ok(`A.assess_standing(C) → tier "troubled" (the negative path is reachable)`)

    // ════════════════════════════════════════════════════════════════════════
    // STEP 6 — Firewall 2 (inert on trust). The trustLevel of every assessed peer
    // is byte-identical before and after EVERY assess + explain call. Standing is
    // a pure read; it never reaches setFriendTrust.
    // (We captured the seeded trust as "acquaintance"; re-read it live now, AFTER
    // all the assess/explain calls above, and assert it is unchanged.)
    // ════════════════════════════════════════════════════════════════════════
    step("Firewall 2 — trustLevel of every assessed peer is unchanged after all assess+explain calls")
    const bTrustAfter = (await agentA.tool("get_friend", { friendId: bInAId })).payload.trustLevel
    const cTrustAfter = (await agentA.tool("get_friend", { friendId: cInAId })).payload.trustLevel
    const aTrustAfter = (await agentB.tool("get_friend", { friendId: aInBId })).payload.trustLevel
    assert.equal(bTrustAfter, "acquaintance", "B's trust must be untouched by assess/explain")
    assert.equal(cTrustAfter, "acquaintance", "C's trust must be untouched by assess/explain")
    assert.equal(aTrustAfter, "acquaintance", "A's trust (in B's store) must be untouched by assess/explain")
    ok("trustLevel of B, C (in A) and A (in B) is still \"acquaintance\" — standing never wrote trust")

    // ════════════════════════════════════════════════════════════════════════
    // STEP 7 — Firewall 3 (never on the wire). assess/explain produce NO envelope
    // and persist NOTHING. Walk every `*.json` under BOTH stores and assert NONE
    // carry a `standing` or `tier` field. The only JSON is the seeded friend
    // records (which contain `agentMeta.outcomes`, never `standing`/`tier`); the
    // sibling _grants/ + _missions/ dirs stay empty.
    // ════════════════════════════════════════════════════════════════════════
    step("Firewall 3 — no store JSON under either dir carries a `standing`/`tier` field; no envelope written")
    const allJson = [...readAllStoreJson(dirA), ...readAllStoreJson(dirB)]
    assert.ok(allJson.length >= 5, "the seeded friend records must be present on disk")
    for (const file of allJson) {
      assert.equal(file.content.includes('"standing"'), false, `${file.path} must not carry a standing field`)
      assert.equal(file.content.includes('"tier"'), false, `${file.path} must not carry a tier field`)
    }
    ok(`walked ${allJson.length} store JSON files across both dirs — none carry "standing" or "tier"`)

    // ════════════════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log("✅  EARNED STANDING PROVEN — first-party-only, inert on trust, and")
    console.log("    never on the wire, across two separate agents and stores.")
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  } finally {
    agentA?.kill()
    agentB?.kill()
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error("\n❌  STANDING PROOF FAILED — this is a real non-transitivity regression, not a flake:")
  console.error(err)
  process.exit(1)
})
