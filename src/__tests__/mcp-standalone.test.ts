// Standalone harness-agnosticism proof.
//
// SPAWNS the built `dist/mcp/bin.js` as a child process and drives the friends
// MCP server over JSON-RPC/stdio against a temp directory. ZERO Ouroboros code
// is in the loop — this test imports only node built-ins (child_process, fs, os,
// path) and speaks the protocol directly. Green = harness-agnosticism proven.
//
// Per D13 this spawned child does NOT contribute to v8 coverage of src/mcp/*
// (separate process); the in-process Unit 7/8 tests carry the 100%. Both are
// required: the in-process tests for coverage, this one for the genuine proof.
import { describe, it, expect, afterEach } from "vitest"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The bin is built by the `pretest` / `pretest:coverage` hook (D12). Resolve it
// relative to this test file and fail fast with a clear message if it's missing.
const BIN_PATH = join(__dirname, "..", "..", "dist", "mcp", "bin.js")

type Framing = "newline" | "content-length"

interface JsonRpcResponse {
  jsonrpc: string
  id: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

/** A tiny JSON-RPC-over-stdio client for the spawned server. Parses BOTH
 * Content-Length and newline-delimited framing from stdout. */
class McpChild {
  private readonly child: ChildProcessWithoutNullStreams
  private buf = ""
  private readonly pending = new Map<number, (res: JsonRpcResponse) => void>()
  private nextId = 1

  constructor(dir: string) {
    this.child = spawn("node", [BIN_PATH, "--dir", dir], { stdio: ["pipe", "pipe", "pipe"] })
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf-8")
      this.drain()
    })
  }

  private drain(): void {
    // Parse as many framed responses as are complete in the buffer.
    for (;;) {
      if (this.buf.startsWith("Content-Length:")) {
        const headerEnd = this.buf.indexOf("\r\n\r\n")
        if (headerEnd === -1) return
        const len = parseInt(this.buf.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i)![1], 10)
        const bodyStart = headerEnd + 4
        if (this.buf.length < bodyStart + len) return
        const body = this.buf.slice(bodyStart, bodyStart + len)
        this.buf = this.buf.slice(bodyStart + len)
        this.deliver(body)
      } else {
        const nl = this.buf.indexOf("\n")
        if (nl === -1) return
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (line.length > 0) this.deliver(line)
      }
    }
  }

  private deliver(body: string): void {
    const res = JSON.parse(body) as JsonRpcResponse
    const id = typeof res.id === "number" ? res.id : -1
    const resolve = this.pending.get(id)
    if (resolve) {
      this.pending.delete(id)
      resolve(res)
    }
  }

  request(method: string, params: Record<string, unknown>, framing: Framing = "newline"): Promise<JsonRpcResponse> {
    const id = this.nextId++
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout waiting for response to ${method} (id ${id})`))
      }, 5000)
      this.pending.set(id, (res) => {
        clearTimeout(timer)
        resolve(res)
      })
      if (framing === "content-length") {
        this.child.stdin.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`)
      } else {
        this.child.stdin.write(msg + "\n")
      }
    })
  }

  /** Call a tool and return the parsed JSON payload + isError. */
  async tool(
    name: string,
    args: Record<string, unknown>,
    framing: Framing = "newline",
  ): Promise<{ payload: any; isError: boolean }> {
    const res = await this.request("tools/call", { name, arguments: args }, framing)
    const result = res.result as { content: Array<{ text: string }>; isError: boolean }
    return { payload: JSON.parse(result.content[0].text), isError: result.isError }
  }

  kill(): void {
    this.child.stdin.end()
    this.child.kill()
  }
}

describe("standalone harness-agnosticism proof (spawned child)", () => {
  let child: McpChild | undefined
  let child2: McpChild | undefined
  let dir: string | undefined

  afterEach(() => {
    child?.kill()
    child2?.kill()
    child = undefined
    child2 = undefined
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it("fails fast if the built bin is missing", () => {
    // The pretest build (D12) must have emitted the bin before this suite runs.
    expect(existsSync(BIN_PATH), `expected built bin at ${BIN_PATH} — run \`npm run build\` (pretest does this)`).toBe(true)
  })

  it("drives the full 9-call script over newline framing, then a Content-Length pass", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-standalone-"))
    child = new McpChild(dir)

    // Handshake.
    const init = await child.request("initialize", {})
    expect(init.result?.protocolVersion).toBe("2024-11-05")

    // ── Call 0 (setup, the resolver gotcha) ──
    // The temp dir is EMPTY, so the FIRST resolve_party would imprint as
    // family/primary (isFirstImprint = !hasAnyFriends). Seed an owner imprint
    // first so hasAnyFriends() is true thereafter and call 2 resolves as a
    // stranger. This is the real resolver ordering trap.
    const seed = await child.tool("resolve_party", {
      provider: "local",
      externalId: "operator",
      displayName: "operator",
      channel: "cli",
    })
    expect(seed.payload.created).toBe(true)
    expect(seed.payload.friend.trustLevel).toBe("family") // owner imprints as family

    // ── 1. whoami ──
    const who = await child.tool("whoami", {})
    expect(who.payload).toHaveProperty("machineOwner")

    // ── 2. resolve_party → stranger, created:true (works BECAUSE of the seed) ──
    const stranger = await child.tool("resolve_party", {
      provider: "aad",
      externalId: "x1",
      displayName: "Stranger",
      channel: "teams",
    })
    expect(stranger.payload.created).toBe(true)
    expect(stranger.payload.friend.trustLevel).toBe("stranger")
    const strangerId = stranger.payload.friend.id as string

    // ── 3. describe_trust → basis unknown, level stranger ──
    const trust = await child.tool("describe_trust", { friendId: strangerId, channel: "teams" })
    expect(trust.payload.basis).toBe("unknown")
    expect(trust.payload.level).toBe("stranger")

    // ── 4. save_note ──
    const note = await child.tool("save_note", { friendId: strangerId, type: "note", key: "role", content: "PM" })
    expect(note.isError).toBe(false)
    expect(note.payload.status).toBe("saved")

    // ── 5. record_interaction (usage) → totalTokens bumps to 42 ──
    await child.tool("record_interaction", { friendId: strangerId, usage: { output_tokens: 42 } })
    const afterUsage = await child.tool("get_friend", { friendId: strangerId })
    expect(afterUsage.payload.totalTokens).toBe(42)

    // ── 6. upsert_group → stranger promoted to acquaintance ──
    const group = await child.tool("upsert_group", {
      groupExternalId: "group:proof;+;g1",
      participants: [{ provider: "aad", externalId: "x1", displayName: "Stranger" }],
    })
    expect(group.payload[0].trustLevel).toBe("acquaintance")

    // ── 7. link_identity then re-resolve via the new identity → same id, created:false ──
    const linked = await child.tool("link_identity", { friendId: strangerId, provider: "teams-conversation", externalId: "conv-1" })
    expect(["linked", "merged"]).toContain(linked.payload.status)
    const reresolved = await child.tool("resolve_party", {
      provider: "teams-conversation",
      externalId: "conv-1",
      displayName: "Stranger",
      channel: "teams",
    })
    expect(reresolved.payload.friend.id).toBe(strangerId) // cross-channel unification
    expect(reresolved.payload.created).toBe(false)

    // ── 8. onboard_agent → kind:agent, role:agent-peer ──
    const agent = await child.tool("onboard_agent", { name: "PeerBot", agentId: "peer-1" })
    expect(agent.payload.kind).toBe("agent")
    expect(agent.payload.role).toBe("agent-peer")

    // ── 9. list_friends → roster contains the acquaintance human + the agent peer ──
    const roster = await child.tool("list_friends", {})
    const names = (roster.payload as Array<{ name: string }>).map((f) => f.name)
    expect(names).toContain("Stranger")
    expect(names).toContain("PeerBot")
    const agentsOnly = await child.tool("list_friends", { kind: "agent" })
    expect((agentsOnly.payload as Array<{ kind: string }>).every((f) => f.kind === "agent")).toBe(true)
    expect((agentsOnly.payload as unknown[]).length).toBe(1)

    // ── Second pass: dual framing. The first child auto-detected NEWLINE
    // framing from its first message and responds newline-framed for its whole
    // life. To prove the Content-Length framing path end-to-end (request AND
    // response), spawn a FRESH child against the same populated dir and speak
    // Content-Length from its very first message. ──
    child2 = new McpChild(dir)
    const initCL = await child2.request("initialize", {}, "content-length")
    expect(initCL.result?.protocolVersion).toBe("2024-11-05")
    const whoCL = await child2.tool("whoami", {}, "content-length")
    expect(whoCL.payload).toHaveProperty("machineOwner")
    const rosterCL = await child2.tool("list_friends", {}, "content-length")
    expect((rosterCL.payload as unknown[]).length).toBeGreaterThanOrEqual(3)
  })

  it("drives the cross-agent moat end-to-end over the spawned bin (room + grant + share + import)", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-moat-"))
    child = new McpChild(dir)
    await child.request("initialize", {})

    // Seed an owner so the bundle is non-empty (the resolver imprint trap), then
    // imprint the owner as the self for whoami → share_profile's fromAgentId.
    const owner = await child.tool("resolve_party", { provider: "local", externalId: "operator", displayName: "operator", channel: "cli" })
    const ownerId = owner.payload.friend.id as string

    // A subject friend the owner knows, and an agent peer to share with.
    const jordan = await child.tool("resolve_party", { provider: "aad", externalId: "jordan-aad", displayName: "Jordan", channel: "teams" })
    const jordanId = jordan.payload.friend.id as string
    await child.tool("save_note", { friendId: jordanId, type: "note", key: "role", content: "PM" })
    await child.tool("onboard_agent", { name: "PeerBot", agentId: "peer-9" })

    // ── resolve_room: put both the owner and Jordan in a group, then resolve it. ──
    await child.tool("upsert_group", {
      groupExternalId: "group:proj;+;room1",
      participants: [
        { provider: "aad", externalId: "jordan-aad", displayName: "Jordan" },
        { provider: "local", externalId: "operator", displayName: "operator" },
      ],
    })
    const room = await child.tool("resolve_room", { groupExternalId: "group:proj;+;room1" })
    const roomNames = (room.payload.members as Array<{ friend: { name: string } }>).map((m) => m.friend.name).sort()
    expect(roomNames).toContain("Jordan")

    // ── Consent lifecycle: grant notes:safe of Jordan to peer-9, persisted to _grants/. ──
    const granted = await child.tool("grant_share", { subjectFriendId: jordanId, recipientAgentId: "peer-9", scope: "notes:safe" })
    const grantId = granted.payload.id as string
    expect(existsSync(join(dir, "_grants"))).toBe(true) // sibling grant collection wired via --dir
    const shares = await child.tool("list_shares", { subjectFriendId: jordanId })
    expect((shares.payload as Array<{ effective: boolean }>)[0].effective).toBe(true)

    // ── Producer: a notes:safe share of Jordan to peer-9. The "role" note was not
    // marked shareable, so notes:safe carries nothing — but the envelope is still
    // consented + names Jordan by join key. ──
    const share = await child.tool("share_profile", { friendId: jordanId, toAgentId: "peer-9", scope: "notes:safe" })
    expect(share.payload.ok).toBe(true)
    expect(share.payload.envelope.subject.displayName).toBe("Jordan")
    expect(share.payload.envelope.fromAgentId).toBe(ownerId) // self from whoami
    // The local UUID must never appear on the wire.
    expect(JSON.stringify(share.payload.envelope)).not.toContain(jordanId)

    // ── Consumer: hand-craft an envelope from a FRIEND source and import it. The
    // imported fact lands in importedNotes; first-party notes/trust are untouched. ──
    const envelope = {
      subject: { externalIds: [{ provider: "aad", externalId: "jordan-aad", linkedAt: new Date().toISOString() }], displayName: "Jordan" },
      fromAgentId: "peer-9",
      scope: "notes:all",
      notes: [{ key: "city", value: "Seattle", originallyAssertedBy: { agentId: "peer-9" } }],
      issuedAt: new Date().toISOString(),
    }
    // Capture trust immediately BEFORE the import (Jordan was promoted to
    // acquaintance by upsert_group earlier) so we prove the IMPORT leaves it be.
    const before = await child.tool("get_friend", { friendId: jordanId })
    const trustBeforeImport = before.payload.trustLevel as string
    const imported = await child.tool("import_profile", { envelope, fromAgentId: "peer-9", trustOfSource: "friend" })
    expect(imported.payload.status).toBe("imported")
    const after = await child.tool("get_friend", { friendId: jordanId })
    expect(after.payload.importedNotes["peer-9"].city.value).toBe("Seattle")
    expect(after.payload.notes.role.value).toBe("PM") // first-party untouched
    expect(after.payload.trustLevel).toBe(trustBeforeImport) // trust unchanged by import

    // ── Revoke: the grant is tombstoned and no longer effective. ──
    const revoked = await child.tool("revoke_share", { grantId })
    expect(revoked.payload.status).toBe("revoked")
    const afterRevoke = await child.tool("list_shares", { effectiveOnly: "true" })
    expect((afterRevoke.payload as unknown[]).length).toBe(0)
  })
})
