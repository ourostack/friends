// sodium — the single libsodium init seam for the a2a-client.
//
// libsodium-wrappers is WASM with async init; nothing crypto-bearing may run
// before `await _sodium.ready`. Every entry point that touches a primitive funnels
// through `ready()` so the WASM is initialized exactly once. Downstream code takes
// the resolved `Sodium` instance as a parameter (it never re-imports the module),
// which keeps the crypto functions pure and synchronous past this seam.
import _sodium from "libsodium-wrappers"

/** The libsodium-wrappers instance type. */
export type Sodium = typeof _sodium

/** Await the WASM init (idempotent) and return the ready libsodium instance. */
export async function ready(): Promise<Sodium> {
  await _sodium.ready
  return _sodium
}
