// reachability ladder — all 4 rungs, deterministic.
import { describe, expect, it } from "vitest"

import { resolveReachability } from "../a2a-client/reachability"

describe("resolveReachability", () => {
  it("endpointUrl present → direct", () => {
    expect(resolveReachability({ endpointUrl: "https://ep" }, undefined)).toEqual({ rung: "direct", endpointUrl: "https://ep" })
  })

  it("no endpoint, relay present → relay", () => {
    expect(resolveReachability({ relay: { url: "https://r", handle: "h" } }, undefined)).toEqual({
      rung: "relay",
      relay: { url: "https://r", handle: "h" },
    })
  })

  it("no endpoint/relay, mailbox present → mailbox (the demoted fallback)", () => {
    expect(resolveReachability({ agentId: "a" }, { repo: "/m", selfOutboxAgentId: "out" })).toEqual({
      rung: "mailbox",
      mailbox: { repo: "/m", selfOutboxAgentId: "out" },
    })
  })

  it("nothing → unreachable", () => {
    expect(resolveReachability(undefined, undefined)).toEqual({ rung: "unreachable" })
    expect(resolveReachability({ agentId: "a" }, undefined)).toEqual({ rung: "unreachable" })
  })

  it("direct WINS over relay and mailbox (precedence)", () => {
    expect(
      resolveReachability({ endpointUrl: "https://ep", relay: { url: "r", handle: "h" } }, { repo: "/m", selfOutboxAgentId: "o" }),
    ).toEqual({ rung: "direct", endpointUrl: "https://ep" })
  })

  it("relay WINS over mailbox when no endpoint", () => {
    expect(resolveReachability({ relay: { url: "r", handle: "h" } }, { repo: "/m", selfOutboxAgentId: "o" })).toEqual({
      rung: "relay",
      relay: { url: "r", handle: "h" },
    })
  })
})
