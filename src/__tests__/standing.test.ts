import { describe, it, expect, afterEach } from "vitest"

import {
  assessStanding,
  explainStanding,
  DEFAULT_STANDING_RULE,
  setNervesEmitter,
} from "../index"
import type { FriendRecord, NervesEvent, RelationshipOutcome, StandingRule } from "../index"

const NOW = new Date("2026-01-01T00:00:00.000Z")

/** A friend factory, extended (vs trust-explanation's) to carry an agent-peer
 * `agentMeta` with outcomes — the input `assessStanding` reads. Pass
 * `outcomes` / `familiarity` to shape the assessment. Omit `agentMeta` entirely
 * by passing `agentMeta: undefined` in overrides. */
function agentFriend(
  opts: { outcomes?: RelationshipOutcome[]; familiarity?: number; bundleName?: string } = {},
  overrides: Partial<FriendRecord> = {},
): FriendRecord {
  const base: FriendRecord = {
    id: "peer-1",
    name: "PeerBot",
    trustLevel: "acquaintance",
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    kind: "agent",
    agentMeta: {
      bundleName: opts.bundleName ?? "peerbot",
      familiarity: opts.familiarity ?? 0,
      sharedMissions: [],
      outcomes: opts.outcomes ?? [],
    },
  }
  return { ...base, ...overrides }
}

/** A first-party outcome (no provenance ⇒ first-party). */
function out(result: RelationshipOutcome["result"], missionId = "m"): RelationshipOutcome {
  return { missionId, result, timestamp: "2026-01-01T00:00:00.000Z" }
}

describe("assessStanding — tiers", () => {
  it("untested when the record has no agentMeta at all", () => {
    const s = assessStanding(agentFriend({}, { agentMeta: undefined }), NOW)
    expect(s.tier).toBe("untested")
    expect(s.basisCount).toBe(0)
    expect(s.familiarity).toBe(0)
    expect(s.tally).toEqual({ success: 0, partial: 0, failed: 0 })
  })

  it("untested when agentMeta is present but has no outcomes", () => {
    const s = assessStanding(agentFriend({ outcomes: [] }), NOW)
    expect(s.tier).toBe("untested")
    expect(s.basisCount).toBe(0)
  })

  it("reliable on a single clean success", () => {
    const s = assessStanding(agentFriend({ outcomes: [out("success")] }), NOW)
    expect(s.tier).toBe("reliable")
    expect(s.basisCount).toBe(1)
    expect(s.tally.success).toBe(1)
  })

  it("proven on >=3 clean successes with familiarity >= threshold", () => {
    const s = assessStanding(
      agentFriend({ outcomes: [out("success", "m1"), out("success", "m2"), out("success", "m3")], familiarity: 3 }),
      NOW,
    )
    expect(s.tier).toBe("proven")
    expect(s.basisCount).toBe(3)
    expect(s.familiarity).toBe(3)
  })

  it("falls back to reliable when the proven success floor is met but familiarity is below threshold", () => {
    // 3 clean successes but familiarity < THRESHOLD: the proven gate fails on
    // familiarity, and the next ladder rung (>=1 clean win) catches it as
    // reliable — clean wins, just not enough lived history for proven.
    const s = assessStanding(
      agentFriend({ outcomes: [out("success", "m1"), out("success", "m2"), out("success", "m3")], familiarity: 2 }),
      NOW,
    )
    expect(s.tier).toBe("reliable")
    expect(s.basisCount).toBe(3)
  })

  it("mixed on partial-only history (no successes, no failures)", () => {
    const s = assessStanding(agentFriend({ outcomes: [out("partial", "m1"), out("partial", "m2")] }), NOW)
    expect(s.tier).toBe("mixed")
    expect(s.tally.partial).toBe(2)
  })

  it("mixed when there are successes but a non-dominant failure (failed not > success, failed !== 0)", () => {
    const s = assessStanding(agentFriend({ outcomes: [out("success", "m1"), out("success", "m2"), out("failed", "m3")] }), NOW)
    expect(s.tier).toBe("mixed")
    expect(s.tally).toEqual({ success: 2, partial: 0, failed: 1 })
  })

  it("troubled when failures outnumber successes", () => {
    const s = assessStanding(agentFriend({ outcomes: [out("success", "m1"), out("failed", "m2"), out("failed", "m3")] }), NOW)
    expect(s.tier).toBe("troubled")
    expect(s.basisCount).toBe(3)
    expect(s.tally.failed).toBe(2)
  })
})

describe("assessStanding — firewall 1: first-party only", () => {
  it("excludes imported outcomes from the tally and basis count", () => {
    const outcomes: RelationshipOutcome[] = [
      { missionId: "fp1", result: "success", timestamp: "2026-01-01T00:00:00.000Z", provenance: { origin: "first_party" } },
      { missionId: "fp2", result: "success", timestamp: "2026-01-01T00:00:00.000Z" }, // no provenance ⇒ first-party
      { missionId: "imp", result: "success", timestamp: "2026-01-01T00:00:00.000Z", provenance: { origin: "imported", assertedBy: { agentId: "agent-x" } } },
    ]
    const s = assessStanding(agentFriend({ outcomes }), NOW)
    // Only the 2 first-party successes count — the imported success is excluded.
    expect(s.basisCount).toBe(2)
    expect(s.tally.success).toBe(2)
    expect(s.tier).toBe("reliable")
  })

  it("an all-imported history reads as untested (nothing first-party)", () => {
    const outcomes: RelationshipOutcome[] = [
      { missionId: "imp1", result: "success", timestamp: "2026-01-01T00:00:00.000Z", provenance: { origin: "imported" } },
      { missionId: "imp2", result: "success", timestamp: "2026-01-01T00:00:00.000Z", provenance: { origin: "imported" } },
    ]
    const s = assessStanding(agentFriend({ outcomes }), NOW)
    expect(s.tier).toBe("untested")
    expect(s.basisCount).toBe(0)
  })
})

describe("assessStanding — familiarity, time, and the rule seam", () => {
  it("reads familiarity through from agentMeta", () => {
    const s = assessStanding(agentFriend({ outcomes: [out("success")], familiarity: 7 }), NOW)
    expect(s.familiarity).toBe(7)
  })

  it("honors an explicit `now` for assessedAt", () => {
    const s = assessStanding(agentFriend({ outcomes: [out("success")] }), NOW)
    expect(s.assessedAt).toBe(NOW.toISOString())
  })

  it("defaults assessedAt to a valid ISO timestamp when no `now` is given", () => {
    const s = assessStanding(agentFriend({ outcomes: [out("success")] }))
    expect(Number.isNaN(Date.parse(s.assessedAt))).toBe(false)
  })

  it("uses an injected StandingRule over the default (rule-injection seam)", () => {
    const alwaysProven: StandingRule = { name: "always_proven", tier: () => "proven" }
    // An empty record would be untested under the default; the injected rule wins.
    const s = assessStanding(agentFriend({ outcomes: [] }), NOW, alwaysProven)
    expect(s.tier).toBe("proven")
  })

  it("DEFAULT_STANDING_RULE is the count_based ladder", () => {
    expect(DEFAULT_STANDING_RULE.name).toBe("count_based")
    expect(DEFAULT_STANDING_RULE.tier({ tally: { success: 0, partial: 0, failed: 0 }, basisCount: 0, familiarity: 0 })).toBe("untested")
  })
})

describe("explainStanding", () => {
  const GUARDRAIL = (a: string) => a.includes("does not change") && a.includes("trust level")

  it("mirrors assessStanding and always carries the trust guardrail in advisory", () => {
    const rec = agentFriend({ outcomes: [out("success", "m1"), out("success", "m2"), out("success", "m3")], familiarity: 3 })
    const e = explainStanding(rec, NOW)
    expect(e.standing).toEqual(assessStanding(rec, NOW))
    expect(e.standing.tier).toBe("proven")
    expect(typeof e.summary).toBe("string")
    expect(e.summary.length).toBeGreaterThan(0)
    expect(typeof e.why).toBe("string")
    expect(e.why.length).toBeGreaterThan(0)
    expect(Array.isArray(e.advisory)).toBe(true)
    expect(e.advisory.length).toBeGreaterThan(0)
    expect(e.advisory.some(GUARDRAIL)).toBe(true)
  })

  it("explains an untested peer with the guardrail", () => {
    const e = explainStanding(agentFriend({}, { agentMeta: undefined }), NOW)
    expect(e.standing.tier).toBe("untested")
    expect(e.summary.length).toBeGreaterThan(0)
    expect(e.advisory.some(GUARDRAIL)).toBe(true)
  })

  it("explains a troubled peer with the guardrail", () => {
    const e = explainStanding(agentFriend({ outcomes: [out("success", "m1"), out("failed", "m2"), out("failed", "m3")] }), NOW)
    expect(e.standing.tier).toBe("troubled")
    expect(e.summary.length).toBeGreaterThan(0)
    expect(e.advisory.some(GUARDRAIL)).toBe(true)
  })

  it("explains a reliable peer with the guardrail", () => {
    const e = explainStanding(agentFriend({ outcomes: [out("success")] }), NOW)
    expect(e.standing.tier).toBe("reliable")
    expect(e.advisory.some(GUARDRAIL)).toBe(true)
  })

  it("explains a mixed peer with the guardrail", () => {
    const e = explainStanding(agentFriend({ outcomes: [out("partial", "m1"), out("partial", "m2")] }), NOW)
    expect(e.standing.tier).toBe("mixed")
    expect(e.advisory.some(GUARDRAIL)).toBe(true)
  })

  it("honors an injected rule", () => {
    const alwaysTroubled: StandingRule = { name: "always_troubled", tier: () => "troubled" }
    const e = explainStanding(agentFriend({ outcomes: [out("success")] }), NOW, alwaysTroubled)
    expect(e.standing.tier).toBe("troubled")
    expect(e.advisory.some(GUARDRAIL)).toBe(true)
  })
})

describe("assessStanding — observability", () => {
  afterEach(() => setNervesEmitter(null))

  it("emits friends.standing_assessed with tier + basisCount", () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    assessStanding(agentFriend({ outcomes: [out("success")] }), NOW)
    const event = seen.find((e) => e.event === "friends.standing_assessed")
    expect(event).toBeDefined()
    expect(event?.component).toBe("friends")
    expect(event?.meta).toMatchObject({ tier: "reliable", basisCount: 1 })
  })
})
