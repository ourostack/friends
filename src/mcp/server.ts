// createFriendsMcpServer — a JSON-RPC 2.0 server over stdio for the friends
// library. It runs NO agent turn, NO daemon, NO LLM: every tools/call is a pure
// record read/write dispatched to the library. That is exactly what makes it
// harness-agnostic.
//
// Dual stdio framing: Content-Length (Claude Code) and newline-delimited JSON
// (Codex), auto-detected from the first message. The framing plumbing is ported
// from the harness's MCP server with all conversation/socket machinery removed.
import { emitNervesEvent } from "../observability"
import type { FriendStore } from "../store"
import type { GrantStore } from "../grant-store"
import type { MissionStore } from "../mission-store"
import { getToolSchemas } from "./schemas"
import { dispatchTool } from "./dispatch"

interface JsonRpcRequest {
  jsonrpc: string
  id?: number | string | null
  method: string
  params?: { name?: string; arguments?: Record<string, unknown> }
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

export interface FriendsMcpServerOptions {
  store: FriendStore
  /** Optional consent-grant store. When omitted, the consent/share tools
   * (grant_share / revoke_share / list_shares / share_profile) report
   * `unsupported`; everything else works store-only. */
  grants?: GrantStore
  /** Optional mission store. When omitted, the mission ledger tools
   * (record_mission / get_mission / list_missions / share_mission /
   * import_mission) report `unsupported`; everything else works without it. */
  missions?: MissionStore
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
}

export interface FriendsMcpServer {
  start(): void
  stop(): void
}

export function createFriendsMcpServer(options: FriendsMcpServerOptions): FriendsMcpServer {
  const { store, grants, missions, stdin, stdout } = options
  let buffer = ""
  let running = false
  let useContentLengthFraming = true
  let framingDetected = false

  function writeResponse(response: JsonRpcResponse): void {
    const body = JSON.stringify(response)
    if (useContentLengthFraming) {
      stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    } else {
      stdout.write(body + "\n")
    }
  }

  function tryParseContentLength(): boolean {
    const headerEnd = buffer.indexOf("\r\n\r\n")
    /* v8 ignore next -- partial header delivery only in real I/O @preserve */
    if (headerEnd === -1) return false

    const headerSection = buffer.slice(0, headerEnd)
    const contentLengthMatch = headerSection.match(/Content-Length:\s*(\d+)/i)
    if (!contentLengthMatch) {
      buffer = buffer.slice(headerEnd + 4)
      return true
    }

    const contentLength = parseInt(contentLengthMatch[1], 10)
    const bodyStart = headerEnd + 4
    /* v8 ignore next -- partial body delivery only in real I/O @preserve */
    if (buffer.length < bodyStart + contentLength) return false

    const body = buffer.slice(bodyStart, bodyStart + contentLength)
    buffer = buffer.slice(bodyStart + contentLength)
    parseAndDispatch(body)
    return true
  }

  function tryParseNewlineDelimited(): boolean {
    const newlineIdx = buffer.indexOf("\n")
    /* v8 ignore next -- partial line delivery only in real I/O @preserve */
    if (newlineIdx === -1) return false

    const line = buffer.slice(0, newlineIdx).trim()
    buffer = buffer.slice(newlineIdx + 1)
    if (line.length === 0) return true
    parseAndDispatch(line)
    return true
  }

  function parseAndDispatch(body: string): void {
    let request: JsonRpcRequest
    try {
      request = JSON.parse(body) as JsonRpcRequest
    } catch {
      writeResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
      return
    }
    void handleRequest(request)
  }

  function handleData(chunk: Buffer): void {
    buffer += chunk.toString("utf-8")
    if (!framingDetected && buffer.length > 0) {
      useContentLengthFraming = buffer.startsWith("Content-Length:")
      framingDetected = true
    }
    while (buffer.length > 0) {
      const hasContentLength = buffer.startsWith("Content-Length:")
      const parsed = hasContentLength ? tryParseContentLength() : tryParseNewlineDelimited()
      /* v8 ignore next -- break on partial message only in real I/O @preserve */
      if (!parsed) break
    }
  }

  async function handleRequest(request: JsonRpcRequest): Promise<void> {
    emitNervesEvent({
      component: "clients",
      event: "clients.mcp_request_start",
      message: "handling friends mcp request",
      meta: { method: request.method },
    })

    if (request.id === undefined) {
      emitNervesEvent({
        component: "clients",
        event: "clients.mcp_request_end",
        message: "handled friends mcp notification",
        meta: { method: request.method },
      })
      return
    }

    switch (request.method) {
      case "initialize":
        handleInitialize(request.id)
        break
      case "tools/list":
        handleToolsList(request.id)
        break
      case "tools/call":
        await handleToolsCall(request)
        break
      default:
        writeResponse({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        })
        break
    }

    emitNervesEvent({
      component: "clients",
      event: "clients.mcp_request_end",
      message: "completed friends mcp request",
      meta: { method: request.method },
    })
  }

  function handleInitialize(id: number | string | null): void {
    writeResponse({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "friends-mcp-server", version: "0.1.0" },
        capabilities: { tools: { listChanged: false } },
      },
    })
  }

  function handleToolsList(id: number | string | null): void {
    writeResponse({ jsonrpc: "2.0", id, result: { tools: getToolSchemas() } })
  }

  async function handleToolsCall(request: JsonRpcRequest): Promise<void> {
    const params = request.params ?? {}
    const toolName = params.name ?? ""
    const toolArgs = params.arguments ?? {}
    try {
      const { result, isError } = await dispatchTool(store, toolName, toolArgs, grants, missions)
      writeResponse({
        jsonrpc: "2.0",
        id: request.id!,
        result: { content: [{ type: "text", text: JSON.stringify(result) }], isError },
      })
    } catch (error) {
      /* v8 ignore next -- defensive: non-Error throw is unreachable; tests inject Error @preserve */
      const message = error instanceof Error ? error.message : String(error)
      writeResponse({
        jsonrpc: "2.0",
        id: request.id!,
        result: { content: [{ type: "text", text: `Error: ${message}` }], isError: true },
      })
    }
  }

  function onData(chunk: Buffer): void {
    handleData(chunk)
  }

  return {
    start() {
      if (running) return
      running = true
      stdin.on("data", onData)
      emitNervesEvent({
        component: "clients",
        event: "clients.mcp_server_start",
        message: "friends mcp server started",
        meta: {},
      })
    },
    stop() {
      if (!running) return
      running = false
      stdin.removeListener("data", onData)
      emitNervesEvent({
        component: "clients",
        event: "clients.mcp_server_end",
        message: "friends mcp server stopped",
        meta: {},
      })
    },
  }
}
