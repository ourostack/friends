/**
 * Direct agent-to-agent messages: the conversational sibling of profile / mission /
 * coordination shares. A `MessageEnvelope` carries free text from one agent to a
 * peer it knows, so two agents can talk directly instead of relaying through a
 * human chat app.
 *
 * Security model (identical to the other friends kinds):
 *   - The text lives INSIDE the signed, sealed envelope. A relay or network
 *     observer can neither read it nor substitute it, so this is safe over any
 *     transport (a tailnet, a LAN, a relay).
 *   - Authentication is the caller's `AgentVerifier` (the pinned sender key must
 *     have signed THIS envelope); authorization is the recipient's trust in the
 *     sender. Both must pass. Callers are expected to apply their own gates.
 *   - `receiveMessage` imports nothing: it only returns the verified message.
 */
import { emitNervesEvent } from "./observability"
import type { TrustLevel } from "./types"
import type { AgentVerifier } from "./verifier"
import { DEFAULT_AGENT_VERIFIER } from "./verifier"

/** Matches the ouro harness A2A server's inbound text cap. */
export const MAX_MESSAGE_TEXT_CHARS = 16_000
/** A sender-chosen thread id (e.g. an A2A contextId) is an opaque short token. */
export const MAX_CONVERSATION_ID_CHARS = 256

/** A sender's signed answer to an approval its peer routed to it (see `ApprovalAnswer`). */
export type ApprovalDecision = "approve" | "deny"
/** The relay token is a base64url MAC the approving agent computed; 16 to 128 characters. */
const RELAY_TOKEN = /^[A-Za-z0-9_-]{16,128}$/

/** Signed with the text, so a relay can neither add, strip nor change it. It claims nothing
 * on its own: the recipient matches `relayToken` against an approval it routed to this
 * sender, and decides whether it honours `decision` at all. Never set from model input. */
export interface ApprovalAnswer {
  relayToken: string
  decision: ApprovalDecision
}

/** True only for exactly `{ relayToken, decision }` with a well-formed token and a known decision. */
export function isApprovalAnswer(value: unknown): value is ApprovalAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return Object.keys(v).sort().join(",") === "decision,relayToken"
    && typeof v.relayToken === "string" && RELAY_TOKEN.test(v.relayToken)
    && (v.decision === "approve" || v.decision === "deny")
}

const TRUST_RANK: Record<TrustLevel, number> = { family: 4, friend: 3, acquaintance: 2, stranger: 1 }

/** The cross-agent message envelope. Names the sender by its join-key agentId (DID). */
export interface MessageEnvelope {
  /** The agent that wrote this message (its join-key agentId / DID). */
  fromAgentId: string
  /** The message body. Non-empty, at most `MAX_MESSAGE_TEXT_CHARS`. */
  text: string
  /** Optional sender-chosen conversation thread id, so replies can stay in one session. */
  conversationId?: string
  /** Marks the text as a command the sender relays from its own principal (the human it
   * works for). It is signed with the text, so a relay can neither add nor strip it.
   * It claims nothing on its own: the recipient honours it only for a sender its own
   * friend record explicitly grants delegation to. */
  onBehalfOf?: "principal"
  /** A signed answer to an approval the recipient routed to this sender. Never set with `onBehalfOf`. */
  approvalAnswer?: ApprovalAnswer
  /** Opaque, verifier-specific proof slot (stamped by `sealEnvelope`). */
  proof?: string
  issuedAt: string
}

/** A verified inbound message, as handed to the recipient after authentication. */
export interface ReceivedMessage {
  fromAgentId: string
  text: string
  conversationId?: string
  /** Present only when the signed envelope carried the delegation marker. */
  onBehalfOf?: "principal"
  /** Present only when the signed envelope carried an approval answer. */
  approvalAnswer?: ApprovalAnswer
  issuedAt: string
}

export interface PrepareMessageInput {
  /** This agent's own join-key agentId (DID). */
  fromAgentId: string
  text: string
  conversationId?: string
  /** Mark the message as a command relayed from this agent's principal. */
  onBehalfOf?: "principal"
  /** Answer an approval the recipient routed to this agent. Set only by harness code, never from model input. */
  approvalAnswer?: ApprovalAnswer
  now?: () => string
}

export type PrepareMessageResult =
  | { ok: true; envelope: MessageEnvelope }
  | { ok: false; status: "empty_text" | "text_too_long" | "invalid_conversation_id" | "invalid_sender" | "invalid_delegation" | "invalid_approval_answer" }

/** Producer half: build an unsigned message envelope (sealing signs it). */
export function prepareMessage(input: PrepareMessageInput): PrepareMessageResult {
  if (typeof input.fromAgentId !== "string" || input.fromAgentId.trim() === "") return { ok: false, status: "invalid_sender" }
  if (typeof input.text !== "string" || input.text.trim() === "") return { ok: false, status: "empty_text" }
  if (input.text.length > MAX_MESSAGE_TEXT_CHARS) return { ok: false, status: "text_too_long" }
  if (input.conversationId !== undefined && !validConversationId(input.conversationId)) {
    return { ok: false, status: "invalid_conversation_id" }
  }
  if (input.onBehalfOf !== undefined && input.onBehalfOf !== "principal") return { ok: false, status: "invalid_delegation" }
  if (input.approvalAnswer !== undefined && (!isApprovalAnswer(input.approvalAnswer) || input.onBehalfOf !== undefined)) {
    return { ok: false, status: "invalid_approval_answer" }
  }
  const envelope: MessageEnvelope = {
    fromAgentId: input.fromAgentId,
    text: input.text,
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    ...(input.onBehalfOf !== undefined ? { onBehalfOf: input.onBehalfOf } : {}),
    ...(input.approvalAnswer !== undefined ? { approvalAnswer: { relayToken: input.approvalAnswer.relayToken, decision: input.approvalAnswer.decision } } : {}),
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
   * matching coordination. */
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
  const onBehalfOf = envelope.onBehalfOf
  const approvalAnswer = envelope.approvalAnswer
  if (
    envelope.fromAgentId !== input.fromAgentId
    || typeof text !== "string" || text.trim() === "" || text.length > MAX_MESSAGE_TEXT_CHARS
    || typeof issuedAt !== "string" || Number.isNaN(Date.parse(issuedAt))
    || (conversationId !== undefined && !validConversationId(conversationId))
    || (onBehalfOf !== undefined && onBehalfOf !== "principal")
    || (approvalAnswer !== undefined && (!isApprovalAnswer(approvalAnswer) || onBehalfOf !== undefined))
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
      ...(onBehalfOf !== undefined ? { onBehalfOf } : {}),
      ...(approvalAnswer !== undefined ? { approvalAnswer: { relayToken: (approvalAnswer as ApprovalAnswer).relayToken, decision: (approvalAnswer as ApprovalAnswer).decision } } : {}),
      issuedAt,
    },
  }
}

function validConversationId(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_CONVERSATION_ID_CHARS
}
