import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { createFriendsMcpServer, getToolSchemas } from "../mcp"
import { coerceBool, coerceInt, coerceString, coerceOptionalString } from "../mcp/dispatch"
import { FileFriendStore, MemoryAuditSink } from "../index"
import type { FriendStore, FriendRecord, IdentityProvider, GrantStore, ShareGrant, MissionStore, MissionRecord, ControlPlaneAuditRecord } from "../index"

// ── In-memory JSON-RPC/stdio harness ──
// The server processes `data` synchronously in its listener, so after writing a
// framed request and flushing the event loop once, the response is in the
// captured stdout buffer. Supports both Content-Length and newline framing.

interface JsonRpcResponse {
  jsonrpc: string
  id: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

// Yield through a real timer tick (timers phase), not just setImmediate. The
// server dispatches via `void handleRequest(...)`, which awaits the store; a
// FileFriendStore resolves a name lookup with real fs/promises I/O. A tight
// setImmediate-only poll loop runs in the check phase and can starve those
// pending I/O callbacks on a loaded runner, so the response never lands within
// the budget. A setTimeout(0) sequences after the poll phase and lets the
// awaited fs chain settle deterministically.
const flush = () => new Promise((r) => setTimeout(r, 0))

class Harness {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  out = ""
  constructor() {
    this.stdout.on("data", (chunk: Buffer) => {
      this.out += chunk.toString("utf-8")
    })
  }

  writeContentLength(msg: Record<string, unknown>): void {
    const body = JSON.stringify(msg)
    this.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  writeNewline(text: string): void {
    this.stdin.write(text + "\n")
  }

  /** Parse all framed responses currently in the buffer (auto-detect framing). */
  parseAll(): JsonRpcResponse[] {
    const responses: JsonRpcResponse[] = []
    let buf = this.out
    while (buf.length > 0) {
      if (buf.startsWith("Content-Length:")) {
        const headerEnd = buf.indexOf("\r\n\r\n")
        if (headerEnd === -1) break
        const len = parseInt(buf.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i)![1], 10)
        const bodyStart = headerEnd + 4
        const body = buf.slice(bodyStart, bodyStart + len)
        responses.push(JSON.parse(body))
        buf = buf.slice(bodyStart + len)
      } else {
        const nl = buf.indexOf("\n")
        if (nl === -1) break
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.length > 0) responses.push(JSON.parse(line))
      }
    }
    return responses
  }

  /** Send a Content-Length request and return the response with the matching
   * id, waiting across event-loop ticks for async dispatch (e.g. a FileFriendStore
   * directory scan) to complete. */
  async call(msg: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = msg.id
    this.writeContentLength(msg)
    for (let i = 0; i < 50; i++) {
      await flush()
      const found = this.parseAll().find((r) => r.id === id)
      if (found) return found
    }
    throw new Error(`no response for id ${String(id)}`)
  }

  /** Call a tool and return the parsed JSON payload from result.content[0].text. */
  async tool(name: string, args: Record<string, unknown>, id = nextId()): Promise<{ payload: unknown; isError: boolean }> {
    const res = await this.call({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
    const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean }
    return { payload: JSON.parse(result.content[0].text), isError: result.isError }
  }
}

let idCounter = 0
const nextId = () => ++idCounter

const NOW = "2026-03-14T18:00:00.000Z"

function makeStore(initial: FriendRecord[] = []): FriendStore {
  const records = new Map<string, FriendRecord>()
  for (const f of initial) records.set(f.id, f)
  return {
    async get(id) {
      return records.get(id) ?? null
    },
    async put(id, record) {
      records.set(id, record)
    },
    async delete(id) {
      records.delete(id)
    },
    async findByExternalId(provider, externalId, tenantId) {
      for (const r of records.values()) {
        if (r.externalIds.find((e) => e.provider === provider && e.externalId === externalId && (tenantId === undefined || e.tenantId === tenantId))) {
          return r
        }
      }
      return null
    },
    async hasAnyFriends() {
      return records.size > 0
    },
    async listAll() {
      return Array.from(records.values())
    },
  }
}

function ownerRecord(): FriendRecord {
  return {
    id: "owner-1",
    name: "operator",
    role: "family",
    trustLevel: "family",
    connections: [],
    externalIds: [{ provider: "local" as IdentityProvider, externalId: "operator", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  }
}

// Seeds an owner imprint into a synchronous MemoryStore so the bundle is
// non-empty (the resolver imprints the FIRST friend as family/primary; seeding
// makes the next resolve_party land as a stranger).
function seedOwner(store: FriendStore): FriendRecord {
  const owner = ownerRecord()
  void store.put(owner.id, owner)
  return owner
}

describe("getToolSchemas", () => {
  it("returns exactly the 32 tools with object input schemas", () => {
    const schemas = getToolSchemas()
    const names = schemas.map((s) => s.name).sort()
    expect(names).toEqual(
      [
        "assess_standing",
        "channel_caps",
        "connect_to",
        "coordinate",
        "describe_trust",
        "explain_standing",
        "get_coordination",
        "get_friend",
        "get_mission",
        "grant_share",
        "import_coordination",
        "import_mission",
        "import_profile",
        "import_result",
        "link_identity",
        "list_friends",
        "list_missions",
        "list_shares",
        "onboard_agent",
        "record_interaction",
        "record_mission",
        "resolve_party",
        "resolve_room",
        "revoke_share",
        "save_note",
        "send_result",
        "set_trust",
        "share_mission",
        "share_profile",
        "unlink_identity",
        "upsert_group",
        "whoami",
      ].sort(),
    )
    expect(schemas).toHaveLength(32)
    for (const s of schemas) {
      expect(s.inputSchema.type).toBe("object")
      expect(typeof s.description).toBe("string")
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it("declares required args where the tool needs them", () => {
    const byName = Object.fromEntries(getToolSchemas().map((s) => [s.name, s]))
    expect(byName.resolve_party.inputSchema.required).toContain("provider")
    expect(byName.resolve_party.inputSchema.required).toContain("externalId")
    expect(byName.get_friend.inputSchema.required).toContain("friendId")
    expect(byName.set_trust.inputSchema.required).toEqual(["friendId", "trustLevel"])
    expect(byName.whoami.inputSchema.required).toBeUndefined()
  })
})

describe("protocol layer", () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })
  afterEach(() => {
    h.stdin.destroy()
    h.stdout.destroy()
  })

  it("responds to initialize with protocol version, serverInfo, and tools capability", async () => {
    const server = createFriendsMcpServer({ store: makeStore(), stdin: h.stdin, stdout: h.stdout })
    server.start()
    const res = await h.call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(res.result?.protocolVersion).toBe("2024-11-05")
    expect((res.result as { serverInfo: { name: string } }).serverInfo.name).toBe("friends-mcp-server")
    expect((res.result as { capabilities: { tools: unknown } }).capabilities.tools).toBeDefined()
    server.stop()
  })

  it("returns the schemas on tools/list", async () => {
    const server = createFriendsMcpServer({ store: makeStore(), stdin: h.stdin, stdout: h.stdout })
    server.start()
    const res = await h.call({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    expect((res.result as { tools: unknown[] }).tools).toHaveLength(32)
    server.stop()
  })

  it("writes no response for a notification (no id)", async () => {
    const server = createFriendsMcpServer({ store: makeStore(), stdin: h.stdin, stdout: h.stdout })
    server.start()
    h.writeContentLength({ jsonrpc: "2.0", method: "initialized" })
    await flush()
    expect(h.parseAll()).toHaveLength(0)
    server.stop()
  })

  it("returns -32601 for an unknown method", async () => {
    const server = createFriendsMcpServer({ store: makeStore(), stdin: h.stdin, stdout: h.stdout })
    server.start()
    const res = await h.call({ jsonrpc: "2.0", id: 3, method: "nope/nope" })
    expect(res.error?.code).toBe(-32601)
    server.stop()
  })

  it("returns -32700 with id:null for a malformed body", async () => {
    const server = createFriendsMcpServer({ store: makeStore(), stdin: h.stdin, stdout: h.stdout })
    server.start()
    const body = "{not json"
    h.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    await flush()
    const res = h.parseAll()[0]
    expect(res.error?.code).toBe(-32700)
    expect(res.id).toBeNull()
    server.stop()
  })

  it("skips an invalid Content-Length header and processes the next message", async () => {
    const server = createFriendsMcpServer({ store: makeStore(), stdin: h.stdin, stdout: h.stdout })
    server.start()
    // A header block with no Content-Length value, followed by a real framed request.
    h.stdin.write("Content-Length:\r\n\r\n")
    const body = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" })
    h.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    await flush()
    const res = h.parseAll().find((r) => r.id === 9)
    expect(res).toBeDefined()
    server.stop()
  })

  it("handles newline-delimited framing and skips blank lines", async () => {
    const server = createFriendsMcpServer({ store: makeStore(), stdin: h.stdin, stdout: h.stdout })
    server.start()
    h.writeNewline("") // blank line first — skipped
    h.writeNewline(JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list" }))
    await flush()
    const responses = h.parseAll()
    expect(responses).toHaveLength(1)
    expect(responses[0].id).toBe(10)
    // response should be newline-framed (no Content-Length header)
    expect(h.out.startsWith("Content-Length:")).toBe(false)
    server.stop()
  })
})

describe("tools/call dispatch", () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })
  afterEach(() => {
    h.stdin.destroy()
    h.stdout.destroy()
  })

  function start(store: FriendStore) {
    const server = createFriendsMcpServer({ store, stdin: h.stdin, stdout: h.stdout })
    server.start()
    return server
  }

  it("resolve_party: created:true and stranger trust (after an owner seed)", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const { payload } = await h.tool("resolve_party", {
      provider: "aad",
      externalId: "x1",
      displayName: "Stranger",
      channel: "teams",
    })
    const p = payload as { created: boolean; friend: FriendRecord; channel: { channel: string } }
    expect(p.created).toBe(true)
    expect(p.friend.trustLevel).toBe("stranger")
    expect(p.channel.channel).toBe("teams")
  })

  it("resolve_party: created:false on a re-resolve of the same identity", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    await h.tool("resolve_party", { provider: "aad", externalId: "x1", displayName: "S", channel: "teams" })
    const { payload } = await h.tool("resolve_party", { provider: "aad", externalId: "x1", displayName: "S", channel: "teams" })
    expect((payload as { created: boolean }).created).toBe(false)
  })

  it("describe_trust: success and not-found", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    start(store)
    const ok = await h.tool("describe_trust", { friendId: owner.id, channel: "teams" })
    expect((ok.payload as { level: string }).level).toBe("family")
    const missing = await h.tool("describe_trust", { friendId: "nope", channel: "teams" })
    expect(missing.isError).toBe(true)
    expect((missing.payload as { status: string }).status).toBe("not_found")
  })

  // An agent-peer record with 3 first-party successes + familiarity 3 ⇒ "proven".
  function provenPeer(): FriendRecord {
    return {
      ...ownerRecord(),
      id: "peer-1",
      name: "PeerBot",
      role: "agent-peer",
      kind: "agent",
      externalIds: [{ provider: "a2a-agent" as IdentityProvider, externalId: "peer-1", linkedAt: NOW }],
      agentMeta: {
        bundleName: "peerbot",
        familiarity: 3,
        sharedMissions: [],
        outcomes: [
          { missionId: "m1", result: "success", timestamp: NOW },
          { missionId: "m2", result: "success", timestamp: NOW },
          { missionId: "m3", result: "success", timestamp: NOW },
        ],
      },
    }
  }

  it("assess_standing: success returns a Standing; not-found is isError", async () => {
    const store = makeStore([provenPeer()])
    start(store)
    const ok = await h.tool("assess_standing", { friendId: "peer-1" })
    expect(ok.isError).toBe(false)
    const standing = ok.payload as { tier: string; basisCount: number }
    expect(standing.tier).toBe("proven")
    expect(standing.basisCount).toBe(3)
    const missing = await h.tool("assess_standing", { friendId: "ghost" })
    expect(missing.isError).toBe(true)
    expect((missing.payload as { status: string }).status).toBe("not_found")
  })

  it("explain_standing: success returns a StandingExplanation with the trust guardrail; not-found is isError", async () => {
    const store = makeStore([provenPeer()])
    start(store)
    const ok = await h.tool("explain_standing", { friendId: "peer-1" })
    expect(ok.isError).toBe(false)
    const explanation = ok.payload as { standing: { tier: string }; advisory: string[] }
    expect(explanation.standing.tier).toBe("proven")
    expect(Array.isArray(explanation.advisory)).toBe(true)
    expect(explanation.advisory.length).toBeGreaterThan(0)
    expect(explanation.advisory.some((a) => a.includes("does not change") && a.includes("trust level"))).toBe(true)
    const missing = await h.tool("explain_standing", { friendId: "ghost" })
    expect(missing.isError).toBe(true)
    expect((missing.payload as { status: string }).status).toBe("not_found")
  })

  it("get_friend: by id, by name, and not-found", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    start(store)
    const byId = await h.tool("get_friend", { friendId: owner.id })
    expect((byId.payload as FriendRecord).id).toBe(owner.id)
    const missing = await h.tool("get_friend", { friendId: "ghost" })
    expect(missing.isError).toBe(true)
    expect((missing.payload as { status: string }).status).toBe("not_found")
  })

  it("get_friend: name fallback via FileFriendStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-mcp-getname-"))
    try {
      const store = new FileFriendStore(join(dir, "friends"))
      const owner = ownerRecord()
      await store.put(owner.id, owner) // awaited seed so the disk write completes
      start(store)
      const byName = await h.tool("get_friend", { friendId: "operator" })
      expect((byName.payload as FriendRecord).id).toBe(owner.id)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("list_friends: filters by trust and kind and slices by limit", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    await h.tool("onboard_agent", { name: "Bot", agentId: "peer-1" })
    await h.tool("resolve_party", { provider: "aad", externalId: "x1", displayName: "S", channel: "teams" })
    const all = await h.tool("list_friends", {})
    expect((all.payload as FriendRecord[]).length).toBe(3)
    const agents = await h.tool("list_friends", { kind: "agent" })
    expect((agents.payload as FriendRecord[]).every((f) => f.kind === "agent")).toBe(true)
    const family = await h.tool("list_friends", { trust: "family" })
    expect((family.payload as FriendRecord[]).every((f) => f.trustLevel === "family")).toBe(true)
    const limited = await h.tool("list_friends", { limit: "2" })
    expect((limited.payload as FriendRecord[]).length).toBe(2)
  })

  it("save_note: success and override_required, with string override coercion", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    start(store)
    const saved = await h.tool("save_note", { friendId: owner.id, type: "note", key: "role", content: "PM" })
    expect(saved.isError).toBe(false)
    expect((saved.payload as { status: string }).status).toBe("saved")
    const blocked = await h.tool("save_note", { friendId: owner.id, type: "note", key: "role", content: "Eng" })
    expect(blocked.isError).toBe(true)
    expect((blocked.payload as { status: string }).status).toBe("override_required")
    const overridden = await h.tool("save_note", { friendId: owner.id, type: "note", key: "role", content: "Eng", override: "true" })
    expect(overridden.isError).toBe(false)
    expect((overridden.payload as { status: string }).status).toBe("saved")
  })

  it("save_note: unknown type string yields an invalid result", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    start(store)
    const bad = await h.tool("save_note", { friendId: owner.id, type: "bogus", content: "x" })
    expect(bad.isError).toBe(true)
    expect((bad.payload as { status: string }).status).toBe("invalid")
  })

  it("record_interaction: usage-only accumulates tokens", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    start(store)
    const r = await h.tool("record_interaction", { friendId: owner.id, usage: { output_tokens: 42 } })
    expect((r.payload as { tokensAccumulated: boolean }).tokensAccumulated).toBe(true)
    const after = await h.tool("get_friend", { friendId: owner.id })
    expect((after.payload as FriendRecord).totalTokens).toBe(42)
  })

  it("record_interaction: outcome-only (string-encoded) records the outcome with coerced familiarityDelta", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const agent = await h.tool("onboard_agent", { name: "Bot", agentId: "peer-1" })
    const agentId = (agent.payload as FriendRecord).id
    const r = await h.tool("record_interaction", {
      friendId: agentId,
      outcome: JSON.stringify({ missionId: "m1", result: "success", note: "done" }),
      familiarityDelta: "3",
    })
    const payload = r.payload as { outcome: FriendRecord }
    expect(payload.outcome.agentMeta?.outcomes).toHaveLength(1)
    expect(payload.outcome.agentMeta?.familiarity).toBe(3)
  })

  it("record_interaction: usage and outcome together", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const agent = await h.tool("onboard_agent", { name: "Bot", agentId: "peer-1" })
    const agentId = (agent.payload as FriendRecord).id
    const r = await h.tool("record_interaction", {
      friendId: agentId,
      usage: { output_tokens: 10 },
      outcome: { missionId: "m1", result: "partial" },
    })
    const payload = r.payload as { tokensAccumulated: boolean; outcome: FriendRecord }
    expect(payload.tokensAccumulated).toBe(true)
    expect(payload.outcome.agentMeta?.outcomes).toHaveLength(1)
  })

  it("record_interaction: outcome present but not found returns an outcome:null", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const r = await h.tool("record_interaction", { friendId: "ghost", outcome: { missionId: "m1", result: "success" } })
    expect((r.payload as { outcome: unknown }).outcome).toBeNull()
  })

  it("record_interaction: a malformed outcome string is treated as absent", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    start(store)
    const r = await h.tool("record_interaction", { friendId: owner.id, outcome: "{bad json" })
    expect((r.payload as { status: string }).status).toBe("noop")
  })

  it("record_interaction: neither usage nor outcome is a noop", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    start(store)
    const r = await h.tool("record_interaction", { friendId: owner.id })
    expect((r.payload as { status: string }).status).toBe("noop")
  })

  it("upsert_group: promotes a stranger to acquaintance (participants string-encoded)", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    await h.tool("resolve_party", { provider: "aad", externalId: "x1", displayName: "S", channel: "teams" })
    const r = await h.tool("upsert_group", {
      groupExternalId: "group:proof;+;g1",
      participants: JSON.stringify([{ provider: "aad", externalId: "x1", displayName: "S" }]),
    })
    const results = r.payload as Array<{ trustLevel: string }>
    expect(results[0].trustLevel).toBe("acquaintance")
  })

  it("set_trust: updates the trust level", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    start(store)
    const r = await h.tool("set_trust", { friendId: owner.id, trustLevel: "friend" })
    expect((r.payload as { record: FriendRecord }).record.trustLevel).toBe("friend")
  })

  it("link_identity: links and merges, then resolves to the same friend", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const resolved = await h.tool("resolve_party", { provider: "aad", externalId: "x1", displayName: "S", channel: "teams" })
    const friendId = (resolved.payload as { friend: FriendRecord }).friend.id
    const linked = await h.tool("link_identity", { friendId, provider: "teams-conversation", externalId: "conv-1" })
    expect((linked.payload as { status: string }).status).toBe("linked")
    const reresolved = await h.tool("resolve_party", { provider: "teams-conversation", externalId: "conv-1", displayName: "S", channel: "teams" })
    expect((reresolved.payload as { friend: FriendRecord; created: boolean }).friend.id).toBe(friendId)
    expect((reresolved.payload as { created: boolean }).created).toBe(false)
  })

  it("unlink_identity: removes a linked identity", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    start(store)
    await h.tool("link_identity", { friendId: owner.id, provider: "teams-conversation", externalId: "conv-1" })
    const r = await h.tool("unlink_identity", { friendId: owner.id, provider: "teams-conversation", externalId: "conv-1" })
    expect((r.payload as { status: string }).status).toBe("unlinked")
  })

  it("onboard_agent: creates an agent peer (a2a string-encoded)", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const r = await h.tool("onboard_agent", {
      name: "PeerBot",
      agentId: "peer-1",
      a2a: JSON.stringify({ cardUrl: "https://card" }),
    })
    const rec = r.payload as FriendRecord
    expect(rec.kind).toBe("agent")
    expect(rec.role).toBe("agent-peer")
    expect(rec.agentMeta?.a2a?.cardUrl).toBe("https://card")
  })

  it("onboard_agent: threads a string-encoded mailbox coord onto top-level agentMeta.mailbox", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const r = await h.tool("onboard_agent", {
      name: "PeerBot",
      agentId: "peer-1",
      mailbox: JSON.stringify({ repo: "/m/mailbox", selfOutboxAgentId: "agent-a" }),
    })
    const rec = r.payload as FriendRecord
    expect(rec.agentMeta?.mailbox).toEqual({ repo: "/m/mailbox", selfOutboxAgentId: "agent-a" })
  })

  // Bug A (MCP path): onboard_agent with no trustLevel passes undefined straight
  // through to upsertAgentPeer, so the safe (stranger) default must land.
  it("onboard_agent: defaults a cold peer to stranger when no trustLevel is given", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const r = await h.tool("onboard_agent", { name: "PeerBot", agentId: "peer-cold" })
    const rec = r.payload as FriendRecord
    expect(rec.trustLevel).toBe("stranger")
  })

  it("onboard_agent: an explicit trustLevel still wins over the stranger default", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const r = await h.tool("onboard_agent", { name: "PeerBot", agentId: "peer-acq", trustLevel: "acquaintance" })
    const rec = r.payload as FriendRecord
    expect(rec.trustLevel).toBe("acquaintance")
  })

  it("whoami: reports the machine owner self", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const r = await h.tool("whoami", {})
    // machineOwner depends on the OS user; assert the shape is present
    expect(r.payload).toHaveProperty("machineOwner")
    expect(r.isError).toBe(false)
  })

  it("channel_caps: returns capabilities for a channel", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const r = await h.tool("channel_caps", { channel: "teams" })
    expect((r.payload as { channel: string }).channel).toBe("teams")
    expect((r.payload as { supportsMarkdown: boolean }).supportsMarkdown).toBe(true)
  })

  it("share_profile: reports unsupported when no grant store is wired", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store) // server started WITHOUT a grants store
    const r = await h.tool("share_profile", { friendId: "x", toAgentId: "y", scope: "identity" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("unknown tool name: isError with an Unknown tool message", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const res = await h.call({ jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name: "no_such_tool", arguments: {} } })
    const result = res.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Unknown tool")
  })

  it("a tool whose library fn throws is caught and returned as isError", async () => {
    const throwingStore: FriendStore = {
      async get() {
        throw new Error("boom")
      },
      async put() {},
      async delete() {},
      async findByExternalId() {
        return null
      },
      async listAll() {
        return []
      },
    }
    start(throwingStore)
    const res = await h.call({ jsonrpc: "2.0", id: nextId(), method: "tools/call", params: { name: "get_friend", arguments: { friendId: "x" } } })
    const result = res.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("boom")
  })
})

describe("lifecycle", () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })
  afterEach(() => {
    h.stdin.destroy()
    h.stdout.destroy()
  })

  it("start is idempotent, stop is idempotent, and stop before start is safe", async () => {
    const server = createFriendsMcpServer({ store: makeStore(), stdin: h.stdin, stdout: h.stdout })
    server.stop() // safe before start
    server.start()
    server.start() // idempotent
    const res = await h.call({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(res.id).toBe(1)
    server.stop()
    server.stop() // idempotent
    // After stop, the listener is removed — a further write produces no response.
    const beforeLen = h.parseAll().length
    h.writeContentLength({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    await flush()
    expect(h.parseAll().length).toBe(beforeLen)
  })
})

describe("coercion helpers", () => {
  it("coerceBool: true/'true' → true; everything else → false", () => {
    expect(coerceBool(true)).toBe(true)
    expect(coerceBool("true")).toBe(true)
    expect(coerceBool("false")).toBe(false)
    expect(coerceBool(false)).toBe(false)
    expect(coerceBool(undefined)).toBe(false)
  })

  it("coerceInt: number passthrough, string parse, undefined/null → undefined, NaN → undefined", () => {
    expect(coerceInt(5)).toBe(5)
    expect(coerceInt("7")).toBe(7)
    expect(coerceInt(undefined)).toBeUndefined()
    expect(coerceInt(null)).toBeUndefined()
    expect(coerceInt("not-a-number")).toBeUndefined()
  })

  it("coerceString: string passthrough else empty string", () => {
    expect(coerceString("x")).toBe("x")
    expect(coerceString(42)).toBe("")
    expect(coerceString(undefined)).toBe("")
  })

  it("coerceOptionalString: string passthrough else undefined", () => {
    expect(coerceOptionalString("x")).toBe("x")
    expect(coerceOptionalString(42)).toBeUndefined()
  })
})

describe("dispatch + server defensive branches", () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })
  afterEach(() => {
    h.stdin.destroy()
    h.stdout.destroy()
  })

  it("resolve_party defaults the displayName to 'Unknown' when absent", async () => {
    const store = makeStore()
    seedOwner(store)
    const server = createFriendsMcpServer({ store, stdin: h.stdin, stdout: h.stdout })
    server.start()
    const { payload } = await h.tool("resolve_party", { provider: "aad", externalId: "x1", channel: "teams" })
    expect((payload as { friend: FriendRecord }).friend.name).toBe("Unknown")
    server.stop()
  })

  it("list_friends returns [] when the store has no listAll", async () => {
    const noListAll: FriendStore = {
      async get() {
        return null
      },
      async put() {},
      async delete() {},
      async findByExternalId() {
        return null
      },
    }
    const server = createFriendsMcpServer({ store: noListAll, stdin: h.stdin, stdout: h.stdout })
    server.start()
    const { payload } = await h.tool("list_friends", {})
    expect(payload).toEqual([])
    server.stop()
  })

  it("upsert_group treats absent participants as an empty list", async () => {
    const store = makeStore()
    seedOwner(store)
    const server = createFriendsMcpServer({ store, stdin: h.stdin, stdout: h.stdout })
    server.start()
    const { payload } = await h.tool("upsert_group", { groupExternalId: "group:x;+;g1" })
    expect(payload).toEqual([])
    server.stop()
  })

  it("tools/call with no params is handled (defensive ?? fallbacks) as an unknown tool", async () => {
    const store = makeStore()
    seedOwner(store)
    const server = createFriendsMcpServer({ store, stdin: h.stdin, stdout: h.stdout })
    server.start()
    const res = await h.call({ jsonrpc: "2.0", id: nextId(), method: "tools/call" })
    const result = res.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain("Unknown tool")
    server.stop()
  })

  it("tools/call with params present but no name/arguments is handled as an unknown tool", async () => {
    const store = makeStore()
    seedOwner(store)
    const server = createFriendsMcpServer({ store, stdin: h.stdin, stdout: h.stdout })
    server.start()
    const res = await h.call({ jsonrpc: "2.0", id: nextId(), method: "tools/call", params: {} })
    const result = res.result as { content: Array<{ text: string }>; isError: boolean }
    expect(result.isError).toBe(true)
    server.stop()
  })
})

// ── SECURITY (finding 3, MEDIUM): the audit sink is wired into the LIVE dispatch
// path. Bug B's control-plane audit only lands end-to-end if the server threads a
// real AuditSink (+ actor/originSense) into set_trust / onboard_agent. Without this
// wiring the live trust mutations were silently unaudited. ──
describe("tools/call dispatch — control-plane audit wiring (finding 3)", () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })
  afterEach(() => {
    h.stdin.destroy()
    h.stdout.destroy()
  })

  function startAudited(store: FriendStore, audit: MemoryAuditSink, controlContext?: { actor?: string; originSense?: string }) {
    const server = createFriendsMcpServer({ store, audit, controlContext, stdin: h.stdin, stdout: h.stdout })
    server.start()
    return server
  }

  it("set_trust through dispatch writes exactly one audit record", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    const audit = new MemoryAuditSink()
    startAudited(store, audit)
    const r = await h.tool("set_trust", { friendId: owner.id, trustLevel: "friend" })
    expect((r.payload as { record: FriendRecord }).record.trustLevel).toBe("friend")
    const records = audit.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ action: "set_trust", targetId: owner.id, level: "friend" })
  })

  it("threads the supplied actor + originSense onto the audit record", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    const audit = new MemoryAuditSink()
    startAudited(store, audit, { actor: "operator-alias", originSense: "management" })
    await h.tool("set_trust", { friendId: owner.id, trustLevel: "acquaintance" })
    expect(audit.list()[0]).toMatchObject({ actor: "operator-alias", originSense: "management" })
  })

  it("defaults the actor/originSense to the stdio owner boundary when no controlContext is given (finding 3-A)", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    const audit = new MemoryAuditSink()
    startAudited(store, audit)
    await h.tool("set_trust", { friendId: owner.id, trustLevel: "friend" })
    const rec = audit.list()[0]
    // The stdio transport is owner-only (finding 3-A): default actor/originSense
    // reflect the local owner driving the CLI rather than the literal "unknown".
    expect(rec.actor).toBe("owner:stdio")
    expect(rec.originSense).toBe("stdio")
  })

  it("onboard_agent with an explicit trust seat writes one audit record (live trust mutation)", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    startAudited(store, audit)
    // Pass an explicit a2a.did so the audit record's targetDid is resolvable (the bare
    // agentId is not surfaced by resolveAgentIdentity, mirroring set_trust semantics).
    const r = await h.tool("onboard_agent", {
      name: "PeerBot",
      agentId: "peer-acq",
      trustLevel: "acquaintance",
      a2a: JSON.stringify({ did: "did:key:zPeerAcq" }),
    })
    expect((r.payload as FriendRecord).trustLevel).toBe("acquaintance")
    const records = audit.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ action: "set_trust", level: "acquaintance" })
    // targetId is the freshly-minted record id; targetDid is the peer's durable did.
    expect(records[0].targetId).toBe((r.payload as FriendRecord).id)
    expect(records[0].targetDid).toBe("did:key:zPeerAcq")
  })

  it("onboard_agent trust seat omits targetDid when the peer carries no resolvable did (only a bare agentId)", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    startAudited(store, audit)
    const r = await h.tool("onboard_agent", { name: "PeerBot", agentId: "peer-nodid", trustLevel: "friend" })
    const records = audit.list()
    expect(records).toHaveLength(1)
    expect(records[0].targetId).toBe((r.payload as FriendRecord).id)
    // No identity.did / a2a.did hint → targetDid is absent (the ?:{} false arm).
    expect(records[0].targetDid).toBeUndefined()
  })

  it("onboard_agent WITHOUT an explicit trust seat does NOT audit (cold contact is the safe default, not an owner trust decision)", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    startAudited(store, audit)
    await h.tool("onboard_agent", { name: "PeerBot", agentId: "peer-cold" })
    expect(audit.list()).toHaveLength(0)
  })

  it("set_trust through dispatch with NO audit sink wired is a clean no-op (back-compat)", async () => {
    const store = makeStore()
    const owner = seedOwner(store)
    const server = createFriendsMcpServer({ store, stdin: h.stdin, stdout: h.stdout })
    server.start()
    const r = await h.tool("set_trust", { friendId: owner.id, trustLevel: "friend" })
    expect((r.payload as { record: FriendRecord }).record.trustLevel).toBe("friend")
    server.stop()
  })

  it("a not_found set_trust writes no audit record (audit fires only on a real mutation)", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    startAudited(store, audit)
    const r = await h.tool("set_trust", { friendId: "missing", trustLevel: "friend" })
    expect(r.isError).toBe(true)
    expect(audit.list()).toHaveLength(0)
  })
})

// ── connect_to dispatch (p11 inc2, brick 8) — the management-sense control plane ──
// The stdio path is owner-only ⇒ a `local` management sense (controlContext.senseType
// ?? "local"), so the gate COMMITS; a network transport that constructs the server with
// controlContext.senseType = "open" (or "closed") drives the downgrade / membership path.
describe("tools/call dispatch — connect_to (p11 inc2)", () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })
  afterEach(() => {
    h.stdin.destroy()
    h.stdout.destroy()
  })

  function start(store: FriendStore, audit?: MemoryAuditSink, controlContext?: { actor?: string; originSense?: string; senseType?: "open" | "closed" | "local" | "internal"; membership?: { decision: string } }) {
    const server = createFriendsMcpServer({ store, audit, controlContext, stdin: h.stdin, stdout: h.stdout })
    server.start()
    return server
  }

  it("default stdio path (no controlContext) gets a LOCAL management sense → COMMITS, links + audits action:'connect'", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    start(store, audit)
    const r = await h.tool("connect_to", { agentId: "peer-1", name: "Peer One" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; status: string; record: FriendRecord }
    expect(payload.ok).toBe(true)
    expect(payload.status).toBe("connected")
    expect(payload.record.trustLevel).toBe("family") // own-fleet default
    const records = audit.list()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ action: "connect", level: "family", originSense: "stdio", actor: "owner:stdio" })
  })

  it("honors an explicit trustLevel arg on the link", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    start(store, audit)
    const r = await h.tool("connect_to", { agentId: "peer-2", trustLevel: "friend" })
    const payload = r.payload as { ok: boolean; record: FriendRecord }
    expect(payload.record.trustLevel).toBe("friend")
    expect((audit.list()[0] as ControlPlaneAuditRecord).level).toBe("friend")
  })

  it("an injected senseType:'open' controlContext yields the DOWNGRADED result (isError true), NO link, NO audit", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    start(store, audit, { senseType: "open" })
    const r = await h.tool("connect_to", { agentId: "peer-3" })
    expect(r.isError).toBe(true)
    const payload = r.payload as { ok: boolean; status: string; downgrade?: { decision: string; reason: string } }
    expect(payload.ok).toBe(false)
    expect(payload.status).toBe("downgraded")
    expect(payload.downgrade).toEqual({ decision: "downgrade", reason: "open_sense_needs_confirmation" })
    expect(audit.list()).toHaveLength(0)
  })

  it("an injected senseType:'closed' WITHOUT a family membership downgrades (closed_sense_not_member)", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    start(store, audit, { senseType: "closed" })
    const r = await h.tool("connect_to", { agentId: "peer-4" })
    expect(r.isError).toBe(true)
    const payload = r.payload as { ok: boolean; status: string; downgrade?: { reason: string } }
    expect(payload.status).toBe("downgraded")
    expect(payload.downgrade?.reason).toBe("closed_sense_not_member")
    expect(audit.list()).toHaveLength(0)
  })

  it("an injected senseType:'closed' WITH a family_same_account membership COMMITS", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    start(store, audit, { senseType: "closed", membership: { decision: "family_same_account" } })
    const r = await h.tool("connect_to", { agentId: "peer-5", name: "Peer Five" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; status: string }
    expect(payload.ok).toBe(true)
    expect(payload.status).toBe("connected")
    expect(audit.list()).toHaveLength(1)
  })

  it("a bare name with no record hit → needs_handle_or_introduction (isError true), NO audit", async () => {
    const store = makeStore()
    seedOwner(store)
    const audit = new MemoryAuditSink()
    start(store, audit)
    const r = await h.tool("connect_to", { name: "Nobody Known" })
    expect(r.isError).toBe(true)
    const payload = r.payload as { ok: boolean; status: string }
    expect(payload.ok).toBe(false)
    expect(payload.status).toBe("needs_handle_or_introduction")
    expect(audit.list()).toHaveLength(0)
  })

  it("a did arg is threaded to the library (a did with no record → needs_handle_or_introduction)", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const r = await h.tool("connect_to", { did: "did:key:zUnknownPeer" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("needs_handle_or_introduction")
  })

  it("works with NO audit sink wired (the link is made; no audit appended)", async () => {
    const store = makeStore()
    seedOwner(store)
    const server = createFriendsMcpServer({ store, stdin: h.stdin, stdout: h.stdout })
    server.start()
    const r = await h.tool("connect_to", { agentId: "peer-nosink" })
    expect(r.isError).toBe(false)
    expect((r.payload as { ok: boolean }).ok).toBe(true)
    server.stop()
  })
})

// ── Cross-agent moat dispatch (N11 + N12) ──

function makeGrantStore(initial: ShareGrant[] = []): GrantStore {
  const grants = new Map<string, ShareGrant>()
  for (const g of initial) grants.set(g.id, g)
  return {
    async get(id) {
      return grants.get(id) ?? null
    },
    async put(id, grant) {
      grants.set(id, grant)
    },
    async delete(id) {
      grants.delete(id)
    },
    async listAll() {
      return Array.from(grants.values())
    },
  }
}

describe("moat tools/call dispatch", () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })
  afterEach(() => {
    h.stdin.destroy()
    h.stdout.destroy()
  })

  function start(store: FriendStore, grants?: GrantStore) {
    const server = createFriendsMcpServer({ store, grants, stdin: h.stdin, stdout: h.stdout })
    server.start()
    return server
  }

  function friendOf(overrides: Partial<FriendRecord> = {}): FriendRecord {
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
      ...overrides,
    }
  }

  it("resolve_room: returns members carrying the group id with trust + knownVia", async () => {
    const store = makeStore([
      friendOf({
        id: "m-1",
        name: "Alice",
        trustLevel: "acquaintance",
        externalIds: [
          { provider: "aad", externalId: "alice", linkedAt: NOW },
          { provider: "aad", externalId: "group:proj;+;g1", linkedAt: NOW },
        ],
      }),
    ])
    start(store)
    const r = await h.tool("resolve_room", { groupExternalId: "group:proj;+;g1" })
    const view = r.payload as { groupExternalId: string; members: Array<{ friend: { name: string }; knownVia: string }> }
    expect(view.members).toHaveLength(1)
    expect(view.members[0].friend.name).toBe("Alice")
    expect(view.members[0].knownVia).toBe("direct")
  })

  it("share_profile: reports unsupported with no grant store", async () => {
    const store = makeStore([friendOf()])
    start(store) // no grants
    const r = await h.tool("share_profile", { friendId: "subj-1", toAgentId: "agent-2", scope: "identity" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("share_profile: rejects an unrecognized scope", async () => {
    const store = makeStore([friendOf()])
    start(store, makeGrantStore())
    const r = await h.tool("share_profile", { friendId: "subj-1", toAgentId: "agent-2", scope: "everything" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("invalid")
  })

  it("share_profile: produces an envelope when consent is satisfied (identity via trust)", async () => {
    // The self (owner) is family; the recipient agent is a friend so tiered consents on identity.
    const store = makeStore([
      ownerRecord(),
      friendOf(),
      {
        ...friendOf(),
        id: "rec-1",
        name: "Peer",
        role: "agent-peer",
        kind: "agent",
        externalIds: [{ provider: "a2a-agent", externalId: "agent-2", linkedAt: NOW }],
      },
    ])
    start(store, makeGrantStore())
    const r = await h.tool("share_profile", { friendId: "subj-1", toAgentId: "agent-2", scope: "identity" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; envelope: { subject: { displayName: string }; fromAgentId: string } }
    expect(payload.ok).toBe(true)
    expect(payload.envelope.subject.displayName).toBe("Jordan")
    // self identity came from whoami → the owner's friend id.
    expect(payload.envelope.fromAgentId).toBe("owner-1")
  })

  it("share_profile: returns ok:false no_consent when the policy refuses", async () => {
    const store = makeStore([ownerRecord(), friendOf()]) // recipient unknown → stranger
    start(store, makeGrantStore())
    const r = await h.tool("share_profile", { friendId: "subj-1", toAgentId: "unknown", scope: "identity" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("no_consent")
  })

  it("share_profile: self id is empty when whoami resolves no self (no owner/family)", async () => {
    // No owner record and no family friend → whoami returns no self → selfAgentId "".
    const store = makeStore([
      friendOf(), // subject at friend trust (not family, externalId not local)
      {
        ...friendOf(),
        id: "rec-1",
        name: "Peer",
        role: "agent-peer",
        kind: "agent",
        externalIds: [{ provider: "a2a-agent", externalId: "agent-2", linkedAt: NOW }],
      },
    ])
    start(store, makeGrantStore())
    const r = await h.tool("share_profile", { friendId: "subj-1", toAgentId: "agent-2", scope: "identity" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; envelope: { fromAgentId: string } }
    expect(payload.ok).toBe(true)
    expect(payload.envelope.fromAgentId).toBe("")
  })

  it("import_profile: imports an envelope into an existing party", async () => {
    const store = makeStore([friendOf({ trustLevel: "acquaintance" })])
    start(store)
    const envelope = {
      subject: { externalIds: [{ provider: "aad", externalId: "jordan-aad", linkedAt: NOW }], displayName: "Jordan" },
      fromAgentId: "source",
      scope: "notes:safe",
      notes: [{ key: "role", value: "PM" }],
      issuedAt: NOW,
    }
    const r = await h.tool("import_profile", { envelope, fromAgentId: "source", trustOfSource: "friend" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; status: string; record: FriendRecord }
    expect(payload.status).toBe("imported")
    expect(payload.record.importedNotes?.source.role.value).toBe("PM")
  })

  it("import_profile: accepts a string-encoded envelope", async () => {
    const store = makeStore([friendOf({ trustLevel: "acquaintance" })])
    start(store)
    const envelope = JSON.stringify({
      subject: { externalIds: [{ provider: "aad", externalId: "jordan-aad", linkedAt: NOW }], displayName: "Jordan" },
      fromAgentId: "source",
      scope: "identity",
      issuedAt: NOW,
    })
    const r = await h.tool("import_profile", { envelope, fromAgentId: "source", trustOfSource: "friend" })
    expect(r.isError).toBe(false)
    expect((r.payload as { status: string }).status).toBe("imported")
  })

  it("import_profile: rejects a missing/malformed envelope", async () => {
    const store = makeStore()
    start(store)
    const missing = await h.tool("import_profile", { fromAgentId: "source", trustOfSource: "friend" })
    expect(missing.isError).toBe(true)
    expect((missing.payload as { status: string }).status).toBe("invalid")
    const malformed = await h.tool("import_profile", { envelope: "{bad json", fromAgentId: "source", trustOfSource: "friend" })
    expect(malformed.isError).toBe(true)
    expect((malformed.payload as { status: string }).status).toBe("invalid")
  })

  it("import_profile: surfaces an untrusted_source refusal as isError", async () => {
    const store = makeStore([friendOf()])
    start(store)
    const envelope = {
      subject: { externalIds: [{ provider: "aad", externalId: "jordan-aad", linkedAt: NOW }], displayName: "Jordan" },
      fromAgentId: "source",
      scope: "identity",
      issuedAt: NOW,
    }
    const r = await h.tool("import_profile", { envelope, fromAgentId: "source", trustOfSource: "stranger" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("untrusted_source")
  })

  it("grant_share / list_shares / revoke_share: full consent lifecycle", async () => {
    const store = makeStore([friendOf()])
    const grants = makeGrantStore()
    start(store, grants)

    const granted = await h.tool("grant_share", { subjectFriendId: "subj-1", recipientAgentId: "agent-2", scope: "notes:safe" })
    expect(granted.isError).toBe(false)
    const grantId = (granted.payload as ShareGrant).id
    expect(grantId).toBeTruthy()

    const listed = await h.tool("list_shares", { subjectFriendId: "subj-1" })
    const all = listed.payload as Array<{ id: string; effective: boolean }>
    expect(all).toHaveLength(1)
    expect(all[0].effective).toBe(true)

    const effectiveOnly = await h.tool("list_shares", { effectiveOnly: "true" })
    expect((effectiveOnly.payload as unknown[]).length).toBe(1)

    const revoked = await h.tool("revoke_share", { grantId })
    expect(revoked.isError).toBe(false)
    expect((revoked.payload as { status: string }).status).toBe("revoked")

    const afterRevoke = await h.tool("list_shares", { effectiveOnly: "true" })
    expect((afterRevoke.payload as unknown[]).length).toBe(0)
  })

  it("grant_share: rejects an unrecognized scope", async () => {
    const store = makeStore([friendOf()])
    start(store, makeGrantStore())
    const r = await h.tool("grant_share", { subjectFriendId: "subj-1", recipientAgentId: "agent-2", scope: "bogus" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("invalid")
  })

  it("Fork D: grant_share mints via the NEW arg name subjectKey", async () => {
    const store = makeStore([friendOf()])
    start(store, makeGrantStore())
    const r = await h.tool("grant_share", { subjectKey: "subj-1", recipientAgentId: "agent-2", scope: "notes:safe" })
    expect(r.isError).toBe(false)
    const grant = r.payload as ShareGrant
    expect(grant.id).toBeTruthy()
    expect(grant.subjectKey).toBe("subj-1")
  })

  it("Fork D: grant_share STILL mints via the OLD arg name subjectFriendId (seam b)", async () => {
    const store = makeStore([friendOf()])
    start(store, makeGrantStore())
    const r = await h.tool("grant_share", { subjectFriendId: "subj-1", recipientAgentId: "agent-2", scope: "notes:safe" })
    expect(r.isError).toBe(false)
    const grant = r.payload as ShareGrant
    expect(grant.id).toBeTruthy()
    // The persisted grant carries the new field name regardless of which arg minted it.
    expect(grant.subjectKey).toBe("subj-1")
  })

  it("Fork D: grant_share with a mission scope keyed by missionKey", async () => {
    const store = makeStore([friendOf()])
    const grants = makeGrantStore()
    start(store, grants)
    const r = await h.tool("grant_share", { subjectKey: "PROJ-1234", recipientAgentId: "agent-2", scope: "mission" })
    expect(r.isError).toBe(false)
    expect((r.payload as ShareGrant).subjectKey).toBe("PROJ-1234")
    expect((r.payload as ShareGrant).scope).toBe("mission")
    // list_shares filters by the new subjectKey arg too.
    const listed = await h.tool("list_shares", { subjectKey: "PROJ-1234" })
    expect((listed.payload as ShareGrant[]).map((g) => g.id)).toEqual([(r.payload as ShareGrant).id])
  })

  it("grant_share: carries an explicit expiresAt", async () => {
    const store = makeStore([friendOf()])
    start(store, makeGrantStore())
    const r = await h.tool("grant_share", {
      subjectFriendId: "subj-1",
      recipientAgentId: "agent-2",
      scope: "notes:all",
      expiresAt: "2999-01-01T00:00:00.000Z",
    })
    expect((r.payload as ShareGrant).expiresAt).toBe("2999-01-01T00:00:00.000Z")
  })

  it("revoke_share: not_found surfaces as isError", async () => {
    const store = makeStore()
    start(store, makeGrantStore())
    const r = await h.tool("revoke_share", { grantId: "ghost" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("not_found")
  })

  it("grant_share / revoke_share / list_shares: all report unsupported with no grant store", async () => {
    const store = makeStore([friendOf()])
    start(store) // no grants
    for (const [tool, args] of [
      ["grant_share", { subjectFriendId: "subj-1", recipientAgentId: "agent-2", scope: "identity" }],
      ["revoke_share", { grantId: "g-1" }],
      ["list_shares", {}],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await h.tool(tool, args)
      expect(r.isError).toBe(true)
      expect((r.payload as { status: string }).status).toBe("unsupported")
    }
  })
})

// ── Mission ledger tools/call dispatch (brick 3) ──

function makeMissionStore(initial: MissionRecord[] = []): MissionStore {
  const missions = new Map<string, MissionRecord>()
  for (const m of initial) missions.set(m.id, m)
  return {
    async get(id) {
      return missions.get(id) ?? null
    },
    async put(id, mission) {
      missions.set(id, mission)
    },
    async delete(id) {
      missions.delete(id)
    },
    async findByMissionKey(missionKey) {
      for (const m of missions.values()) {
        if (m.missionKey === missionKey) return m
      }
      return null
    },
    async listAll() {
      return Array.from(missions.values())
    },
  }
}

function missionOf(overrides: Partial<MissionRecord> = {}): MissionRecord {
  return {
    id: "m-1",
    missionKey: "PROJ-1234",
    title: "Ship it",
    status: "active",
    participants: [],
    outcomes: [],
    learnings: {},
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

describe("mission tools/call dispatch", () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })
  afterEach(() => {
    h.stdin.destroy()
    h.stdout.destroy()
  })

  function start(store: FriendStore, grants?: GrantStore, missions?: MissionStore) {
    const server = createFriendsMcpServer({ store, grants, missions, stdin: h.stdin, stdout: h.stdout })
    server.start()
    return server
  }

  function ownerStore(): FriendStore {
    return makeStore([ownerRecord()])
  }

  // ── record_mission ──

  it("record_mission: reports unsupported with no mission store", async () => {
    start(ownerStore())
    const r = await h.tool("record_mission", { missionKey: "PROJ-1234" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("record_mission: creates a mission via recordMission (learnings string-encoded)", async () => {
    const missions = makeMissionStore()
    start(ownerStore(), undefined, missions)
    const r = await h.tool("record_mission", {
      missionKey: "PROJ-1234",
      title: "Ship it",
      learnings: JSON.stringify([{ key: "gotcha", value: "rebase", shareable: true }]),
    })
    expect(r.isError).toBe(false)
    const rec = r.payload as MissionRecord
    expect(rec.missionKey).toBe("PROJ-1234")
    expect(rec.learnings.gotcha.value).toBe("rebase")
    expect(rec.learnings.gotcha.shareable).toBe(true)
  })

  it("record_mission: upserts an existing mission and threads participants/outcomes/status", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerStore(), undefined, missions)
    const r = await h.tool("record_mission", {
      missionKey: "PROJ-1234",
      status: "succeeded",
      participants: JSON.stringify([{ agentId: "agent-b" }]),
      outcomes: JSON.stringify([{ missionId: "ext-1", result: "success" }]),
    })
    const rec = r.payload as MissionRecord
    expect(rec.id).toBe("m-1")
    expect(rec.status).toBe("succeeded")
    expect(rec.participants.map((p) => p.agentId)).toEqual(["agent-b"])
    expect(rec.outcomes).toHaveLength(1)
  })

  // ── get_mission ──

  it("get_mission: reports unsupported with no mission store", async () => {
    start(ownerStore())
    const r = await h.tool("get_mission", { missionId: "m-1" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("get_mission: returns the record by local UUID id", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerStore(), undefined, missions)
    const r = await h.tool("get_mission", { missionId: "m-1" })
    expect(r.isError).toBe(false)
    expect((r.payload as MissionRecord).missionKey).toBe("PROJ-1234")
  })

  it("get_mission: not-found surfaces as isError", async () => {
    const missions = makeMissionStore()
    start(ownerStore(), undefined, missions)
    const r = await h.tool("get_mission", { missionId: "ghost" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("not_found")
  })

  // ── list_missions ──

  it("list_missions: reports unsupported with no mission store", async () => {
    start(ownerStore())
    const r = await h.tool("list_missions", {})
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("list_missions: lists all, optionally limited", async () => {
    const missions = makeMissionStore([
      missionOf({ id: "m-1", missionKey: "K1" }),
      missionOf({ id: "m-2", missionKey: "K2" }),
    ])
    start(ownerStore(), undefined, missions)
    const all = await h.tool("list_missions", {})
    expect((all.payload as MissionRecord[]).length).toBe(2)
    const limited = await h.tool("list_missions", { limit: "1" })
    expect((limited.payload as MissionRecord[]).length).toBe(1)
  })

  // ── share_mission ──

  it("share_mission: reports unsupported when no mission store is wired", async () => {
    start(ownerStore(), makeGrantStore()) // grants but no missions
    const r = await h.tool("share_mission", { missionId: "m-1", toAgentId: "agent-b", scope: "mission" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("share_mission: reports unsupported when no grant store is wired", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerStore(), undefined, missions) // missions but no grants
    const r = await h.tool("share_mission", { missionId: "m-1", toAgentId: "agent-b", scope: "mission" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("share_mission: rejects an unrecognized scope", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerStore(), makeGrantStore(), missions)
    const r = await h.tool("share_mission", { missionId: "m-1", toAgentId: "agent-b", scope: "everything" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("invalid")
  })

  it("share_mission: no_consent for a mission scope with no grant (self from whoami)", async () => {
    const missions = makeMissionStore([missionOf()])
    // owner is family → whoami resolves self; recipient unknown → stranger; mission needs a grant.
    start(ownerStore(), makeGrantStore(), missions)
    const r = await h.tool("share_mission", { missionId: "m-1", toAgentId: "agent-b", scope: "mission" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("no_consent")
  })

  it("share_mission: self id is empty when whoami resolves no self (no owner/family)", async () => {
    // No owner/family record → whoami returns no self → selfAgentId "".
    const missions = makeMissionStore([missionOf({ learnings: { g: { value: "v", savedAt: NOW, shareable: true } } })])
    const store = makeStore([
      {
        ...ownerRecord(),
        id: "rec-1",
        name: "Peer",
        role: "agent-peer",
        kind: "agent",
        trustLevel: "friend",
        externalIds: [{ provider: "a2a-agent", externalId: "agent-b", linkedAt: NOW }], // not a local owner
      },
    ])
    const grants = makeGrantStore([
      { id: "g-1", subjectKey: "PROJ-1234", recipientAgentId: "agent-b", scope: "mission", grantedAt: NOW },
    ])
    start(store, grants, missions)
    const r = await h.tool("share_mission", { missionId: "m-1", toAgentId: "agent-b", scope: "mission" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; envelope: { fromAgentId: string } }
    expect(payload.ok).toBe(true)
    expect(payload.envelope.fromAgentId).toBe("")
  })

  it("share_mission: produces an envelope when a mission grant is present (self from whoami)", async () => {
    const missions = makeMissionStore([missionOf({ learnings: { g: { value: "v", savedAt: NOW, shareable: true } } })])
    const store = makeStore([
      ownerRecord(),
      {
        ...ownerRecord(),
        id: "rec-1",
        name: "Peer",
        role: "agent-peer",
        kind: "agent",
        trustLevel: "friend",
        externalIds: [{ provider: "a2a-agent", externalId: "agent-b", linkedAt: NOW }],
      },
    ])
    const grants = makeGrantStore([
      { id: "g-1", subjectKey: "PROJ-1234", recipientAgentId: "agent-b", scope: "mission", grantedAt: NOW },
    ])
    start(store, grants, missions)
    const r = await h.tool("share_mission", { missionId: "m-1", toAgentId: "agent-b", scope: "mission" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; envelope: { subject: { missionKey: string }; fromAgentId: string; learnings: unknown[] } }
    expect(payload.ok).toBe(true)
    expect(payload.envelope.subject.missionKey).toBe("PROJ-1234")
    // self id came from whoami → the owner's friend id.
    expect(payload.envelope.fromAgentId).toBe("owner-1")
    expect(payload.envelope.learnings).toHaveLength(1)
  })

  // ── import_mission ──

  it("import_mission: reports unsupported with no mission store", async () => {
    start(ownerStore())
    const envelope = { subject: { missionKey: "PROJ-1234", title: "T" }, fromAgentId: "agent-a", scope: "mission", learnings: [], issuedAt: NOW }
    const r = await h.tool("import_mission", { envelope, fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("import_mission: rejects a missing/malformed envelope", async () => {
    const missions = makeMissionStore()
    start(ownerStore(), undefined, missions)
    const missing = await h.tool("import_mission", { fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(missing.isError).toBe(true)
    expect((missing.payload as { status: string }).status).toBe("invalid")
    const malformed = await h.tool("import_mission", { envelope: "{bad json", fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(malformed.isError).toBe(true)
    expect((malformed.payload as { status: string }).status).toBe("invalid")
  })

  it("import_mission: imports an envelope into an existing mission (string-encoded)", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerStore(), undefined, missions)
    const envelope = JSON.stringify({
      subject: { missionKey: "PROJ-1234", title: "Ship it" },
      fromAgentId: "agent-a",
      scope: "mission",
      learnings: [{ key: "gotcha", value: "from-a" }],
      issuedAt: NOW,
    })
    const r = await h.tool("import_mission", { envelope, fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; status: string; record: MissionRecord }
    expect(payload.status).toBe("imported")
    expect(payload.record.importedLearnings?.["agent-a"].gotcha.value).toBe("from-a")
  })

  it("import_mission: surfaces an untrusted_source refusal as isError", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerStore(), undefined, missions)
    const envelope = { subject: { missionKey: "PROJ-1234", title: "Ship it" }, fromAgentId: "agent-a", scope: "mission", learnings: [], issuedAt: NOW }
    const r = await h.tool("import_mission", { envelope, fromAgentId: "agent-a", trustOfSource: "stranger" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("untrusted_source")
  })

  // ── send_result (gap-2: prepareMissionResult) ──

  it("send_result: reports unsupported when no mission store is wired", async () => {
    start(ownerStore(), makeGrantStore()) // grants but no missions
    const r = await h.tool("send_result", { missionId: "m-1", toAgentId: "agent-a", requestId: "req-1", result: JSON.stringify({ summary: "done" }) })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("send_result: reports unsupported when no grant store is wired", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerStore(), undefined, missions) // missions but no grants
    const r = await h.tool("send_result", { missionId: "m-1", toAgentId: "agent-a", requestId: "req-1", result: JSON.stringify({ summary: "done" }) })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("send_result: no_consent for an unknown (stranger) recipient", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerStore(), makeGrantStore(), missions)
    const r = await h.tool("send_result", { missionId: "m-1", toAgentId: "agent-a", requestId: "req-1", result: JSON.stringify({ summary: "done" }) })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("no_consent")
  })

  it("send_result: produces a result envelope attributed to self (from whoami), named by missionKey", async () => {
    const missions = makeMissionStore([missionOf()])
    // owner is family → whoami self; a friend recipient record for agent-a so coordinate consents at the identity tier.
    const store = makeStore([
      ownerRecord(),
      { ...ownerRecord(), id: "rec-a", name: "Delegator", role: "agent-peer", kind: "agent", trustLevel: "friend", externalIds: [{ provider: "a2a-agent", externalId: "agent-a", linkedAt: NOW }] },
    ])
    start(store, makeGrantStore(), missions)
    const r = await h.tool("send_result", { missionId: "m-1", toAgentId: "agent-a", requestId: "req-1", result: JSON.stringify({ summary: "Auth audited", outputs: { findings: "2" } }) })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; envelope: { subject: { missionKey: string }; fromAgentId: string; requestId: string; result: { summary: string } } }
    expect(payload.ok).toBe(true)
    expect(payload.envelope.subject.missionKey).toBe("PROJ-1234")
    expect(payload.envelope.fromAgentId).toBe("owner-1") // self from whoami
    expect(payload.envelope.requestId).toBe("req-1")
    expect(payload.envelope.result.summary).toBe("Auth audited")
  })

  it("send_result: not_found when the missionId does not resolve", async () => {
    const missions = makeMissionStore() // empty
    start(ownerStore(), makeGrantStore(), missions)
    const r = await h.tool("send_result", { missionId: "ghost", toAgentId: "agent-a", requestId: "req-1", result: JSON.stringify({ summary: "x" }) })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("not_found")
  })

  it("send_result: self id is empty when whoami resolves no self (no owner/family)", async () => {
    const missions = makeMissionStore([missionOf()])
    // No owner/family record → whoami returns no self → selfAgentId "". A friend recipient
    // for agent-a so the coordinate scope consents at the identity tier.
    const store = makeStore([
      { ...ownerRecord(), id: "rec-a", name: "Delegator", role: "agent-peer", kind: "agent", trustLevel: "friend", externalIds: [{ provider: "a2a-agent", externalId: "agent-a", linkedAt: NOW }] },
    ])
    start(store, makeGrantStore(), missions)
    const r = await h.tool("send_result", { missionId: "m-1", toAgentId: "agent-a", requestId: "req-1", result: JSON.stringify({ summary: "done" }) })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; envelope: { fromAgentId: string } }
    expect(payload.ok).toBe(true)
    expect(payload.envelope.fromAgentId).toBe("")
  })

  it("send_result: a missing/malformed result arg defaults to an empty-summary deliverable", async () => {
    const missions = makeMissionStore([missionOf()])
    const store = makeStore([
      ownerRecord(),
      { ...ownerRecord(), id: "rec-a", name: "Delegator", role: "agent-peer", kind: "agent", trustLevel: "friend", externalIds: [{ provider: "a2a-agent", externalId: "agent-a", linkedAt: NOW }] },
    ])
    start(store, makeGrantStore(), missions)
    // no `result` arg → parseMaybeJson undefined → defaults to { summary: "" }
    const r = await h.tool("send_result", { missionId: "m-1", toAgentId: "agent-a", requestId: "req-1" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; envelope: { result: { summary: string } } }
    expect(payload.ok).toBe(true)
    expect(payload.envelope.result.summary).toBe("")
  })

  // ── import_result (gap-2: importMissionResult) ──

  it("import_result: reports unsupported with no mission store", async () => {
    start(ownerStore())
    const envelope = { subject: { missionKey: "PROJ-1234", title: "T" }, fromAgentId: "agent-b", requestId: "req-1", result: { requestId: "req-1", summary: "done" }, issuedAt: NOW }
    const r = await h.tool("import_result", { envelope, fromAgentId: "agent-b", trustOfSource: "friend" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("import_result: rejects a missing/malformed envelope", async () => {
    const missions = makeMissionStore()
    start(ownerStore(), undefined, missions)
    const missing = await h.tool("import_result", { fromAgentId: "agent-b", trustOfSource: "friend" })
    expect(missing.isError).toBe(true)
    expect((missing.payload as { status: string }).status).toBe("invalid")
    const malformed = await h.tool("import_result", { envelope: "{bad json", fromAgentId: "agent-b", trustOfSource: "friend" })
    expect(malformed.isError).toBe(true)
    expect((malformed.payload as { status: string }).status).toBe("invalid")
  })

  it("import_result: lands B's deliverable on A's mission (correlated to a first-party delegation)", async () => {
    const missionWithDelegation = missionOf({ delegations: { "req-1": { task: { requestId: "req-1", summary: "Audit auth" }, provenance: { origin: "first_party" } } } })
    const missions = makeMissionStore([missionWithDelegation])
    start(ownerStore(), undefined, missions)
    const envelope = JSON.stringify({ subject: { missionKey: "PROJ-1234", title: "Ship it" }, fromAgentId: "agent-b", requestId: "req-1", result: { requestId: "req-1", summary: "Auth audited - 2 findings" }, issuedAt: NOW })
    const r = await h.tool("import_result", { envelope, fromAgentId: "agent-b", trustOfSource: "friend" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; status: string; record: MissionRecord }
    expect(payload.ok).toBe(true)
    expect(payload.status).toBe("imported")
    expect(payload.record.importedResults!["agent-b"]["req-1"].summary).toBe("Auth audited - 2 findings")
  })

  it("import_result: no_delegation when the result correlates to no prior delegation (isError true)", async () => {
    const missions = makeMissionStore([missionOf()]) // no delegations
    start(ownerStore(), undefined, missions)
    const envelope = JSON.stringify({ subject: { missionKey: "PROJ-1234", title: "Ship it" }, fromAgentId: "agent-b", requestId: "req-1", result: { requestId: "req-1", summary: "x" }, issuedAt: NOW })
    const r = await h.tool("import_result", { envelope, fromAgentId: "agent-b", trustOfSource: "friend" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("no_delegation")
  })

  it("import_result: untrusted_source for a stranger source (isError true)", async () => {
    const missions = makeMissionStore([missionOf({ delegations: { "req-1": { task: { requestId: "req-1", summary: "t" }, provenance: { origin: "first_party" } } } })])
    start(ownerStore(), undefined, missions)
    const envelope = { subject: { missionKey: "PROJ-1234", title: "Ship it" }, fromAgentId: "agent-b", requestId: "req-1", result: { requestId: "req-1", summary: "x" }, issuedAt: NOW }
    const r = await h.tool("import_result", { envelope, fromAgentId: "agent-b", trustOfSource: "stranger" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("untrusted_source")
  })
})

describe("coordination tools/call dispatch (brick 5)", () => {
  let h: Harness
  beforeEach(() => {
    h = new Harness()
  })
  afterEach(() => {
    h.stdin.destroy()
    h.stdout.destroy()
  })

  function start(store: FriendStore, grants?: GrantStore, missions?: MissionStore) {
    const server = createFriendsMcpServer({ store, grants, missions, stdin: h.stdin, stdout: h.stdout })
    server.start()
    return server
  }

  /** Owner (so whoami resolves self) + a FRIEND a2a-peer for `agent-b` (so the
   * identity-tier "coordinate" scope consents under the tiered default). */
  function ownerAndFriendPeer(): FriendStore {
    return makeStore([
      ownerRecord(),
      {
        ...ownerRecord(),
        id: "rec-b",
        name: "Peer B",
        role: "agent-peer",
        kind: "agent",
        trustLevel: "friend",
        externalIds: [{ provider: "a2a-agent", externalId: "agent-b", linkedAt: NOW }],
      },
    ])
  }

  // ── coordinate (producer) ──

  it("coordinate: reports unsupported when no mission store is wired", async () => {
    start(ownerAndFriendPeer(), makeGrantStore()) // grants but no missions
    const r = await h.tool("coordinate", { missionId: "m-1", toAgentId: "agent-b", intent: "request" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("coordinate: reports unsupported when no grant store is wired", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerAndFriendPeer(), undefined, missions) // missions but no grants
    const r = await h.tool("coordinate", { missionId: "m-1", toAgentId: "agent-b", intent: "request" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("coordinate: rejects an unrecognized intent", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerAndFriendPeer(), makeGrantStore(), missions)
    const r = await h.tool("coordinate", { missionId: "m-1", toAgentId: "agent-b", intent: "cancel" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("invalid")
  })

  it("coordinate: no_consent for an unknown (stranger) recipient", async () => {
    const missions = makeMissionStore([missionOf()])
    // owner resolves self; recipient agent-z is unknown → stranger → no_consent.
    start(ownerAndFriendPeer(), makeGrantStore(), missions)
    const r = await h.tool("coordinate", { missionId: "m-1", toAgentId: "agent-z", intent: "request" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("no_consent")
  })

  it("coordinate: produces a request envelope for a friend peer (self from whoami)", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerAndFriendPeer(), makeGrantStore(), missions)
    const r = await h.tool("coordinate", { missionId: "m-1", toAgentId: "agent-b", intent: "request", note: "take the API side?" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; envelope: { intent: string; subject: { missionKey: string }; fromAgentId: string; note: string } }
    expect(payload.ok).toBe(true)
    expect(payload.envelope.intent).toBe("request")
    expect(payload.envelope.subject.missionKey).toBe("PROJ-1234")
    expect(payload.envelope.fromAgentId).toBe("owner-1")
    expect(payload.envelope.note).toBe("take the API side?")
  })

  it("coordinate: self id is empty when whoami resolves no self (no owner/family)", async () => {
    // No owner/family record → whoami returns no self → selfAgentId "" (the ?? "" arm).
    // The recipient peer is still a friend, so the identity-tier scope consents.
    const missions = makeMissionStore([missionOf()])
    const store = makeStore([
      {
        ...ownerRecord(),
        id: "rec-b",
        name: "Peer B",
        role: "agent-peer",
        kind: "agent",
        trustLevel: "friend",
        externalIds: [{ provider: "a2a-agent", externalId: "agent-b", linkedAt: NOW }], // not a local owner
      },
    ])
    start(store, makeGrantStore(), missions)
    const r = await h.tool("coordinate", { missionId: "m-1", toAgentId: "agent-b", intent: "request" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; envelope: { fromAgentId: string } }
    expect(payload.ok).toBe(true)
    expect(payload.envelope.fromAgentId).toBe("")
  })

  it("coordinate: a handoff by a non-assignee surfaces not_assignee (the one precondition)", async () => {
    const missions = makeMissionStore([missionOf()]) // no assignee
    start(ownerAndFriendPeer(), makeGrantStore(), missions)
    const r = await h.tool("coordinate", { missionId: "m-1", toAgentId: "agent-b", intent: "handoff", proposedAssignee: JSON.stringify({ agentId: "agent-b" }) })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("not_assignee")
  })

  it("coordinate: an accept claims the assignment (assignee=self) — readable via get_coordination", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerAndFriendPeer(), makeGrantStore(), missions)
    const acc = await h.tool("coordinate", { missionId: "m-1", toAgentId: "agent-b", intent: "accept" })
    expect(acc.isError).toBe(false)
    const read = await h.tool("get_coordination", { missionId: "m-1" })
    expect((read.payload as { assignee: { agentId: string } }).assignee.agentId).toBe("owner-1")
  })

  // ── import_coordination (consumer) ──

  it("import_coordination: reports unsupported with no mission store", async () => {
    start(ownerAndFriendPeer())
    const envelope = { subject: { missionKey: "PROJ-1234", title: "T" }, fromAgentId: "agent-a", intent: "request", issuedAt: NOW }
    const r = await h.tool("import_coordination", { envelope, fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("import_coordination: rejects a missing/malformed envelope", async () => {
    const missions = makeMissionStore()
    start(ownerAndFriendPeer(), undefined, missions)
    const missing = await h.tool("import_coordination", { fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(missing.isError).toBe(true)
    expect((missing.payload as { status: string }).status).toBe("invalid")
    const malformed = await h.tool("import_coordination", { envelope: "{bad json", fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(malformed.isError).toBe(true)
    expect((malformed.payload as { status: string }).status).toBe("invalid")
  })

  it("import_coordination: an accept assigns the sender (status assigned, string-encoded)", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerAndFriendPeer(), undefined, missions)
    const envelope = JSON.stringify({
      subject: { missionKey: "PROJ-1234", title: "Ship it" },
      fromAgentId: "agent-a",
      intent: "accept",
      issuedAt: NOW,
    })
    const r = await h.tool("import_coordination", { envelope, fromAgentId: "agent-a", trustOfSource: "friend" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { ok: boolean; status: string; record: MissionRecord }
    expect(payload.status).toBe("assigned")
    expect(payload.record.coordination?.assignee?.agentId).toBe("agent-a")
  })

  it("import_coordination: surfaces an untrusted_source refusal as isError", async () => {
    const missions = makeMissionStore([missionOf()])
    start(ownerAndFriendPeer(), undefined, missions)
    const envelope = { subject: { missionKey: "PROJ-1234", title: "Ship it" }, fromAgentId: "agent-a", intent: "request", issuedAt: NOW }
    const r = await h.tool("import_coordination", { envelope, fromAgentId: "agent-a", trustOfSource: "stranger" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("untrusted_source")
  })

  // ── get_coordination (read lens) ──

  it("get_coordination: reports unsupported with no mission store", async () => {
    start(ownerAndFriendPeer())
    const r = await h.tool("get_coordination", { missionId: "m-1" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("unsupported")
  })

  it("get_coordination: returns the empty default for a mission that was never coordinated", async () => {
    const missions = makeMissionStore([missionOf()]) // no coordination sub-object
    start(ownerAndFriendPeer(), undefined, missions)
    const r = await h.tool("get_coordination", { missionId: "m-1" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { assignee: undefined; log: unknown[] }
    expect(payload.assignee).toBeUndefined()
    expect(payload.log).toEqual([])
  })

  it("get_coordination: returns the populated coordination sub-object when present", async () => {
    const missions = makeMissionStore([
      missionOf({ coordination: { assignee: { agentId: "agent-b" }, assignedAt: NOW, log: [{ intent: "accept", fromAgentId: "agent-b", at: NOW }] } }),
    ])
    start(ownerAndFriendPeer(), undefined, missions)
    const r = await h.tool("get_coordination", { missionId: "m-1" })
    expect(r.isError).toBe(false)
    const payload = r.payload as { assignee: { agentId: string }; log: unknown[] }
    expect(payload.assignee.agentId).toBe("agent-b")
    expect(payload.log).toHaveLength(1)
  })

  it("get_coordination: not-found surfaces as isError", async () => {
    const missions = makeMissionStore()
    start(ownerAndFriendPeer(), undefined, missions)
    const r = await h.tool("get_coordination", { missionId: "ghost" })
    expect(r.isError).toBe(true)
    expect((r.payload as { status: string }).status).toBe("not_found")
  })
})
