// agent-card — the A2A Agent Card a friends agent exposes, plus the friends
// overlay binding (`did`) and the relay-handle advertisement. Kept minimal +
// public-clean. The friendsKind taxonomy is NEVER surfaced on the card
// (metadata-minimization — no friends-internal leak to a directory/relay).
import type { FriendsKind } from "./sealed-envelope"

/** A single A2A skill descriptor. */
export interface A2ASkill {
  id: string
  name: string
  description: string
  tags: string[]
}

/** The A2A capabilities block. */
export interface A2ACapabilities {
  streaming: boolean
  pushNotifications: boolean
}

/** The friends agent card (the A2A card + the friends overlay). */
export interface FriendsAgentCard {
  name: string
  description: string
  url: string
  version: string
  protocolVersion: string
  capabilities: A2ACapabilities
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: A2ASkill[]
  /** No transport security scheme for the local proof (the E2E overlay is the
   * real security; transport authn is host-config). */
  securitySchemes: Record<string, never>
  security: never[]
  /** The friends overlay binding: the agent's DID (== its agentId). */
  did: string
  /** The friends extension: advertises the relay handle when the agent is reached
   * via a relay. Absent when the agent has a direct endpoint. */
  ouroRelay?: { handle: string }
}

export interface BuildFriendsAgentCardInput {
  name: string
  url: string
  version: string
  protocolVersion: string
  did: string
  description?: string
  relayHandle?: string
}

/** The friends-exchange skill IDs are part of the public surface; the friends
 * KIND taxonomy is intentionally NOT exposed (only this single skill). */
const FRIENDS_EXCHANGE_SKILL: A2ASkill = {
  id: "friends-exchange",
  // Deliberately generic: the friends KIND taxonomy is never spelled out on the
  // card (metadata-minimization — a directory/relay learns no friends internals).
  name: "friends exchange",
  description: "Exchange consent-gated friends envelopes over an end-to-end sign-then-seal overlay.",
  tags: ["friends", "a2a", "e2e"],
}

/** Build a minimal friends agent card. The relay handle is advertised only when
 * supplied. */
export function buildFriendsAgentCard(input: BuildFriendsAgentCardInput): FriendsAgentCard {
  return {
    name: input.name,
    description: input.description ?? "A friends-using agent (A2A + the friends E2E overlay).",
    url: input.url,
    version: input.version,
    protocolVersion: input.protocolVersion,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [FRIENDS_EXCHANGE_SKILL],
    securitySchemes: {},
    security: [],
    did: input.did,
    ...(input.relayHandle !== undefined ? { ouroRelay: { handle: input.relayHandle } } : {}),
  }
}

/** Re-export the friendsKind type for convenience (it is NOT placed on the card). */
export type { FriendsKind }
