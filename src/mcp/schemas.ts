// MCP tool schemas for the friends server.
//
// The tool list is generated. `actions/friends.actions.mts` declares each tool once (its name, description and input),
// and `ouro-actions generate` writes `actions/generated/mcp.json`, the one MCP door this server serves. CI's
// `compare-mcp` fails when the served list drifts from the declarations.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { emitNervesEvent } from "../observability"

export interface McpToolSchema {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
  }
}

// Beside dist/ in the published package (`files` in package.json), and beside src/ in the repository.
const MCP_DOOR = join(__dirname, "..", "..", "actions", "generated", "mcp.json")

export function getToolSchemas(): McpToolSchema[] {
  emitNervesEvent({
    component: "clients",
    event: "clients.mcp_tool_schemas",
    message: "listed friends mcp tool schemas",
    meta: {},
  })

  const door = JSON.parse(readFileSync(MCP_DOOR, "utf8")) as { tools: McpToolSchema[] }
  return door.tools
}
