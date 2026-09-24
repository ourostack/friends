/**
 * Direct agent-to-agent messages: the conversational sibling of profile / mission /
 * coordination shares. A `MessageEnvelope` carries free text from one agent to a
 * peer it knows, so two agents can talk directly instead of relaying through a
 * human chat app.
 *
 * Security model (identical to the other friends kinds):
 *   - The text lives INSIDE the signed, sealed envelope. A relay or network
 *     observer can neither read it nor substitute it, so this is safe over any
 *     transport (a tailnet, a LAN, a relay) — the network is a pipe, not the lock.
 *   - Authentication is the caller's `AgentVerifier` (the pinned sender key must
 *     have signed THIS envelope); authorization is the recipient's trust in the
 *     sender. Both must pass. The recipient still applies its own turn-level gates
 *     (trust gate, relationship profiles) to whatever the message asks for.
 *   - `receiveMessage` imports nothing: it only returns the verified message. What
 *     a recipient may DO in response is decided by the recipient, never the sender.
 */
import { emitNervesEvent } from "./observability"
import type { TrustLevel } from "./types"
import type { AgentVerifier } from "./verifier"
import { DEFAULT_AGENT_VERIFIER } from "./verifier"

/** Matches the ouro harness A2A server's inbound text cap. */
export const MAX_MESSAGE_TEXT_CHARS = 16_000
/** A sender-chosen thread id (e.g. an A2A contextId) is an opaque short token. */
export const MAX_CONVERSATION_ID_CHARS = 256

const TRUST_RANK: Record<TrustLevel, number> = { family: 4, friend: 3, acquaintance: 2, stranger: 1 }

/** The cross-agent message envelope. Names the sender by its join-key agentId (DID). */
export interface MessageEnvelope {
  /** The agent that wrote this message (its join-key agentId / DID). */
  fromAgentId: string
  /** The message body. Non-empty, at most `MAX_MESSAGE_TEXT_CHARS`. */
  text: string
  /** Optional sender-chosen conversation thread id, so replies can stay in one session. */
  conversationId?: string
  /** Opaque, verifier-specific proof slot (stamped by `sealEnvelope`). */
  proof?: string
  issuedAt: string
}

/** A verified inbound message, as handed to the recipient after authentication. */
export interface ReceivedMessage {
  fromAgentId: string
  text: string
  conversationId?: string
  issuedAt: string
}

export interface PrepareMessageInput {
  /** This agent's own join-key agentId (DID). */
  fromAgentId: string
  text: string
  conversationId?: string
  now?: () => string
}

export type PrepareMessageResult =
  | { ok: true; envelope: MessageEnvelope }
  | { ok: false; status: "empty_text" | "text_too_long" | "invalid_conversation_id" | "invalid_sender" }

/** Producer half: build an unsigned message envelope (sealing signs it). */
export function prepareMessage(input: PrepareMessageInput): PrepareMessageResult {
  if (typeof input.fromAgentId !== "string" || input.fromAgentId.trim() === "") return { ok: false, status: "invalid_sender" }
  if (typeof input.text !== "string" || input.text.trim() === "") return { ok: false, status: "empty_text" }
  if (input.text.length > MAX_MESSAGE_TEXT_CHARS) return { ok: false, status: "text_too_long" }
  if (input.conversationId !== undefined && !validConversationId(input.conversationId)) {
    return { ok: false, status: "invalid_conversation_id" }
  }
  const envelope: MessageEnvelope = {
    fromAgentId: input.fromAgentId,
    text: input.text,
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    issuedAt: (input.now ?? (() => new Date().toISOString()))(),
  }
  return { ok: true, envelope }
}

export interface ReceiveMessageInput {
  /** The unsealed envelope (shape is untrusted until validated here). */
  envelope: Record<string, unknown>
  /** The SIGNED sender DID bound by the transport adapter. */
  fromAgentId: string
  /** The recipient's trust in the sender, looked up by the recipient — never the envelope. */
  trustOfSource: TrustLevel
}

export interface ReceiveMessageOptions {
  verifier?: AgentVerifier
  /** The lowest sender trust that may deliver a message. Defaults to `acquaintance`,
   * matching coordination; the recipient's own gates still apply to the turn. */
  minTrustToAccept?: TrustLevel
}

export type ReceiveMessageResult =
  | { ok: true; status: "received"; message: ReceivedMessage }
  | { ok: false; status: "untrusted_source" | "malformed_message" }

/** Consumer half: validate shape, then require BOTH authentication (the pinned sender
 * key signed this envelope) and authorization (sender trust meets the floor). */
export function receiveMessage(input: ReceiveMessageInput, options: ReceiveMessageOptions = {}): ReceiveMessageResult {
  const envelope = input.envelope
  const text = envelope.text
  const conversationId = envelope.conversationId
  const issuedAt = envelope.issuedAt
  if (
    envelope.fromAgentId !== input.fromAgentId
    || typeof text !== "string" || text.trim() === "" || text.length > MAX_MESSAGE_TEXT_CHARS
    || typeof issuedAt !== "string" || Number.isNaN(Date.parse(issuedAt))
    || (conversationId !== undefined && !validConversationId(conversationId))
  ) {
    return { ok: false, status: "malformed_message" }
  }

  const verifier = options.verifier ?? DEFAULT_AGENT_VERIFIER
  const minTrust = options.minTrustToAccept ?? "acquaintance"
  const proof = typeof envelope.proof === "string" ? envelope.proof : undefined
  const authenticated = verifier.verify(input.fromAgentId, proof)
  const trustedEnough = TRUST_RANK[input.trustOfSource] >= TRUST_RANK[minTrust]
  if (!authenticated || !trustedEnough) {
    emitNervesEvent({
      component: "friends",
      event: "friends.message_refused",
      message: "refused agent message from untrusted source",
      meta: { fromAgentId: input.fromAgentId, trustOfSource: input.trustOfSource, authenticated },
    })
    return { ok: false, status: "untrusted_source" }
  }

  emitNervesEvent({
    component: "friends",
    event: "friends.message_received",
    message: "received authenticated agent message",
    meta: { fromAgentId: input.fromAgentId, trustOfSource: input.trustOfSource, chars: text.length },
  })
  return {
    ok: true,
    status: "received",
    message: {
      fromAgentId: input.fromAgentId,
      text,
      ...(conversationId !== undefined ? { conversationId: conversationId as string } : {}),
      issuedAt,
    },
  }
}

function validConversationId(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_CONVERSATION_ID_CHARS
}
