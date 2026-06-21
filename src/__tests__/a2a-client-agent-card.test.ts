// friends agent card — the A2A card shape + the `did` overlay binding. The
// friendsKind taxonomy must NOT leak onto the card (metadata-minimization).
import { describe, expect, it } from "vitest"

import { buildFriendsAgentCard } from "../a2a-client/agent-card"

describe("buildFriendsAgentCard", () => {
  it("has the required A2A fields + the did binding", () => {
    const card = buildFriendsAgentCard({
      name: "Agent A",
      url: "https://a.example/a2a",
      version: "0.1.0",
      protocolVersion: "0.3.0",
      did: "did:key:zA",
    })
    expect(card.name).toBe("Agent A")
    expect(card.url).toBe("https://a.example/a2a")
    expect(card.version).toBe("0.1.0")
    expect(card.protocolVersion).toBe("0.3.0")
    expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false })
    expect(card.defaultInputModes).toEqual(["application/json"])
    expect(card.defaultOutputModes).toEqual(["application/json"])
    expect(card.skills.map((s) => s.id)).toEqual(["friends-exchange"])
    expect(card.securitySchemes).toEqual({})
    expect(card.security).toEqual([])
    expect(card.did).toBe("did:key:zA")
  })

  it("advertises the relay handle when supplied, omits it otherwise", () => {
    const withRelay = buildFriendsAgentCard({ name: "A", url: "u", version: "0.1.0", protocolVersion: "0.3.0", did: "did:key:zA", relayHandle: "opaque-123" })
    expect(withRelay.ouroRelay).toEqual({ handle: "opaque-123" })

    const noRelay = buildFriendsAgentCard({ name: "A", url: "u", version: "0.1.0", protocolVersion: "0.3.0", did: "did:key:zA" })
    expect(noRelay.ouroRelay).toBeUndefined()
    expect("ouroRelay" in noRelay).toBe(false)
  })

  it("uses the provided description, else a generic default", () => {
    const custom = buildFriendsAgentCard({ name: "A", url: "u", version: "0.1.0", protocolVersion: "0.3.0", did: "d", description: "my agent" })
    expect(custom.description).toBe("my agent")
    const def = buildFriendsAgentCard({ name: "A", url: "u", version: "0.1.0", protocolVersion: "0.3.0", did: "d" })
    expect(def.description).toContain("friends")
  })

  it("does NOT surface the friendsKind taxonomy anywhere on the card", () => {
    const card = buildFriendsAgentCard({ name: "A", url: "u", version: "0.1.0", protocolVersion: "0.3.0", did: "d", relayHandle: "h" })
    const json = JSON.stringify(card)
    expect(json).not.toContain("profile_share")
    expect(json).not.toContain("mission_share")
    expect(json).not.toContain("coordination")
    expect(json).not.toContain("friendsKind")
  })
})
