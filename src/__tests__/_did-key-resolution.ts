import { keyAgreementFromDidKey, parseDidKey } from "../a2a-client/did-key"
import { getPinned, pinOnFirstContact } from "../a2a-client/did-verifier"
import type { DidResolution } from "../a2a-client/adapter"
import type { readySodium } from "./_sodium"

/** A did:key resolver that pins on first contact and never trusts a retired pin. */
export function didKeyResolutionFor(sodium: Awaited<ReturnType<typeof readySodium>>): DidResolution {
  return {
    async resolveAndPin({ fromAgentId, did, pinStore }) {
      const existing = getPinned(pinStore, fromAgentId)
      if (existing) return { ed25519Pub: existing.ed25519Pub }
      const parsed = parseDidKey(did)
      if (!parsed) return null
      keyAgreementFromDidKey({ sodium, ed25519Pub: parsed.ed25519Pub })
      pinOnFirstContact({ pinStore, fromAgentId, did, ed25519Pub: parsed.ed25519Pub })
      return { ed25519Pub: parsed.ed25519Pub }
    },
  }
}
