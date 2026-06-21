import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { PassThrough } from "node:stream"
import { existsSync, rmSync } from "fs"
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

  it("constructs a FileFriendStore from --dir and serves requests", async () => {
    const { stdin, stdout, cap } = harness()
    const dir = tmpDir("flag")
    const server = runMain(["node", "bin.js", "--dir", dir], {}, { stdin, stdout, onError })
    expect(server).not.toBeNull()
    expect(onError).not.toHaveBeenCalled()
    expect(existsSync(dir)).toBe(true) // FileFriendStore mkdirs the path

    stdin.write(frame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
    for (let i = 0; i < 50 && !cap.out.includes("protocolVersion"); i++) await flush()
    expect(cap.out).toContain("protocolVersion")
    expect(cap.out).toContain("friends-mcp-server")
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
