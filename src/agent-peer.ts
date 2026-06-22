// upsertAgentPeer — the record-shaping half of the harness's `onboardA2APeer`.
//
// Mints or updates an agent-peer friend record from already-resolved inputs. The
// HTTP agent-card fetch (`fetchA2AAgentCard` / `endpointForCard` / URL parsing)
// stays harness-side; this helper takes `agentId` and the `a2a` coords directly,
// so the MCP server can onboard a peer without any network call.
import { randomUUID } from "node:crypto"

import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { AgentMeta, FriendRecord, TrustLevel } from "./types"

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

export async function upsertAgentPeer(
  store: FriendStore,
  input: UpsertAgentPeerInput,
): Promise<FriendRecord> {
  const { name, agentId, a2a, bundleName } = input

  const existing = await store.findByExternalId("a2a-agent", agentId)
  const now = new Date().toISOString()
  // Bug A — cold contact is safe-by-default: a brand-new peer with no explicit
  // trustLevel and no existing record lands at `stranger`, not `acquaintance`. An
  // owner-initiated onboard that passes an explicit `trustLevel`, and an existing
  // record's level, both still win (they precede this fallback).
  const trustLevel: TrustLevel = input.trustLevel ?? existing?.trustLevel ?? "stranger"
  const baseMeta: AgentMeta = existing?.agentMeta ?? {
    bundleName: bundleName ?? name,
    familiarity: 0,
    sharedMissions: [],
    outcomes: [],
  }

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
    kind: "agent",
    agentMeta: {
      // `...baseMeta` already carries any existing top-level `mailbox`; an explicit
      // `input.mailbox` overrides it below. Mailbox is top-level on AgentMeta since
      // the phase-8 demote (was nested under `a2a` in alpha.4).
      ...baseMeta,
      bundleName: baseMeta.bundleName || bundleName || name,
      a2a: { ...(a2a ?? {}), agentId },
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

  await store.put(record.id, record)
  emitNervesEvent({
    component: "friends",
    event: "friends.agent_peer_upserted",
    message: "upserted agent peer record",
    meta: { friendId: record.id, trustLevel },
  })
  return record
}
