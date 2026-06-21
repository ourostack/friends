import { describe, it, expect } from "vitest"

import {
  prepareProfileShare,
  importProfileShare,
  strictPolicy,
  tieredPolicy,
} from "../index"
import type {
  FriendStore,
  GrantStore,
  FriendRecord,
  ShareGrant,
  IdentityProvider,
  AgentVerifier,
  ProfileShareEnvelope,
} from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

class MemoryStore implements FriendStore {
  readonly records = new Map<string, FriendRecord>()
  putCalls = 0
  constructor(initial: FriendRecord[] = []) {
    for (const f of initial) this.records.set(f.id, f)
  }
  async get(id: string) {
    return this.records.get(id) ?? null
  }
  async put(id: string, record: FriendRecord) {
    this.putCalls += 1
    this.records.set(id, record)
  }
  async delete(id: string) {
    this.records.delete(id)
  }
  async findByExternalId(provider: string, externalId: string, tenantId?: string) {
    for (const r of this.records.values()) {
      if (r.externalIds.find((e) => e.provider === provider && e.externalId === externalId && (tenantId === undefined || e.tenantId === tenantId))) {
        return r
      }
    }
    return null
  }
  async listAll() {
    return Array.from(this.records.values())
  }
}

class MemoryGrantStore implements GrantStore {
  readonly grants = new Map<string, ShareGrant>()
  constructor(initial: ShareGrant[] = []) {
    for (const g of initial) this.grants.set(g.id, g)
  }
  async get(id: string) {
    return this.grants.get(id) ?? null
  }
  async put(id: string, grant: ShareGrant) {
    this.grants.set(id, grant)
  }
  async delete(id: string) {
    this.grants.delete(id)
  }
  async listAll() {
    return Array.from(this.grants.values())
  }
}

function subject(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "subj-1",
    name: "Jordan",
    role: "friend",
    trustLevel: "friend",
    connections: [],
    externalIds: [{ provider: "aad" as IdentityProvider, externalId: "jordan-aad", linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }
}

function recipientAgent(trustLevel: FriendRecord["trustLevel"], agentId = "agent-2"): FriendRecord {
  return {
    id: `rec-${agentId}`,
    name: "Recipient Agent",
    role: "agent-peer",
    trustLevel,
    connections: [],
    externalIds: [{ provider: "a2a-agent" as IdentityProvider, externalId: agentId, linkedAt: NOW }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "agent",
  }
}

function grant(scope: ShareGrant["scope"], overrides: Partial<ShareGrant> = {}): ShareGrant {
  return {
    id: "g-1",
    subjectKey: "subj-1",
    recipientAgentId: "agent-2",
    scope,
    grantedAt: NOW,
    ...overrides,
  }
}

// ── PRODUCER ──

describe("prepareProfileShare — producer", () => {
  it("returns not_found when the friend is missing", async () => {
    const store = new MemoryStore()
    const grants = new MemoryGrantStore()
    const result = await prepareProfileShare(store, grants, {
      friendId: "ghost",
      toAgentId: "agent-2",
      scope: "identity",
      selfAgentId: "self",
    })
    expect(result).toEqual({ ok: false, status: "not_found" })
  })

  it("returns no_consent when the policy refuses (identity scope, untrusted recipient, tiered)", async () => {
    const store = new MemoryStore([subject(), recipientAgent("acquaintance")])
    const grants = new MemoryGrantStore()
    const result = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "identity",
      selfAgentId: "self",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("no_consent")
  })

  it("names the subject by join key (externalIds), never the local UUID", async () => {
    const store = new MemoryStore([subject(), recipientAgent("friend")])
    const grants = new MemoryGrantStore()
    const result = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "identity",
      selfAgentId: "self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.subject.externalIds[0].externalId).toBe("jordan-aad")
      expect(result.envelope.subject.displayName).toBe("Jordan")
      // The serialized envelope must not leak the local UUID anywhere.
      expect(JSON.stringify(result.envelope)).not.toContain("subj-1")
      expect(result.envelope.fromAgentId).toBe("self")
      expect(result.envelope.notes).toBeUndefined()
      expect(result.envelope.outcomes).toBeUndefined()
    }
  })

  it("defaults an unknown recipient to stranger trust (refused on identity under tiered)", async () => {
    const store = new MemoryStore([subject()]) // no recipient record
    const grants = new MemoryGrantStore()
    const result = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "unknown-agent",
      scope: "identity",
      selfAgentId: "self",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("no_consent")
  })

  it("notes:safe shares only notes marked shareable, attributing first-party facts to self", async () => {
    const store = new MemoryStore([
      subject({
        notes: {
          role: { value: "PM", savedAt: NOW, shareable: true },
          secret: { value: "private", savedAt: NOW }, // not shareable
        },
      }),
    ])
    const grants = new MemoryGrantStore([grant("notes:safe")])
    const result = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "notes:safe",
      selfAgentId: "self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.notes).toHaveLength(1)
      expect(result.envelope.notes![0].key).toBe("role")
      expect(result.envelope.notes![0].value).toBe("PM")
      // First-party fact → originally asserted by self.
      expect(result.envelope.notes![0].originallyAssertedBy).toEqual({ agentId: "self" })
    }
  })

  it("notes:all shares every note regardless of the shareable flag", async () => {
    const store = new MemoryStore([
      subject({
        notes: {
          role: { value: "PM", savedAt: NOW, shareable: true },
          secret: { value: "private", savedAt: NOW },
        },
      }),
    ])
    const grants = new MemoryGrantStore([grant("notes:all")])
    const result = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "notes:all",
      selfAgentId: "self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.notes?.map((n) => n.key).sort()).toEqual(["role", "secret"])
    }
  })

  it("preserves originallyAssertedBy for an imported note (never laundered to first-party)", async () => {
    const store = new MemoryStore([
      subject({
        notes: {
          relayed: {
            value: "from elsewhere",
            savedAt: NOW,
            shareable: true,
            provenance: { origin: "imported", assertedBy: { agentId: "origin-agent", agentName: "Origin" } },
          },
        },
      }),
    ])
    const grants = new MemoryGrantStore([grant("notes:safe")])
    const result = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "notes:safe",
      selfAgentId: "self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // The original asserter is carried through — NOT relabeled as self.
      expect(result.envelope.notes![0].originallyAssertedBy).toEqual({ agentId: "origin-agent", agentName: "Origin" })
    }
  })

  it("falls back to selfAgentId for an imported note whose assertedBy is absent", async () => {
    const store = new MemoryStore([
      subject({
        notes: {
          relayed: {
            value: "mystery origin",
            savedAt: NOW,
            shareable: true,
            provenance: { origin: "imported" }, // imported but no assertedBy
          },
        },
      }),
    ])
    const grants = new MemoryGrantStore([grant("notes:safe")])
    const result = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "notes:safe",
      selfAgentId: "self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.notes![0].originallyAssertedBy).toEqual({ agentId: "self" })
    }
  })

  it("outcomes scope carries the friend's relationship outcomes", async () => {
    const store = new MemoryStore([
      subject({
        kind: "agent",
        agentMeta: {
          bundleName: "Jordan",
          familiarity: 2,
          sharedMissions: ["m1"],
          outcomes: [{ missionId: "m1", result: "success", timestamp: NOW }],
        },
      }),
    ])
    const grants = new MemoryGrantStore([grant("outcomes")])
    const result = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "outcomes",
      selfAgentId: "self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.outcomes).toHaveLength(1)
      expect(result.envelope.outcomes![0].missionId).toBe("m1")
      expect(result.envelope.notes).toBeUndefined()
    }
  })

  it("outcomes scope yields an empty array when the record has no agentMeta", async () => {
    const store = new MemoryStore([subject()]) // human, no agentMeta
    const grants = new MemoryGrantStore([grant("outcomes")])
    const result = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "outcomes",
      selfAgentId: "self",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.envelope.outcomes).toEqual([])
  })

  it("stamps the proof slot when provided and omits it otherwise", async () => {
    const store = new MemoryStore([subject(), recipientAgent("friend")])
    const grants = new MemoryGrantStore()
    const withProof = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "identity",
      selfAgentId: "self",
      proof: "sig-abc",
    })
    expect(withProof.ok).toBe(true)
    if (withProof.ok) expect(withProof.envelope.proof).toBe("sig-abc")

    const withoutProof = await prepareProfileShare(store, grants, {
      friendId: "subj-1",
      toAgentId: "agent-2",
      scope: "identity",
      selfAgentId: "self",
    })
    expect(withoutProof.ok).toBe(true)
    if (withoutProof.ok) expect("proof" in withoutProof.envelope).toBe(false)
  })

  it("honors an injected consent policy over the default", async () => {
    // strictPolicy refuses identity even at friend trust without a grant.
    const store = new MemoryStore([subject(), recipientAgent("friend")])
    const grants = new MemoryGrantStore()
    const result = await prepareProfileShare(
      store,
      grants,
      { friendId: "subj-1", toAgentId: "agent-2", scope: "identity", selfAgentId: "self" },
      strictPolicy,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("no_consent")

    // With a grant, strict consents.
    const granted = new MemoryGrantStore([grant("identity")])
    const ok = await prepareProfileShare(
      store,
      granted,
      { friendId: "subj-1", toAgentId: "agent-2", scope: "identity", selfAgentId: "self" },
      strictPolicy,
    )
    expect(ok.ok).toBe(true)
  })
})

// ── CONSUMER ──

function envelope(overrides: Partial<ProfileShareEnvelope> = {}): ProfileShareEnvelope {
  return {
    subject: {
      externalIds: [{ provider: "aad", externalId: "jordan-aad", linkedAt: NOW }],
      displayName: "Jordan",
    },
    fromAgentId: "source-agent",
    scope: "notes:safe",
    notes: [{ key: "role", value: "PM", originallyAssertedBy: { agentId: "source-agent" } }],
    issuedAt: NOW,
    ...overrides,
  }
}

describe("importProfileShare — consumer (the non-clobbering merge)", () => {
  it("refuses when the source trust is below the acceptance floor (stranger)", async () => {
    const store = new MemoryStore([subject()])
    const result = await importProfileShare(store, {
      envelope: envelope(),
      fromAgentId: "source-agent",
      trustOfSource: "stranger",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
    expect(store.putCalls).toBe(0)
  })

  it("refuses when the verifier rejects the source, even at high trust", async () => {
    const denyVerifier: AgentVerifier = { verify: () => false }
    const store = new MemoryStore([subject()])
    const result = await importProfileShare(
      store,
      { envelope: envelope(), fromAgentId: "source-agent", trustOfSource: "family" },
      { verifier: denyVerifier },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
  })

  it("imports facts into the importedNotes namespace WITHOUT touching first-party notes", async () => {
    const store = new MemoryStore([
      subject({
        trustLevel: "acquaintance",
        notes: { role: { value: "FIRST-PARTY", savedAt: NOW } }, // same key, first-party
      }),
    ])
    const result = await importProfileShare(store, {
      envelope: envelope({ notes: [{ key: "role", value: "IMPORTED", originallyAssertedBy: { agentId: "origin" } }] }),
      fromAgentId: "source-agent",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // First-party note is physically untouched — first-party always wins.
      expect(result.record.notes.role.value).toBe("FIRST-PARTY")
      // The imported fact lives in the separate namespace under the source agentId.
      const imported = result.record.importedNotes!["source-agent"].role
      expect(imported.value).toBe("IMPORTED")
      expect(imported.assertedBy).toEqual({ agentId: "source-agent" })
      expect(imported.originallyAssertedBy).toEqual({ agentId: "origin" })
      expect(imported.importedAt).toBeTruthy()
    }
  })

  it("NEVER changes the party's trust level on import (the key safety invariant)", async () => {
    const store = new MemoryStore([subject({ trustLevel: "acquaintance", role: "acquaintance" })])
    const result = await importProfileShare(store, {
      envelope: envelope(),
      fromAgentId: "source-agent",
      trustOfSource: "family", // a family source must NOT elevate the party
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.trustLevel).toBe("acquaintance")
      expect(result.record.role).toBe("acquaintance")
    }
  })

  it("merges a second import from a DIFFERENT agent into its own namespace slot", async () => {
    const store = new MemoryStore([
      subject({
        importedNotes: { "other-agent": { city: { value: "Seattle", importedAt: NOW } } },
      }),
    ])
    const result = await importProfileShare(store, {
      envelope: envelope({ notes: [{ key: "role", value: "PM" }] }),
      fromAgentId: "source-agent",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.importedNotes!["other-agent"].city.value).toBe("Seattle")
      expect(result.record.importedNotes!["source-agent"].role.value).toBe("PM")
    }
  })

  it("merges a re-import from the SAME agent, newest value winning per key", async () => {
    const store = new MemoryStore([
      subject({
        importedNotes: { "source-agent": { role: { value: "OLD", importedAt: NOW }, city: { value: "Reno", importedAt: NOW } } },
      }),
    ])
    const result = await importProfileShare(store, {
      envelope: envelope({ notes: [{ key: "role", value: "NEW" }] }),
      fromAgentId: "source-agent",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.record.importedNotes!["source-agent"].role.value).toBe("NEW")
      // The other key from the prior import survives.
      expect(result.record.importedNotes!["source-agent"].city.value).toBe("Reno")
    }
  })

  it("an import with no notes (identity scope) leaves importedNotes unchanged", async () => {
    const store = new MemoryStore([
      subject({ importedNotes: { "x": { k: { value: "v", importedAt: NOW } } } }),
    ])
    const result = await importProfileShare(store, {
      envelope: envelope({ scope: "identity", notes: undefined }),
      fromAgentId: "source-agent",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.importedNotes).toEqual({ x: { k: { value: "v", importedAt: NOW } } })
  })

  it("an import with no notes onto a record that never imported anything keeps importedNotes absent", async () => {
    const store = new MemoryStore([subject()])
    const result = await importProfileShare(store, {
      envelope: envelope({ scope: "identity", notes: undefined }),
      fromAgentId: "source-agent",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.importedNotes).toBeUndefined()
  })

  it("an empty notes array does not create an importedNotes slot", async () => {
    const store = new MemoryStore([subject()])
    const result = await importProfileShare(store, {
      envelope: envelope({ notes: [] }),
      fromAgentId: "source-agent",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.record.importedNotes).toBeUndefined()
  })

  it("resolves the party by the SECOND externalId when the first does not match", async () => {
    const store = new MemoryStore([
      subject({ externalIds: [{ provider: "teams-conversation", externalId: "conv-9", linkedAt: NOW }] }),
    ])
    const result = await importProfileShare(store, {
      envelope: envelope({
        subject: {
          externalIds: [
            { provider: "aad", externalId: "no-match", linkedAt: NOW },
            { provider: "teams-conversation", externalId: "conv-9", linkedAt: NOW },
          ],
          displayName: "Jordan",
        },
      }),
      fromAgentId: "source-agent",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("imported")
      expect(result.record.id).toBe("subj-1")
    }
  })

  it("seeds an unknown party at acquaintance when a FRIEND peer introduces it (Fork E)", async () => {
    const store = new MemoryStore() // unknown party
    const result = await importProfileShare(store, {
      envelope: envelope({ notes: [{ key: "role", value: "PM", originallyAssertedBy: { agentId: "origin" } }] }),
      fromAgentId: "source-agent",
      trustOfSource: "friend",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("seeded")
      expect(result.record.trustLevel).toBe("acquaintance")
      expect(result.record.role).toBe("acquaintance")
      expect(result.record.kind).toBe("human")
      expect(result.record.name).toBe("Jordan")
      expect(result.record.externalIds[0].externalId).toBe("jordan-aad")
      // The introduced fact lands in the imported namespace, not first-party.
      expect(result.record.notes).toEqual({})
      expect(result.record.importedNotes!["source-agent"].role.value).toBe("PM")
    }
    expect(store.putCalls).toBe(1)
  })

  it("seeds an unknown party when a FAMILY peer introduces it", async () => {
    const store = new MemoryStore()
    const result = await importProfileShare(store, {
      envelope: envelope({ notes: undefined, scope: "identity" }),
      fromAgentId: "source-agent",
      trustOfSource: "family",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.status).toBe("seeded")
      expect(result.record.importedNotes).toBeUndefined()
    }
  })

  it("refuses to seed an unknown party when an ACQUAINTANCE peer introduces it", async () => {
    const store = new MemoryStore()
    const result = await importProfileShare(store, {
      envelope: envelope(),
      fromAgentId: "source-agent",
      trustOfSource: "acquaintance",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_introduction")
    expect(store.putCalls).toBe(0)
  })

  it("honors a custom minTrustToAccept (raising the floor to friend)", async () => {
    const store = new MemoryStore([subject()])
    const result = await importProfileShare(
      store,
      { envelope: envelope(), fromAgentId: "source-agent", trustOfSource: "acquaintance" },
      { minTrustToAccept: "friend" },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe("untrusted_source")
  })

  it("accepts a verified source carrying a proof via a custom verifier", async () => {
    const proofVerifier: AgentVerifier = { verify: (_id, proof) => proof === "ok" }
    const store = new MemoryStore([subject()])
    const result = await importProfileShare(
      store,
      { envelope: envelope({ proof: "ok" }), fromAgentId: "source-agent", trustOfSource: "friend" },
      { verifier: proofVerifier },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.status).toBe("imported")
  })
})
