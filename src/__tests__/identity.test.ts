import { describe, it, expect } from "vitest"

import { resolveAgentIdentity, withMigratedIdentity, setNervesEmitter } from "../index"
import type { AgentMeta, NervesEvent } from "../index"

function meta(overrides: Partial<AgentMeta> = {}): AgentMeta {
  return {
    bundleName: "peer",
    familiarity: 0,
    sharedMissions: [],
    outcomes: [],
    ...overrides,
  }
}

describe("resolveAgentIdentity", () => {
  it("uses meta.identity as-is when present", () => {
    const r = resolveAgentIdentity(meta({ identity: { did: "did:key:zA", pinnedKey: "kA", handle: "alice", pinnedAt: "2026-01-01T00:00:00.000Z" } }))
    expect(r.did).toBe("did:key:zA")
    expect(r.pinnedKey).toBe("kA")
    expect(r.handle).toBe("alice")
    expect(r.pinnedAt).toBe("2026-01-01T00:00:00.000Z")
  })

  it("lifts a legacy a2a.did into { did } when there is no identity (migrate-on-read)", () => {
    const r = resolveAgentIdentity(meta({ a2a: { did: "did:key:zB", agentId: "did:key:zB" } }))
    expect(r).toEqual({ did: "did:key:zB" })
  })

  it("returns {} for a did-less legacy record (no identity, no a2a.did)", () => {
    const r = resolveAgentIdentity(meta({ a2a: { agentId: "peer-1" } }))
    expect(r).toEqual({})
  })

  it("returns {} for an entirely a2a-less meta", () => {
    expect(resolveAgentIdentity(meta())).toEqual({})
  })

  it("prefers identity.did over a2a.did when both are present (durable home is authoritative)", () => {
    const r = resolveAgentIdentity(meta({ identity: { did: "did:key:zHome" }, a2a: { did: "did:key:zLegacy", agentId: "did:key:zLegacy" } }))
    expect(r.did).toBe("did:key:zHome")
  })

  it("returns {} for an undefined meta (no throw)", () => {
    expect(resolveAgentIdentity(undefined)).toEqual({})
  })

  // SECURITY (finding 6, LOW — ties to finding 4): an empty-string did is NOT a did.
  // It must never surface as a matchable identity key, on either the durable
  // identity.did home or the legacy a2a.did hint.
  it("treats an empty-string identity.did as no-did (omits did)", () => {
    const r = resolveAgentIdentity(meta({ identity: { did: "" } }))
    expect(r.did).toBeUndefined()
  })

  it("treats an empty-string identity.did as no-did but keeps other present identity fields", () => {
    const r = resolveAgentIdentity(meta({ identity: { did: "", pinnedKey: "kX", handle: "alice" } }))
    expect(r.did).toBeUndefined()
    expect(r.pinnedKey).toBe("kX")
    expect(r.handle).toBe("alice")
  })

  it("does NOT lift an empty-string legacy a2a.did (treats it as no-did)", () => {
    const r = resolveAgentIdentity(meta({ a2a: { did: "", agentId: "peer-1" } }))
    expect(r).toEqual({})
  })
})

describe("withMigratedIdentity", () => {
  it("backfills identity.did from a2a.did when the durable home is absent", () => {
    const out = withMigratedIdentity(meta({ a2a: { did: "did:key:zB", agentId: "did:key:zB" } }))
    expect(out?.identity?.did).toBe("did:key:zB")
  })

  it("returns the meta unchanged (no clobber) when identity is already present", () => {
    const input = meta({ identity: { did: "did:key:zHome", pinnedKey: "kHome" }, a2a: { did: "did:key:zLegacy", agentId: "did:key:zLegacy" } })
    const out = withMigratedIdentity(input)
    expect(out?.identity).toEqual({ did: "did:key:zHome", pinnedKey: "kHome" })
  })

  it("returns the meta unchanged when there is no a2a.did to backfill from", () => {
    const input = meta({ a2a: { agentId: "peer-1" } })
    const out = withMigratedIdentity(input)
    expect(out?.identity).toBeUndefined()
  })

  it("returns undefined for an undefined meta (no throw)", () => {
    expect(withMigratedIdentity(undefined)).toBeUndefined()
  })

  // finding 6: an empty-string legacy a2a.did is not a real did, so there is nothing
  // to backfill — the meta is returned unchanged (no empty-string identity.did written).
  it("does not backfill from an empty-string a2a.did (returns the meta unchanged)", () => {
    const input = meta({ a2a: { did: "", agentId: "peer-1" } })
    const out = withMigratedIdentity(input)
    expect(out?.identity).toBeUndefined()
  })

  it("emits friends.identity_migrated on a backfill", () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    try {
      withMigratedIdentity(meta({ a2a: { did: "did:key:zB", agentId: "did:key:zB" } }))
      expect(seen.some((e) => e.event === "friends.identity_migrated")).toBe(true)
    } finally {
      setNervesEmitter(null)
    }
  })
})
