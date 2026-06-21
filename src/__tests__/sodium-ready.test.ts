// Smoke test: proves libsodium's WASM init works inside Vitest and the exact
// primitives the overlay needs are present at the pinned version (0.8.4). If
// this fails, the whole crypto build is moot — fail fast and loud here.
import { describe, expect, it } from "vitest"

import { readySodium } from "./_sodium"

describe("libsodium-wrappers WASM init (toolchain smoke)", () => {
  it("initializes and exposes the primitives the overlay depends on", async () => {
    const sodium = await readySodium()

    // Signing (Ed25519) + the AEAD seal primitives + the did:key derivations.
    expect(typeof sodium.crypto_sign_keypair).toBe("function")
    expect(typeof sodium.crypto_sign_detached).toBe("function")
    expect(typeof sodium.crypto_sign_verify_detached).toBe("function")
    expect(typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt).toBe("function")
    expect(typeof sodium.crypto_aead_xchacha20poly1305_ietf_decrypt).toBe("function")
    expect(typeof sodium.crypto_scalarmult).toBe("function")
    expect(typeof sodium.crypto_generichash).toBe("function")
    expect(typeof sodium.crypto_sign_ed25519_pk_to_curve25519).toBe("function")
    expect(typeof sodium.crypto_sign_ed25519_sk_to_curve25519).toBe("function")
    expect(typeof sodium.randombytes_buf).toBe("function")
    expect(typeof sodium.to_base64).toBe("function")
    expect(typeof sodium.from_base64).toBe("function")

    // The XChaCha20-Poly1305 IETF nonce length is the 24-byte value the seal uses.
    expect(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES).toBe(24)
  })
})
