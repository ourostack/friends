// did:web — DID resolution behind an INJECTABLE resolver hook. did:key needs no
// network (U4); did:web does — so the resolver is the only network seam, and it
// is injected (the host supplies real `fetch`; tests inject a fixture map). NO
// real HTTP lives here. The a2a-client stays transport-injectable end to end.
//
// did:web → URL: `did:web:host` → https://host/.well-known/did.json;
//                `did:web:host:a:b` → https://host/a/b/did.json
// Each colon-separated segment is percent-decoded (the host may carry an encoded
// port `%3A`). The DID-doc parse extracts the Ed25519 assertion key + the X25519
// keyAgreement key + the card service back-reference (for the U6 binding check).
import { base58btcDecode } from "./did-key"

/** The injectable resolver: given the resolved DID-doc URL, return the document.
 * The host wires real `fetch`; tests inject a `(url) => Promise<fixture>` map. */
export type DidDocResolver = (didDocUrl: string) => Promise<unknown>

/** A parsed did:web document (only the fields the overlay needs). */
export interface DidDocument {
  id: string
  ed25519Pub: Uint8Array
  ed25519KeyId: string
  x25519Pub: Uint8Array
  x25519KeyId: string
  /** The agent-card URL declared in a `service` entry, if present (U6 binding). */
  cardServiceUrl?: string
}

// Multicodec prefixes (varint) for publicKeyMultibase decoding.
const ED25519_MULTICODEC = [0xed, 0x01]
const X25519_MULTICODEC = [0xec, 0x01]
const KEY_LEN = 32

/** `did:web:…` → the DID-doc URL. Returns null on a malformed DID. */
export function didWebToUrl(did: string): string | null {
  if (typeof did !== "string" || !did.startsWith("did:web:")) return null
  const rest = did.slice("did:web:".length)
  if (rest.length === 0) return null
  const rawSegments = rest.split(":")
  if (rawSegments.some((s) => s.length === 0)) return null

  let segments: string[]
  try {
    segments = rawSegments.map((s) => decodeURIComponent(s))
  } catch {
    return null // a malformed percent-escape
  }

  // segments[0] (the host) is guaranteed non-empty: the `some(s.length === 0)`
  // guard above rejects any empty segment, and decodeURIComponent of a non-empty
  // string can't yield empty.
  const host = segments[0]
  if (segments.length === 1) {
    return `https://${host}/.well-known/did.json`
  }
  const path = segments.slice(1).join("/")
  return `https://${host}/${path}/did.json`
}

/** Decode a `publicKeyMultibase` (`z…` base58btc) and verify the multicodec +
 * length. Returns the 32-byte key or null. */
function decodeMultibaseKey(value: unknown, multicodec: number[]): Uint8Array | null {
  if (typeof value !== "string" || !value.startsWith("z")) return null
  const decoded = base58btcDecode(value.slice(1))
  if (!decoded) return null
  if (decoded.length !== multicodec.length + KEY_LEN) return null
  if (decoded[0] !== multicodec[0] || decoded[1] !== multicodec[1]) return null
  return decoded.slice(multicodec.length)
}

/** A verification method may be inline (an object) or a string reference. We only
 * support inline methods here (string refs into the same doc are resolved by
 * matching `id`). Returns the inline method object or null. */
function asMethodObject(m: unknown): Record<string, unknown> | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null
  return m as Record<string, unknown>
}

/** Find the first verification method in `methods` that decodes to a key of the
 * given multicodec, returning the key + its id. */
function extractKey(
  methods: unknown,
  multicodec: number[],
): { pub: Uint8Array; keyId: string } | null {
  if (!Array.isArray(methods)) return null
  for (const m of methods) {
    const obj = asMethodObject(m)
    if (!obj) continue
    const pub = decodeMultibaseKey(obj.publicKeyMultibase, multicodec)
    if (pub && typeof obj.id === "string") {
      return { pub, keyId: obj.id }
    }
  }
  return null
}

/** Extract the agent-card service URL: a `service` entry whose endpoint is a
 * string. Returns undefined when no usable service is present. */
function extractCardServiceUrl(doc: Record<string, unknown>): string | undefined {
  const services = doc.service
  if (!Array.isArray(services)) return undefined
  for (const s of services) {
    if (!s || typeof s !== "object" || Array.isArray(s)) continue
    const endpoint = (s as Record<string, unknown>).serviceEndpoint
    if (typeof endpoint === "string") return endpoint
  }
  return undefined
}

/** Parse a DID document. Returns null/typed-failure on: not an object, id
 * mismatch, missing assertionMethod (Ed25519), missing keyAgreement (X25519),
 * unsupported key encoding, or a key-length mismatch. */
export function parseDidDocument(doc: unknown, did: string): DidDocument | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null
  const d = doc as Record<string, unknown>
  if (typeof d.id !== "string" || d.id !== did) return null

  // assertionMethod is the signing relationship; fall back to authentication.
  const ed =
    extractKey(d.assertionMethod, ED25519_MULTICODEC) ?? extractKey(d.authentication, ED25519_MULTICODEC)
  if (!ed) return null

  const x = extractKey(d.keyAgreement, X25519_MULTICODEC)
  if (!x) return null

  return {
    id: did,
    ed25519Pub: ed.pub,
    ed25519KeyId: ed.keyId,
    x25519Pub: x.pub,
    x25519KeyId: x.keyId,
    cardServiceUrl: extractCardServiceUrl(d),
  }
}

export interface ResolveDidWebInput {
  did: string
  resolver: DidDocResolver
}

/** Resolve a did:web via the injected resolver and parse the document. Returns
 * null (never throws) on a malformed DID, a resolver error, or a parse failure. */
export async function resolveDidWeb(input: ResolveDidWebInput): Promise<DidDocument | null> {
  const url = didWebToUrl(input.did)
  if (!url) return null
  let doc: unknown
  try {
    doc = await input.resolver(url)
  } catch {
    return null // network error / resolver throw — never propagates
  }
  return parseDidDocument(doc, input.did)
}
