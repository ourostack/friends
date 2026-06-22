// ed25519RosterVerifier — the RosterVerifier seam's REAL crypto implementation
// (a2a-client side; MAY import libsodium/jcs/sign). Mirrors how DidVerifier
// implements the AgentVerifier seam. The host injects this so the core stays
// transport-free.
//
// Contract (shared with src/roster-verifier.ts): the roster `sig` is an Ed25519
// detached signature over `jcsBytes({ accountId, members, epoch })` — the roster
// MINUS `sig` — exactly how `verifyEnvelopeSignature` signs the proof-stripped
// envelope. `rosterKey` is the base64 (ORIGINAL) Ed25519 public key.
import { jcsBytes } from "./jcs"
import type { Sodium } from "./sodium"
import type { RosterVerifier } from "../roster-verifier"
import type { AccountRoster } from "../roster-store"

/** The canonical bytes the roster `sig` is computed over: the roster minus its
 * `sig` field, JCS-canonicalized. Both signer and verifier MUST produce these
 * identical bytes. */
function rosterSigningBytes(roster: AccountRoster): Uint8Array {
  return jcsBytes({ accountId: roster.accountId, members: roster.members, epoch: roster.epoch })
}

/** A RosterVerifier that checks the roster's Ed25519 signature against the base64
 * `rosterKey`. Returns false (never throws) on a malformed key/sig or a bad
 * signature. (Unit 7a stub — verify not implemented.) */
export function ed25519RosterVerifier(sodium: Sodium): RosterVerifier {
  return {
    verify(roster: AccountRoster, rosterKey: string): boolean {
      let pub: Uint8Array
      let sig: Uint8Array
      try {
        pub = sodium.from_base64(rosterKey, sodium.base64_variants.ORIGINAL)
        sig = sodium.from_base64(roster.sig, sodium.base64_variants.ORIGINAL)
      } catch {
        // Malformed base64 in the key or sig → a failed verification, never a throw.
        return false
      }
      const msg = rosterSigningBytes(roster)
      try {
        return sodium.crypto_sign_verify_detached(sig, msg, pub)
      } catch {
        // A wrong-length key/sig can throw inside libsodium — treat as a failed
        // verification, never an uncaught error (mirrors verifyEnvelopeSignature).
        return false
      }
    },
  }
}

/** Test/host helper: produce a valid roster `sig` by signing `rosterSigningBytes`
 * with the account's Ed25519 private key (mirrors `signSuccessor`/`signEnvelope`).
 * Returns the base64 (ORIGINAL) detached signature. */
export function signRoster(input: {
  sodium: Sodium
  accountKeyPriv: Uint8Array
  roster: Omit<AccountRoster, "sig">
}): string {
  const { sodium, accountKeyPriv, roster } = input
  const msg = jcsBytes({ accountId: roster.accountId, members: roster.members, epoch: roster.epoch })
  const sig = sodium.crypto_sign_detached(msg, accountKeyPriv)
  return sodium.to_base64(sig, sodium.base64_variants.ORIGINAL)
}
