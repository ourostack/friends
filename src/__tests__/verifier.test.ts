import { describe, it, expect } from "vitest"

import { tofuVerifier, DEFAULT_AGENT_VERIFIER } from "../index"
import type { AgentVerifier } from "../index"

describe("tofuVerifier", () => {
  it("accepts any agent and ignores the proof slot", () => {
    expect(tofuVerifier.verify("agent-1")).toBe(true)
    expect(tofuVerifier.verify("agent-2", "some-proof")).toBe(true)
    expect(tofuVerifier.verify("agent-3", undefined)).toBe(true)
  })

  it("is the default agent verifier", () => {
    expect(DEFAULT_AGENT_VERIFIER).toBe(tofuVerifier)
  })

  it("the AgentVerifier interface is implementable with a stricter check", () => {
    const strict: AgentVerifier = {
      verify: (_id, proof) => proof === "valid",
    }
    expect(strict.verify("a", "valid")).toBe(true)
    expect(strict.verify("a", "nope")).toBe(false)
    expect(strict.verify("a")).toBe(false)
  })
})
