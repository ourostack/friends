// MCP tool schemas for the friends server.
//
// 14 tools — a thin 1:1 surface over the friends library (D7). Each schema
// follows JSON Schema for `inputSchema` as required by MCP. The shape mirrors
// the harness's McpToolSchema so the same client tooling consumes both.
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

const STRING = { type: "string" } as const

export function getToolSchemas(): McpToolSchema[] {
  emitNervesEvent({
    component: "clients",
    event: "clients.mcp_tool_schemas",
    message: "listed friends mcp tool schemas",
    meta: {},
  })

  return [
    {
      name: "resolve_party",
      description: "Resolve an external identity (provider + externalId on a channel) into a friend record, creating one on first contact. Returns { friend, channel, created }.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", description: "identity provider, e.g. aad, local, teams-conversation, imessage-handle, email-address, a2a-agent" },
          externalId: { type: "string", description: "the external identity within the provider" },
          displayName: { type: "string", description: "display name for the party (use 'Unknown' if not known)" },
          channel: { type: "string", description: "the channel/sense the session belongs to, e.g. cli, teams, mcp" },
          tenantId: { type: "string", description: "optional tenant id" },
        },
        required: ["provider", "externalId"],
      },
    },
    {
      name: "describe_trust",
      description: "Explain the trust context for a friend: level, basis (direct/shared_group/unknown), what it permits and constrains.",
      inputSchema: {
        type: "object",
        properties: {
          friendId: { type: "string", description: "friend uuid or name" },
          channel: { type: "string", description: "the channel/sense for the explanation" },
          isGroupChat: { type: "string", description: "set to 'true' when the conversation is a group chat" },
        },
        required: ["friendId", "channel"],
      },
    },
    {
      name: "get_friend",
      description: "Fetch a single friend record by uuid or by name.",
      inputSchema: {
        type: "object",
        properties: {
          friendId: { type: "string", description: "friend uuid or name" },
        },
        required: ["friendId"],
      },
    },
    {
      name: "list_friends",
      description: "List friend records, optionally filtered by trust level and kind, optionally limited.",
      inputSchema: {
        type: "object",
        properties: {
          trust: { type: "string", description: "filter by trust level: family/friend/acquaintance/stranger" },
          kind: { type: "string", description: "filter by kind: human/agent" },
          limit: { type: "string", description: "max number of records to return" },
        },
      },
    },
    {
      name: "save_note",
      description: "Save a friend's name, a tool preference, or a general note. Use override='true' to overwrite an existing value.",
      inputSchema: {
        type: "object",
        properties: {
          friendId: { type: "string", description: "friend uuid or name" },
          type: { type: "string", enum: ["name", "tool_preference", "note"], description: "what to save" },
          key: { type: "string", description: "key for tool_preference or note" },
          content: { type: "string", description: "the value to save" },
          override: { type: "string", enum: ["true", "false"], description: "set to 'true' to overwrite an existing value" },
          provenance: { type: "object", description: "optional attribution { assertedBy: { agentId, agentName } }" },
        },
        required: ["friendId", "type", "content"],
      },
    },
    {
      name: "record_interaction",
      description: "Record a turn with a friend: accumulate token usage and/or append a shared-mission outcome (bumping familiarity).",
      inputSchema: {
        type: "object",
        properties: {
          friendId: { type: "string", description: "friend uuid or name" },
          usage: { type: "object", description: "token usage; only output_tokens is counted" },
          outcome: { type: "object", description: "shared-mission outcome { missionId, result, note? }" },
          familiarityDelta: { type: "string", description: "how much to bump familiarity (default 1)" },
          provenance: { type: "object", description: "optional attribution for the outcome" },
        },
        required: ["friendId"],
      },
    },
    {
      name: "upsert_group",
      description: "Upsert shared-group participant context: link each participant to the group, promoting strangers to acquaintances.",
      inputSchema: {
        type: "object",
        properties: {
          groupExternalId: { type: "string", description: "the group's external id" },
          participants: { type: "array", description: "participants [{ provider, externalId, displayName? }]" },
        },
        required: ["groupExternalId", "participants"],
      },
    },
    {
      name: "set_trust",
      description: "Set a friend's trust level (also mirrors it onto the record's role).",
      inputSchema: {
        type: "object",
        properties: {
          friendId: { type: "string", description: "friend uuid or name" },
          trustLevel: { type: "string", enum: ["family", "friend", "acquaintance", "stranger"], description: "the trust level to set" },
        },
        required: ["friendId", "trustLevel"],
      },
    },
    {
      name: "link_identity",
      description: "Link an external identity to a friend, merging any orphan record that already holds it (cross-channel unification).",
      inputSchema: {
        type: "object",
        properties: {
          friendId: { type: "string", description: "friend uuid or name" },
          provider: STRING,
          externalId: STRING,
          tenantId: { type: "string", description: "optional tenant id" },
        },
        required: ["friendId", "provider", "externalId"],
      },
    },
    {
      name: "unlink_identity",
      description: "Remove an external identity from a friend.",
      inputSchema: {
        type: "object",
        properties: {
          friendId: { type: "string", description: "friend uuid or name" },
          provider: STRING,
          externalId: STRING,
        },
        required: ["friendId", "provider", "externalId"],
      },
    },
    {
      name: "onboard_agent",
      description: "Upsert an agent-peer friend record from already-resolved coordinates (no HTTP card fetch).",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "the peer agent's name" },
          agentId: { type: "string", description: "the a2a agent id" },
          trustLevel: { type: "string", description: "trust level (default acquaintance)" },
          a2a: { type: "object", description: "a2a coordinates { cardUrl?, endpointUrl?, protocolVersion? }" },
          bundleName: { type: "string", description: "optional bundle name" },
        },
        required: ["name", "agentId"],
      },
    },
    {
      name: "whoami",
      description: "Resolve who the machine owner is and which friend record represents the self.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "channel_caps",
      description: "Return the capabilities of a channel (integrations, markdown, streaming, rich cards, max length).",
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", description: "the channel to look up" },
        },
        required: ["channel"],
      },
    },
    {
      name: "share_profile",
      description: "Reserved (P1): share a friend's profile with another agent. Returns { supported: false } until federation lands.",
      inputSchema: {
        type: "object",
        properties: {
          friendId: { type: "string", description: "friend uuid or name" },
          toAgentId: { type: "string", description: "the agent to share with" },
          scope: { type: "string", description: "the sharing scope" },
        },
      },
    },
  ]
}
