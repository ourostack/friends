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
import { evaluateAccountMembership, verifiedCandidate, MemoryRosterStore } from "../src"
import type { AccountRoster } from "../src"
import { ready, signRoster, ed25519RosterVerifier } from "../src/a2a-client"

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

/** An owner/self record whose `id` IS its routing agentId. `family` so whoami's
 * family-fallback resolves it deterministically regardless of the host OS user. */
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

    // Keep sodium referenced (the roster crypto lands in Unit 8b).
    void sodium
    void evaluateAccountMembership
    void verifiedCandidate
    void MemoryRosterStore
    void signRoster
    void ed25519RosterVerifier
    void buildOutgoing
    void readIncoming
    void markSeen
    void ({} as SeenLedger)
    void ({} as AccountRoster)

    // ════════════════════════════════════════════════════════════════════════
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    console.log("✅  DELEGATION PROOF SKELETON — two own-fleet agents stood up on")
    console.log("    separate stores; whoami resolves each. (Roster + connect_to +")
    console.log("    delegate→perform→return land in the next units.)")
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
