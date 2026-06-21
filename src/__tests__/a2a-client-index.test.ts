// a2a-client public barrel — documents + covers the @ouro.bot/friends/a2a-client
// public surface. (src/index.ts is coverage-excluded, but this barrel is NOT, so
// importing it here gives the re-export surface coverage and pins the API.)
import { describe, expect, it } from "vitest"

import * as api from "../a2a-client/index"

describe("@ouro.bot/friends/a2a-client public surface", () => {
  it("exports the init seam + canonicalization", () => {
    expect(typeof api.ready).toBe("function")
    expect(typeof api.jcsString).toBe("function")
    expect(typeof api.jcsBytes).toBe("function")
  })

  it("exports the seal primitives", () => {
    expect(typeof api.sealTo).toBe("function")
    expect(typeof api.openSealed).toBe("function")
    expect(typeof api.SealOpenError).toBe("function")
  })

  it("exports the sign/verify surface", () => {
    expect(typeof api.signEnvelope).toBe("function")
    expect(typeof api.verifyEnvelopeSignature).toBe("function")
    expect(typeof api.serializeProof).toBe("function")
    expect(typeof api.parseProof).toBe("function")
  })

  it("exports the DID surface (did:key + did:web)", () => {
    expect(typeof api.parseDidKey).toBe("function")
    expect(typeof api.keyAgreementFromDidKey).toBe("function")
    expect(typeof api.didKeyIdentityFromEd25519).toBe("function")
    expect(typeof api.ed25519PubToDidKey).toBe("function")
    expect(typeof api.base58btcEncode).toBe("function")
    expect(typeof api.base58btcDecode).toBe("function")
    expect(typeof api.didWebToUrl).toBe("function")
    expect(typeof api.resolveDidWeb).toBe("function")
    expect(typeof api.parseDidDocument).toBe("function")
  })

  it("exports the DidVerifier + pin + rotation surface", () => {
    expect(typeof api.DidVerifier).toBe("function")
    expect(typeof api.MemoryPinStore).toBe("function")
    expect(typeof api.pinOnFirstContact).toBe("function")
    expect(typeof api.isPinned).toBe("function")
    expect(typeof api.getPinned).toBe("function")
    expect(typeof api.evaluateRotation).toBe("function")
    expect(typeof api.signSuccessor).toBe("function")
    expect(typeof api.verifyCardDidBinding).toBe("function")
  })

  it("exports the SealedEnvelope compose + DataPart + card + reachability + adapter", () => {
    expect(typeof api.sealEnvelope).toBe("function")
    expect(typeof api.openSealedEnvelope).toBe("function")
    expect(typeof api.wrapInDataPart).toBe("function")
    expect(typeof api.unwrapDataPart).toBe("function")
    expect(typeof api.buildFriendsAgentCard).toBe("function")
    expect(typeof api.resolveReachability).toBe("function")
    expect(typeof api.sendShare).toBe("function")
    expect(typeof api.receiveShare).toBe("function")
  })
})
