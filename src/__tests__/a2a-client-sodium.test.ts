// sodium init seam — the production `ready()` that the adapter funnels through.
// Distinct from the __tests__/_sodium.ts helper (which is test infrastructure):
// this proves the SHIPPED seam initializes the WASM and hands back a usable
// instance. Awaiting twice is idempotent.
import { describe, expect, it } from "vitest"

import { ready } from "../a2a-client/sodium"

describe("sodium.ready() — the production init seam", () => {
  it("resolves a ready libsodium instance with the primitives bound", async () => {
    const sodium = await ready()
    expect(typeof sodium.crypto_sign_keypair).toBe("function")
    expect(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES).toBe(24)
  })

  it("is idempotent — a second await returns the same ready instance", async () => {
    const a = await ready()
    const b = await ready()
    expect(b).toBe(a)
  })
})
