import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
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

  it("drops malformed identity, trustReset and importedExternalIds instead of trusting them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friends-malformed-"))
    dirs.push(dir)
    const friendsPath = join(dir, "friends")
    mkdirSync(friendsPath, { recursive: true })
    const base = fullRecord()
    const bad = {
      ...base,
      id: "bad-1",
      trustReset: { at: T, reason: "did_changed", previousDid: "did:key:OLD", previousTrust: "emperor" },
      importedExternalIds: [
        null,
        "nope",
        { provider: "not-a-provider", externalId: "1", importedAt: T, assertedBy: { agentId: "p" } },
        { provider: "aad", externalId: "2", importedAt: T },
        { provider: "aad", externalId: "3", importedAt: T, assertedBy: { agentId: "p" }, tenantId: "t" },
      ],
      agentMeta: { ...base.agentMeta!, identity: { pinnedKey: "no-did" } },
    }
    writeFileSync(join(friendsPath, "bad-1.json"), JSON.stringify(bad))
    writeFileSync(join(friendsPath, "bad-2.json"), JSON.stringify({ ...bad, id: "bad-2", trustReset: "x", importedExternalIds: "x", agentMeta: { ...base.agentMeta!, identity: "x" } }))
    const store = new FileFriendStore(friendsPath)
    const one = await store.get("bad-1")
    expect(one?.trustReset).toBeUndefined()
    expect(one?.agentMeta?.identity).toBeUndefined()
    expect(one?.importedExternalIds).toEqual([{ provider: "aad", externalId: "3", tenantId: "t", importedAt: T, assertedBy: { agentId: "p" } }])
    writeFileSync(join(friendsPath, "bad-3.json"), JSON.stringify({ ...bad, id: "bad-3", importedExternalIds: [null], agentMeta: { ...base.agentMeta!, identity: { did: "did:key:ONLY" } } }))
    const three = await store.get("bad-3")
    expect(three?.importedExternalIds).toBeUndefined()
    expect(three?.agentMeta?.identity).toEqual({ did: "did:key:ONLY" })
    await expect(store.releaseExternalId("../escape", { provider: "aad", externalId: "x", linkedAt: T })).rejects.toThrow("invalid")
    writeFileSync(join(friendsPath, "bad-4.json"), JSON.stringify({ ...bad, id: "bad-4", importedExternalIds: [
      { provider: "aad", externalId: "9", importedAt: T, assertedBy: { agentId: "p", agentName: "Peer", evil: "x" } },
      { provider: "aad", externalId: "8", importedAt: T, assertedBy: { agentId: "p", agentName: 5 } },
      { provider: "aad", externalId: "7", importedAt: T, assertedBy: { agentId: 5 } },
    ] }))
    const four = await store.get("bad-4")
    expect(four?.importedExternalIds).toEqual([
      { provider: "aad", externalId: "9", importedAt: T, assertedBy: { agentId: "p", agentName: "Peer" } },
      { provider: "aad", externalId: "8", importedAt: T, assertedBy: { agentId: "p" } },
    ])
    writeFileSync(join(friendsPath, "bad-5.json"), JSON.stringify({ ...bad, id: "bad-5", trustReset: { at: T, reason: "did_adopted", previousTrust: "friend" } }))
    expect((await store.get("bad-5"))?.trustReset).toEqual({ at: T, reason: "did_adopted", previousTrust: "friend" })
    writeFileSync(join(friendsPath, "bad-6.json"), JSON.stringify({ ...bad, id: "bad-6", trustReset: { at: T, reason: "did_changed", previousDid: 5, previousTrust: "friend" } }))
    expect((await store.get("bad-6"))?.trustReset).toBeUndefined()
    writeFileSync(join(friendsPath, "bad-7.json"), JSON.stringify({ ...bad, id: "bad-7", trustReset: { at: T, reason: "other", previousTrust: "friend" } }))
    expect((await store.get("bad-7"))?.trustReset).toBeUndefined()
    const two = await store.get("bad-2")
    expect(two?.trustReset).toBeUndefined()
    expect(two?.importedExternalIds).toBeUndefined()
    expect(two?.agentMeta?.identity).toBeUndefined()
  })
})
