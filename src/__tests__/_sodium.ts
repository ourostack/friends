// Shared test helper: a single, awaited libsodium instance. libsodium-wrappers
// is WASM with async init — every crypto test MUST `await readySodium()` before
// touching a primitive. This file lives under __tests__/ so it is
// coverage-excluded (it is test infrastructure, not shipped code).
import _sodium from "libsodium-wrappers"

export type Sodium = typeof _sodium

/** Await the WASM init once and hand back the ready instance. */
export async function readySodium(): Promise<Sodium> {
  await _sodium.ready
  return _sodium
}
