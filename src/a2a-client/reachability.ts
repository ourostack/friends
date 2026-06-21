// reachability — the deterministic host-side ladder (§1.4). The SAME SealedEnvelope
// rides every rung; only the transport target differs. Post-demote, mailbox is
// top-level on AgentMeta, so direct/relay read `a2a` and the fallback reads the
// record's top-level `mailbox`.
//
//   1. a2a.endpointUrl present → direct
//   2. else a2a.relay present  → relay
//   3. else mailbox present    → mailbox (the demoted fallback)
//   4. else                    → unreachable
import type { AgentMeta } from "../types"

export type ReachabilityPlan =
  | { rung: "direct"; endpointUrl: string }
  | { rung: "relay"; relay: { url: string; handle: string } }
  | { rung: "mailbox"; mailbox: { repo: string; selfOutboxAgentId: string } }
  | { rung: "unreachable" }

/** Resolve the reachability rung for a peer from its A2A coords + (top-level)
 * mailbox coords. Deterministic, pure. */
export function resolveReachability(
  peerA2A: AgentMeta["a2a"] | undefined,
  peerMailbox: AgentMeta["mailbox"] | undefined,
): ReachabilityPlan {
  if (peerA2A?.endpointUrl) {
    return { rung: "direct", endpointUrl: peerA2A.endpointUrl }
  }
  if (peerA2A?.relay) {
    return { rung: "relay", relay: peerA2A.relay }
  }
  if (peerMailbox) {
    return { rung: "mailbox", mailbox: peerMailbox }
  }
  return { rung: "unreachable" }
}
