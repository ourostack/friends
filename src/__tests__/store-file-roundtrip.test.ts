import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { FileFriendStore } from "../index"
import type { FriendRecord } from "../index"

const T = "2026-01-01T00:00:00.000Z"

/** A record with every optional FriendRecord and AgentMeta field populated. */
function fullRecord(): FriendRecord {
  return {
    id: "full-1",
    name: "Claude Code",
    role: "agent-peer",
    trustLevel: "friend",
    admissionState: "active",
    initiativePolicy: "reactive_only",
    relationshipPolicy: {
      schemaVersion: 1,
      version: 3,
      preferences: { tone: { value: "brief", provenance: "stated", version: 1, source: "ari", expiresAt: "2027-01-01T00:00:00.000Z" } },
    },
    capabilityProfileId: "sanctuary-owner",
    delegationGrant: { scope: "principal_commands", grantedAt: T, source: "operator" },
    connections: [{ name: "Ari", relationship: "principal" }],
    externalIds: [
      { provider: "a2a-agent", externalId: "peer-1", linkedAt: T },
      { provider: "aad", externalId: "aad-1", tenantId: "t1", linkedAt: T },
    ],
    tenantMemberships: ["t1"],
    toolPreferences: { github: "gh" },
    notes: { likes: { value: "tea", savedAt: T, shareable: true, provenance: { origin: "first_party" } } },
    importedNotes: { "peer-2": { mood: { value: "calm", importedAt: T, assertedBy: { agentId: "peer-2" } } } },
    importedExternalIds: [{ provider: "telegram-user", externalId: "555", assertedBy: { agentId: "peer-2" }, importedAt: T }],
    trustReset: { at: T, reason: "did_changed", previousDid: "did:key:OLD", previousTrust: "family" },
    totalTokens: 12,
    createdAt: T,
    updatedAt: T,
    schemaVersion: 1,
    kind: "agent",
    agentMeta: {
      bundleName: "claude-code",
      familiarity: 4,
      sharedMissions: ["m1"],
      outcomes: [],
      identity: { did: "did:key:NEW", pinnedKey: "PUB", handle: "cc", pinnedAt: T },
      a2a: {
        cardUrl: "https://c",
        endpointUrl: "https://e",
        agentId: "peer-1",
        protocolVersion: "1.0",
        relay: { url: "https://relay", handle: "h" },
        did: "did:key:NEW",
      },
      mailbox: { repo: "/m", selfOutboxAgentId: "a" },
    },
  }
}

describe("FileFriendStore round trip", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("reads back every FriendRecord field it was given (audit finding 13)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-roundtrip-"))
    dirs.push(dir)
    const store = new FileFriendStore(join(dir, "friends"))
    const record = fullRecord()
    await store.put(record.id, record)
    const read = await new FileFriendStore(join(dir, "friends")).get(record.id)
    const { recordIncarnation, recordGeneration, ...rest } = read!
    expect(recordIncarnation).toBeTruthy()
    expect(recordGeneration).toBe(0)
    expect(rest).toEqual(record)
  })
})
