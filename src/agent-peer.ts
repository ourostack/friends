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
  const trustLevel: TrustLevel = input.trustLevel ?? existing?.trustLevel ?? "acquaintance"
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
      ...baseMeta,
      bundleName: baseMeta.bundleName || bundleName || name,
      a2a: { ...(a2a ?? {}), agentId, ...(input.mailbox ? { mailbox: input.mailbox } : {}) },
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
