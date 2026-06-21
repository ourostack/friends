// @ouro.bot/friends/mcp — the MCP server surface.
//
// A thin, harness-agnostic MCP tool surface over the friends library: dual
// stdio framing, a flat tool → library-fn dispatch, and NO agent turn. Consumed
// via the `friends-mcp` bin or embedded directly through `createFriendsMcpServer`.
export { createFriendsMcpServer } from "./server"
export type { FriendsMcpServer, FriendsMcpServerOptions } from "./server"
export { getToolSchemas } from "./schemas"
export type { McpToolSchema } from "./schemas"
export { runMain } from "./run-main"
export type { RunMainIo } from "./run-main"
