// @ouro.bot/friends/a2a-client — the public host-side A2A adapter + the friends
// E2E security overlay (sign-then-seal + DID identity). This is the ONLY directory
// permitted to import libsodium / A2A / DID; the dependency-direction lint enforces
// core ⊥ a2a-client and a2a-client ⊥ mcp.
//
// The security model in one line: friends agents speak REAL A2A (`message/send`,
// DataPart) while every envelope is SIGNED by the sender (Ed25519) and SEALED to
// the recipient (XChaCha20-Poly1305 AEAD over ephemeral X25519 ECDH, with the
// recipient DID bound into the AEAD AD), so a relay carries CIPHERTEXT ONLY — it
// can never read, forge, tamper, re-target, replay-to-effect, or escalate.

// ── init seam ──
export { ready } from "./sodium"
export type { Sodium } from "./sodium"

// ── canonicalization (RFC 8785 JCS) ──
export { jcsBytes, jcsString } from "./jcs"

// ── seal / open primitives ──
export { openSealed, sealTo, SealOpenError } from "./seal"
export type { SealedBlob, OpenSealedInput, SealToInput } from "./seal"

// ── sign / verify + structured proof ──
export { parseProof, serializeProof, signEnvelope, verifyEnvelopeSignature } from "./sign"
export type { StructuredProof } from "./sign"

// ── did:key (both keys from one DID) ──
export {
  base58btcDecode,
  base58btcEncode,
  didKeyIdentityFromEd25519,
  ed25519PubToDidKey,
  keyAgreementFromDidKey,
  parseDidKey,
} from "./did-key"
export type { DidKeyIdentity } from "./did-key"

// ── did:web (behind an injectable resolver) ──
export { didWebToUrl, parseDidDocument, resolveDidWeb } from "./did-web"
export type { DidDocResolver, DidDocument, ResolveDidWebInput } from "./did-web"

// ── DidVerifier — binding, TOFU pin, trust-tiered rotation ──
export {
  DidVerifier,
  evaluateRotation,
  getPinned,
  isPinned,
  MemoryPinStore,
  pinOnFirstContact,
  signSuccessor,
  verifyCardDidBinding,
} from "./did-verifier"
export type { PinnedDid, PinStore, RotationDecision } from "./did-verifier"

// ── SealedEnvelope sign-then-seal compose ──
export { openSealedEnvelope, sealEnvelope } from "./sealed-envelope"
export type {
  FriendsKind,
  FromIdentity,
  OpenSealedEnvelopeResult,
  RecipientIdentity,
  SealedEnvelope,
} from "./sealed-envelope"

// ── A2A DataPart mapping (relay-blind) ──
export { unwrapDataPart, wrapInDataPart } from "./a2a-message"
export type { A2ADataPart, A2AMessage, FriendsDataPartPayload } from "./a2a-message"

// ── friends agent card ──
export { buildFriendsAgentCard } from "./agent-card"
export type { A2ACapabilities, A2ASkill, FriendsAgentCard } from "./agent-card"

// ── reachability ladder ──
export { resolveReachability } from "./reachability"
export type { ReachabilityPlan } from "./reachability"

// ── send / receive adapter ──
export { receiveShare, sendShare } from "./adapter"
export type {
  A2ATransport,
  DidResolution,
  ReceiveShareInput,
  ReceiveShareResult,
  SeenLedgerLike,
  SendShareInput,
  SendShareResult,
} from "./adapter"
