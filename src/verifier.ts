// AgentVerifier — Fork B. The pluggable authentication seam.
//
// The package does AUTHORIZATION (how much a verified peer's claims count, via
// the trust ladder). AUTHENTICATION of the wire is the caller's job — the same
// split that kept the A2A card-fetch harness-side. This interface is the seam: a
// caller can plug in DID/VC verification later. The default is trust-on-first-use
// (TOFU): it accepts any peer and ignores `proof`, matching upsertAgentPeer's
// onboard-on-first-contact behavior. The `proof?` slot is reserved on the
// envelope from day one so a stronger verifier can be dropped in without an
// envelope change.
import { emitNervesEvent } from "./observability"

export interface AgentVerifier {
  /** Whether `fromAgentId` is who it claims to be. `proof` is an opaque,
   * verifier-specific credential (a signature, a VC, …); the TOFU default
   * ignores it. */
  verify(fromAgentId: string, proof?: string): boolean
}

/** Trust-on-first-use: accept any peer, ignore `proof`. The day-one default; the
 * trust LADDER (not the wire) is what caps what a peer's claims are worth. */
export const tofuVerifier: AgentVerifier = {
  verify(fromAgentId: string): boolean {
    emitNervesEvent({
      component: "friends",
      event: "friends.agent_verified",
      message: "verified agent (tofu)",
      meta: { fromAgentId },
    })
    return true
  },
}

/** The default verifier used by `importProfileShare` when none is injected. */
export const DEFAULT_AGENT_VERIFIER: AgentVerifier = tofuVerifier
