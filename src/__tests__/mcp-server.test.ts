import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { PassThrough } from "node:stream"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { createFriendsMcpServer, getToolSchemas } from "../mcp"
import { coerceBool, coerceInt, coerceString, coerceOptionalString } from "../mcp/dispatch"
import { FileFriendStore } from "../index"
import type { FriendStore, FriendRecord, IdentityProvider } from "../index"

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

const flush = () => new Promise((r) => setImmediate(r))

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
  it("returns exactly the 14 tools with object input schemas", () => {
    const schemas = getToolSchemas()
    const names = schemas.map((s) => s.name).sort()
    expect(names).toEqual(
      [
        "channel_caps",
        "describe_trust",
        "get_friend",
        "link_identity",
        "list_friends",
        "onboard_agent",
        "record_interaction",
        "resolve_party",
        "save_note",
        "set_trust",
        "share_profile",
        "unlink_identity",
        "upsert_group",
        "whoami",
      ].sort(),
    )
    expect(schemas).toHaveLength(14)
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
    expect((res.result as { tools: unknown[] }).tools).toHaveLength(14)
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

  it("share_profile: returns the reserved { supported:false } stub", async () => {
    const store = makeStore()
    seedOwner(store)
    start(store)
    const r = await h.tool("share_profile", { friendId: "x", toAgentId: "y", scope: "z" })
    expect(r.payload).toEqual({ supported: false })
    expect(r.isError).toBe(false)
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
