// upsertAgentPeer — the record-shaping half of the harness's `onboardA2APeer`.
//
// Mints or updates an agent-peer friend record from already-resolved inputs. The
// HTTP agent-card fetch (`fetchA2AAgentCard` / `endpointForCard` / URL parsing)
// stays harness-side; this helper takes `agentId` and the `a2a` coords directly,
// so the MCP server can onboard a peer without any network call.
import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import { resolveAgentIdentity } from "./identity"
import type { AgentMeta, FriendRecord, TrustLevel, TrustReset } from "./types"

const TRUST_ORDER: Record<TrustLevel, number> = { stranger: 1, acquaintance: 2, friend: 3, family: 4 }

export interface UpsertAgentPeerInput {
  name: string
  agentId: string
  trustLevel?: TrustLevel
  a2a?: AgentMeta["a2a"]
  /** Optional A2A git-mailbox coords — the ergonomic top-level path the MCP
   * `onboard_agent` tool uses. Folded into the rebuilt `a2a`; if also set inside
   * `a2a`, this explicit value wins (last spread). Absent ⇒ no mailbox key. */
  mailbox?: { repo: string; selfOutboxAgentId: string }
  bundleName?: string
}

/** The stored record, plus (on this return value only) whether the peer's DID changed. */
export type UpsertAgentPeerResult = FriendRecord & {
  didChanged?: true
  previousDid?: string
  trustReset?: TrustReset
  /** The caller asked for a higher trust level than the record now holds, and it was
   * ignored (a DID change or a pending reset). Raise it with setFriendTrust. */
  trustRaiseIgnored?: true
}

export async function upsertAgentPeer(
  store: FriendStore,
  input: UpsertAgentPeerInput,
): Promise<UpsertAgentPeerResult> {
  const { name, agentId, a2a, bundleName } = input

  const existing = await store.findByExternalId("a2a-agent", agentId)
  const now = new Date().toISOString()
  // Bug A — cold contact is safe-by-default: a brand-new peer with no explicit
  // trustLevel and no existing record lands at `stranger`, not `acquaintance`. An
  // owner-initiated onboard that passes an explicit `trustLevel`, and an existing
  // record's level, both still win (they precede this fallback).
  //
  // A different DID on an existing record is a different peer: authority resets and
  // no caller option can exempt it (a rotation goes through the DID verifier's signed
  // successor statement, never through here).
  //
  // An empty or whitespace DID counts as "no DID supplied": it neither erases the
  // pinned DID nor overrides it.
  const suppliedDid = a2a?.did?.trim() || undefined
  const previousDid = resolveAgentIdentity(existing?.agentMeta).did
  // A record that holds authority but has no DID yet must not keep it by adopting
  // whatever DID the caller names first.
  const holdsAuthority = Boolean(
    existing &&
      ((existing.trustLevel !== undefined && existing.trustLevel !== "stranger") ||
        existing.capabilityProfileId !== undefined ||
        existing.delegationGrant !== undefined ||
        existing.admissionState === "active"),
  )
  const dropped = Boolean(existing && suppliedDid && (previousDid ? suppliedDid !== previousDid : holdsAuthority))
  const didChanged = dropped
  const trustReset: TrustReset | undefined = didChanged
    ? {
        at: now,
        reason: previousDid ? "did_changed" : "did_adopted",
        ...(previousDid ? { previousDid } : {}),
        previousTrust: existing!.trustLevel ?? "stranger",
      }
    : undefined
  // While a DID-change reset marker is set, the stored trust level wins in both
  // directions: an onboard can neither raise nor lower it. Changing it goes through
  // setFriendTrust, which clears the marker on a raise.
  const trustLevel: TrustLevel = didChanged
    ? "stranger"
    : existing?.trustReset
      ? existing.trustLevel ?? "stranger"
      : input.trustLevel ?? existing?.trustLevel ?? "stranger"
  const baseMeta: AgentMeta = existing?.agentMeta ?? {
    bundleName: bundleName ?? name,
    familiarity: 0,
    sharedMissions: [],
    outcomes: [],
  }

  const { identity: _staleIdentity, mailbox: _staleMailbox, ...metaWithoutIdentity } = baseMeta
  const carriedMeta: AgentMeta = didChanged ? metaWithoutIdentity : baseMeta
  // The other coordinates are rebuilt from the input, but a re-onboard that names no
  // DID keeps the pinned one. When the DID changed, none of the old peer's coordinates
  // carry over.
  const keptDid = !didChanged && !suppliedDid && baseMeta.a2a?.did ? { did: baseMeta.a2a.did } : {}
  const { did: _ignoredDid, ...a2aWithoutDid } = a2a ?? {}
  const mergedA2a = { ...keptDid, ...a2aWithoutDid, ...(suppliedDid ? { did: suppliedDid } : {}) }

  const record: FriendRecord = {
    ...(existing ?? {
      id: randomUUID(),
      createdAt: now,
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      schemaVersion: 1,
    }),
    name,
    role: "agent-peer",
    trustLevel,
    ...(didChanged
      ? { admissionState: "unverified" as const, trustReset }
      : {}),
    kind: "agent",
    agentMeta: {
      // `...baseMeta` already carries any existing top-level `mailbox`; an explicit
      // `input.mailbox` overrides it below. Mailbox is top-level on AgentMeta since
      // the phase-8 demote (was nested under `a2a` in alpha.4).
      ...carriedMeta,
      bundleName: baseMeta.bundleName || bundleName || name,
      a2a: { ...mergedA2a, agentId },
      ...(input.mailbox ? { mailbox: input.mailbox } : {}),
    },
    externalIds: [
      ...(existing?.externalIds.filter(
        (id) => !(id.provider === "a2a-agent" && id.externalId === agentId),
      ) ?? []),
      { provider: "a2a-agent", externalId: agentId, linkedAt: now },
    ],
    updatedAt: now,
  }

  if (didChanged) {
    delete record.capabilityProfileId
    delete record.delegationGrant
  }
  const settled = dropGrantBelowFamily(record)
  await store.put(settled.id, settled)
  if (didChanged) {
    emitNervesEvent({
      level: "warn",
      component: "friends",
      event: "friends.peer_did_changed",
      message: "peer DID changed on re-onboard; trust and grants reset to stranger",
      meta: { friendId: settled.id, previousDid, previousTrust: trustReset!.previousTrust },
    })
  }
  emitNervesEvent({
    component: "friends",
    event: "friends.agent_peer_upserted",
    message: "upserted agent peer record",
    meta: { friendId: settled.id, trustLevel },
  })
  const trustRaiseIgnored =
    input.trustLevel !== undefined && TRUST_ORDER[input.trustLevel] > TRUST_ORDER[trustLevel]
  return {
    ...settled,
    ...(didChanged ? { didChanged: true as const, previousDid } : {}),
    ...(trustRaiseIgnored ? { trustRaiseIgnored: true as const } : {}),
  }
}

/** The legacy record grant is never carried below family (finding 10), or a later
 * re-promotion would revive it. */
function dropGrantBelowFamily(record: FriendRecord): FriendRecord {
  if (record.trustLevel === "family" || record.delegationGrant === undefined) return record
  const { delegationGrant: _dropped, ...rest } = record
  return rest
}
