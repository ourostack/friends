// A2A DataPart mapping — a friends exchange = one A2A `message/send` whose Message
// carries ONE DataPart. The DataPart `data` is RELAY-BLIND: it carries only the
// routing-necessary `{ v, sealed, recipientDid }`. `friendsKind` travels INSIDE the
// sealed plaintext (see sealed-envelope.ts) — the relay never learns the friends
// taxonomy. `recipientDid` is unavoidable (it is the AD-reconstruction target AND
// the relay's routing handle — the relay sees the recipient regardless).
import { randomUUID } from "node:crypto"

import type { SealedBlob } from "./seal"

/** The opaque payload carried in the A2A DataPart `data`. Nothing here reveals the
 * sender, the content, or the friends kind. */
export interface FriendsDataPartPayload {
  v: number
  sealed: SealedBlob
  recipientDid: string
}

/** An A2A Part (only the `data` kind is used by friends). */
export interface A2ADataPart {
  kind: "data"
  data: FriendsDataPartPayload
}

/** An A2A Message carrying exactly one friends DataPart. */
export interface A2AMessage {
  messageId: string
  role: "agent"
  parts: A2ADataPart[]
}

/** The `SealedEnvelope` shape (re-declared minimally to avoid a cycle; the full
 * type lives in sealed-envelope.ts). */
interface SealedEnvelopeLike {
  v: number
  sealed: SealedBlob
}

export interface WrapInDataPartInput {
  sealedEnvelope: SealedEnvelopeLike
  recipientDid: string
  v?: number
}

/** Wrap a SealedEnvelope into an A2A Message with one relay-blind DataPart. No
 * `metadata["ouro.friends/kind"]` hint (omitted by default — §3.5); no
 * `friendsKind` on the wire. */
export function wrapInDataPart(input: WrapInDataPartInput): A2AMessage {
  const v = input.v ?? input.sealedEnvelope.v
  return {
    messageId: randomUUID(),
    role: "agent",
    parts: [{ kind: "data", data: { v, sealed: input.sealedEnvelope.sealed, recipientDid: input.recipientDid } }],
  }
}

/** Extract + validate the single friends DataPart. Returns null on any malformed
 * shape: wrong part count (≠1), non-data kind, or a missing/ill-typed
 * sealed/recipientDid/v. */
export function unwrapDataPart(msg: A2AMessage): FriendsDataPartPayload | null {
  if (!msg || typeof msg !== "object") return null
  const parts = (msg as A2AMessage).parts
  if (!Array.isArray(parts) || parts.length !== 1) return null
  const part = parts[0]
  if (!part || typeof part !== "object" || part.kind !== "data") return null
  const data = (part as A2ADataPart).data
  if (!data || typeof data !== "object") return null
  if (typeof data.recipientDid !== "string") return null
  if (typeof data.v !== "number") return null
  if (!isSealedBlob(data.sealed)) return null
  return { v: data.v, sealed: data.sealed, recipientDid: data.recipientDid }
}

function isSealedBlob(value: unknown): value is SealedBlob {
  if (!value || typeof value !== "object") return false
  const b = value as Record<string, unknown>
  return (
    typeof b.v === "number" &&
    typeof b.ePk === "string" &&
    typeof b.n === "string" &&
    typeof b.ct === "string"
  )
}
