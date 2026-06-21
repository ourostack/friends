// did:web — URL derivation + DID-doc parsing behind an INJECTED fixture resolver.
// NO real HTTP. Every parse-failure branch is its own assertion. Real libsodium
// to build valid keys and to prove the parsed keys are usable.
import { describe, expect, it } from "vitest"

import { base58btcEncode } from "../a2a-client/did-key"
import { didWebToUrl, parseDidDocument, resolveDidWeb } from "../a2a-client/did-web"
import type { DidDocResolver } from "../a2a-client/did-web"
import { openSealed, sealTo } from "../a2a-client/seal"
import { verifyEnvelopeSignature, signEnvelope } from "../a2a-client/sign"
import { readySodium } from "./_sodium"

function edMultibase(pub: Uint8Array): string {
  return `z${base58btcEncode(Uint8Array.from([0xed, 0x01, ...pub]))}`
}
function xMultibase(pub: Uint8Array): string {
  return `z${base58btcEncode(Uint8Array.from([0xec, 0x01, ...pub]))}`
}

const DID = "did:web:example.com:agents:alice"

async function validDoc(opts: { withService?: boolean } = {}) {
  const sodium = await readySodium()
  const ed = sodium.crypto_sign_keypair()
  const xPriv = sodium.crypto_sign_ed25519_sk_to_curve25519(ed.privateKey)
  const xPub = sodium.crypto_sign_ed25519_pk_to_curve25519(ed.publicKey)
  const doc: Record<string, unknown> = {
    id: DID,
    assertionMethod: [{ id: `${DID}#sig`, type: "Ed25519VerificationKey2020", publicKeyMultibase: edMultibase(ed.publicKey) }],
    keyAgreement: [{ id: `${DID}#kex`, type: "X25519KeyAgreementKey2020", publicKeyMultibase: xMultibase(xPub) }],
  }
  if (opts.withService) {
    doc.service = [{ id: `${DID}#card`, type: "A2AAgentCard", serviceEndpoint: "https://example.com/agents/alice/card.json" }]
  }
  return { sodium, ed, xPriv, xPub, doc }
}

describe("didWebToUrl", () => {
  it("bare host → /.well-known/did.json", () => {
    expect(didWebToUrl("did:web:example.com")).toBe("https://example.com/.well-known/did.json")
  })

  it("host:path:segments → /path/segments/did.json", () => {
    expect(didWebToUrl("did:web:example.com:agents:alice")).toBe("https://example.com/agents/alice/did.json")
  })

  it("percent-decodes each segment, including an encoded port in the host", () => {
    expect(didWebToUrl("did:web:localhost%3A8080")).toBe("https://localhost:8080/.well-known/did.json")
    expect(didWebToUrl("did:web:example.com:a%2Fb")).toBe("https://example.com/a/b/did.json")
  })

  it("returns null on malformed DIDs", () => {
    expect(didWebToUrl("did:key:z6Mk")).toBeNull()
    expect(didWebToUrl("did:web:")).toBeNull()
    expect(didWebToUrl("not-a-did")).toBeNull()
    expect(didWebToUrl(undefined as unknown as string)).toBeNull()
    expect(didWebToUrl("did:web:example.com::double")).toBeNull() // empty segment
    expect(didWebToUrl("did:web:%ZZ")).toBeNull() // bad percent-escape
  })
})

describe("resolveDidWeb (injected fixture resolver — no HTTP)", () => {
  it("parses a well-formed doc: both keys + the card service URL", async () => {
    const { doc } = await validDoc({ withService: true })
    const resolver: DidDocResolver = async (url) => {
      expect(url).toBe("https://example.com/agents/alice/did.json")
      return doc
    }
    const parsed = await resolveDidWeb({ did: DID, resolver })
    expect(parsed).not.toBeNull()
    expect(parsed!.id).toBe(DID)
    expect(parsed!.ed25519KeyId).toBe(`${DID}#sig`)
    expect(parsed!.x25519KeyId).toBe(`${DID}#kex`)
    expect(parsed!.cardServiceUrl).toBe("https://example.com/agents/alice/card.json")
  })

  it("the parsed keys are USABLE: seal opens, and a real signature verifies", async () => {
    const { sodium, ed, xPriv, xPub, doc } = await validDoc()
    const resolver: DidDocResolver = async () => doc
    const parsed = await resolveDidWeb({ did: DID, resolver })

    // Seal to the doc's keyAgreement → open with the matching X25519 priv.
    const pt = new TextEncoder().encode("hello did:web")
    const blob = sealTo({ sodium, plaintextBytes: pt, recipientX25519Pub: parsed!.x25519Pub, recipientDid: DID })
    const opened = openSealed({ sodium, blob, recipientX25519Priv: xPriv, recipientX25519Pub: xPub, recipientDid: DID })
    expect(Buffer.from(opened)).toEqual(Buffer.from(pt))

    // A signature by the matching Ed25519 priv verifies against the doc's assertion key.
    const env = { v: 1, hi: "there" }
    const proof = signEnvelope({ sodium, envelope: env, signerEd25519Priv: ed.privateKey, signerDid: DID, signerKeyId: parsed!.ed25519KeyId })
    expect(verifyEnvelopeSignature({ sodium, envelope: env, proof, signerEd25519Pub: parsed!.ed25519Pub })).toBe(true)
  })

  it("falls back to authentication when assertionMethod is absent", async () => {
    const { ed, doc } = await validDoc()
    delete (doc as Record<string, unknown>).assertionMethod
    ;(doc as Record<string, unknown>).authentication = [
      { id: `${DID}#auth`, publicKeyMultibase: edMultibase(ed.publicKey) },
    ]
    const parsed = await resolveDidWeb({ did: DID, resolver: async () => doc })
    expect(parsed!.ed25519KeyId).toBe(`${DID}#auth`)
  })

  it("returns null when the resolver THROWS (network error) — never propagates", async () => {
    const resolver: DidDocResolver = async () => {
      throw new Error("ECONNREFUSED")
    }
    expect(await resolveDidWeb({ did: DID, resolver })).toBeNull()
  })

  it("returns null when the DID itself is malformed (resolver never called)", async () => {
    let called = false
    const resolver: DidDocResolver = async () => {
      called = true
      return {}
    }
    expect(await resolveDidWeb({ did: "did:web:", resolver })).toBeNull()
    expect(called).toBe(false)
  })
})

describe("parseDidDocument — every reject branch", () => {
  it("non-object docs → null", () => {
    expect(parseDidDocument(null, DID)).toBeNull()
    expect(parseDidDocument("a string", DID)).toBeNull()
    expect(parseDidDocument([1, 2], DID)).toBeNull()
  })

  it("id missing or mismatched → null", async () => {
    const { doc } = await validDoc()
    expect(parseDidDocument({ ...doc, id: undefined }, DID)).toBeNull()
    expect(parseDidDocument({ ...doc, id: "did:web:other.com" }, DID)).toBeNull()
  })

  it("missing assertionMethod AND authentication → null", async () => {
    const { doc } = await validDoc()
    delete (doc as Record<string, unknown>).assertionMethod
    expect(parseDidDocument(doc, DID)).toBeNull()
  })

  it("missing keyAgreement → null", async () => {
    const { doc } = await validDoc()
    delete (doc as Record<string, unknown>).keyAgreement
    expect(parseDidDocument(doc, DID)).toBeNull()
  })

  it("unsupported key encoding (publicKeyJwk only, no multibase) → null", async () => {
    const { doc } = await validDoc()
    ;(doc as Record<string, unknown>).assertionMethod = [{ id: `${DID}#sig`, publicKeyJwk: { kty: "OKP" } }]
    expect(parseDidDocument(doc, DID)).toBeNull()
  })

  it("bad multibase (not 'z') → null", async () => {
    const { ed, doc } = await validDoc()
    ;(doc as Record<string, unknown>).assertionMethod = [
      { id: `${DID}#sig`, publicKeyMultibase: `f${base58btcEncode(ed.publicKey)}` },
    ]
    expect(parseDidDocument(doc, DID)).toBeNull()
  })

  it("'z' multibase with an INVALID base58 body → null (decode fails)", async () => {
    const { doc } = await validDoc()
    ;(doc as Record<string, unknown>).assertionMethod = [{ id: `${DID}#sig`, publicKeyMultibase: "z0OIl" }]
    expect(parseDidDocument(doc, DID)).toBeNull()
  })

  it("Ed25519 key with the WRONG multicodec → null", async () => {
    const { ed, doc } = await validDoc()
    // Encode the ed pubkey under the x25519 (0xec) multicodec → assertion extract fails.
    ;(doc as Record<string, unknown>).assertionMethod = [{ id: `${DID}#sig`, publicKeyMultibase: xMultibase(ed.publicKey) }]
    expect(parseDidDocument(doc, DID)).toBeNull()
  })

  it("key with the wrong LENGTH → null", async () => {
    const { doc } = await validDoc()
    const shortMb = `z${base58btcEncode(Uint8Array.from([0xed, 0x01, 1, 2, 3]))}`
    ;(doc as Record<string, unknown>).assertionMethod = [{ id: `${DID}#sig`, publicKeyMultibase: shortMb }]
    expect(parseDidDocument(doc, DID)).toBeNull()
  })

  it("a verification method that is a bare string reference is skipped (no inline key) → null", async () => {
    const { doc } = await validDoc()
    ;(doc as Record<string, unknown>).assertionMethod = [`${DID}#sig`] // string ref, unsupported
    expect(parseDidDocument(doc, DID)).toBeNull()
  })

  it("assertionMethod present but not an array → null", async () => {
    const { doc } = await validDoc()
    ;(doc as Record<string, unknown>).assertionMethod = { not: "an array" }
    expect(parseDidDocument(doc, DID)).toBeNull()
  })

  it("a method object missing its id is skipped → null when it's the only one", async () => {
    const { ed, doc } = await validDoc()
    ;(doc as Record<string, unknown>).assertionMethod = [{ publicKeyMultibase: edMultibase(ed.publicKey) }] // no id
    expect(parseDidDocument(doc, DID)).toBeNull()
  })
})

describe("parseDidDocument — service URL extraction branches", () => {
  it("no service array → cardServiceUrl undefined", async () => {
    const { doc } = await validDoc()
    expect(parseDidDocument(doc, DID)!.cardServiceUrl).toBeUndefined()
  })

  it("service present but no string serviceEndpoint → undefined", async () => {
    const { doc } = await validDoc()
    ;(doc as Record<string, unknown>).service = [
      { id: "x", serviceEndpoint: { uri: "https://nested" } }, // object endpoint, not a string
      "not-an-object",
    ]
    expect(parseDidDocument(doc, DID)!.cardServiceUrl).toBeUndefined()
  })

  it("service is not an array → undefined", async () => {
    const { doc } = await validDoc()
    ;(doc as Record<string, unknown>).service = { id: "x", serviceEndpoint: "https://s" }
    expect(parseDidDocument(doc, DID)!.cardServiceUrl).toBeUndefined()
  })
})
