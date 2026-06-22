import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { PassThrough } from "node:stream"
import { existsSync, rmSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { runMain } from "../mcp/run-main"

const flush = () => new Promise((r) => setImmediate(r))

interface Captured {
  out: string
}

function harness() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const cap: Captured = { out: "" }
  stdout.on("data", (chunk: Buffer) => {
    cap.out += chunk.toString("utf-8")
  })
  return { stdin, stdout, cap }
}

function frame(msg: Record<string, unknown>): string {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
}

const dirs: string[] = []
function tmpDir(suffix: string): string {
  const d = join(tmpdir(), `friends-runmain-${suffix}-${Math.random().toString(36).slice(2)}`)
  dirs.push(d)
  return d
}

describe("runMain", () => {
  let onError: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onError = vi.fn()
  })

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("constructs a FileFriendStore from --dir and serves requests, wiring the sibling _grants/ + _missions/", async () => {
    const { stdin, stdout, cap } = harness()
    const dir = tmpDir("flag")
    const server = runMain(["node", "bin.js", "--dir", dir], {}, { stdin, stdout, onError })
    expect(server).not.toBeNull()
    expect(onError).not.toHaveBeenCalled()
    expect(existsSync(dir)).toBe(true) // FileFriendStore mkdirs the path
    // openFileBundle wires the sibling collections — proving missions is threaded.
    expect(existsSync(join(dir, "_grants"))).toBe(true)
    expect(existsSync(join(dir, "_missions"))).toBe(true)

    stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
    for (let i = 0; i < 50 && !cap.out.includes("protocolVersion"); i++) await flush()
    expect(cap.out).toContain("protocolVersion")
    expect(cap.out).toContain("friends-mcp-server")
    server!.stop()
    stdin.destroy()
    stdout.destroy()
  })

  it("wires the control-plane audit sink end-to-end: a live set_trust writes one record to _audit/control.jsonl (finding 3)", async () => {
    const { stdin, stdout, cap } = harness()
    const dir = tmpDir("audit")
    const server = runMain(["node", "bin.js", "--dir", dir], {}, { stdin, stdout, onError })
    expect(server).not.toBeNull()

    // Onboard an agent peer (so there is a friend to mutate), then set its trust.
    stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "onboard_agent", arguments: { name: "Bot", agentId: "peer-1" } } }))
    for (let i = 0; i < 50 && !cap.out.includes("\"id\":1"); i++) await flush()
    const onboardRes = cap.out.match(/\{"jsonrpc":"2\.0","id":1.*?\}\}(?=Content-Length|$)/s)
    expect(onboardRes).not.toBeNull()
    const friendId = JSON.parse(JSON.parse(onboardRes![0]).result.content[0].text).id as string

    cap.out = ""
    stdin.write(frame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "set_trust", arguments: { friendId, trustLevel: "friend" } } }))
    for (let i = 0; i < 50 && !cap.out.includes("\"id\":2"); i++) await flush()

    // The append is best-effort after store.put; give the fs/promises chain a beat.
    const auditFile = join(dir, "_audit", "control.jsonl")
    for (let i = 0; i < 50 && !existsSync(auditFile); i++) await flush()
    expect(existsSync(auditFile)).toBe(true)
    const lines = readFileSync(auditFile, "utf-8").trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0]) as { action: string; targetId: string; level: string; actor: string; originSense: string }
    expect(rec).toMatchObject({ action: "set_trust", targetId: friendId, level: "friend", actor: "owner:stdio", originSense: "stdio" })

    server!.stop()
    stdin.destroy()
    stdout.destroy()
  })

  it("falls back to FRIENDS_DIR from the environment when no flag is given", async () => {
    const { stdin, stdout } = harness()
    const dir = tmpDir("env")
    const server = runMain(["node", "bin.js"], { FRIENDS_DIR: dir }, { stdin, stdout, onError })
    expect(server).not.toBeNull()
    expect(onError).not.toHaveBeenCalled()
    expect(existsSync(dir)).toBe(true)
    server!.stop()
    stdin.destroy()
    stdout.destroy()
  })

  it("prefers the --dir flag over FRIENDS_DIR when both are present", async () => {
    const { stdin, stdout } = harness()
    const flagDir = tmpDir("flagwins")
    const envDir = tmpDir("envloses")
    const server = runMain(["node", "bin.js", "--dir", flagDir], { FRIENDS_DIR: envDir }, { stdin, stdout, onError })
    expect(server).not.toBeNull()
    expect(existsSync(flagDir)).toBe(true)
    expect(existsSync(envDir)).toBe(false) // env dir never constructed
    server!.stop()
    stdin.destroy()
    stdout.destroy()
  })

  it("calls onError and constructs nothing when neither flag nor env is provided", () => {
    const { stdin, stdout } = harness()
    const server = runMain(["node", "bin.js"], {}, { stdin, stdout, onError })
    expect(server).toBeNull()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toContain("--dir")
    stdin.destroy()
    stdout.destroy()
  })

  it("calls onError when --dir is the last arg with no value", () => {
    const { stdin, stdout } = harness()
    const server = runMain(["node", "bin.js", "--dir"], {}, { stdin, stdout, onError })
    expect(server).toBeNull()
    expect(onError).toHaveBeenCalledTimes(1)
    stdin.destroy()
    stdout.destroy()
  })
})
