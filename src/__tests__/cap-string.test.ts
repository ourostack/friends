import { describe, it, expect } from "vitest"

import {
  capStructuredRecordString,
  truncateLargeEventContent,
  EVENT_CONTENT_MAX_CHARS,
} from "../util/cap-string"

describe("capStructuredRecordString", () => {
  it("returns short strings unchanged", () => {
    expect(capStructuredRecordString("hello")).toBe("hello")
  })

  it("truncates strings longer than the cap and inserts the marker", () => {
    const long = "a".repeat(EVENT_CONTENT_MAX_CHARS + 1000)
    const out = capStructuredRecordString(long)
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain("[truncated")
  })
})

describe("truncateLargeEventContent", () => {
  it("reports no truncation for content at or below the budget", () => {
    const r = truncateLargeEventContent("abc", 10)
    expect(r).toEqual({ content: "abc", truncated: false, originalLength: 3 })
  })

  it("keeps a head and tail around the marker when the budget allows a tail", () => {
    const content = "H".repeat(50) + "T".repeat(50)
    const r = truncateLargeEventContent(content, 80)
    expect(r.truncated).toBe(true)
    expect(r.originalLength).toBe(100)
    expect(String(r.content)).toContain("[truncated")
    // Tail budget > 0 → the trailing slice is present.
    expect(String(r.content).endsWith("T")).toBe(true)
  })

  it("emits head-only when the marker consumes the entire budget (tail = 0)", () => {
    const content = "x".repeat(500)
    // maxChars smaller than the marker itself → remainingBudget 0 → tailLength 0.
    const r = truncateLargeEventContent(content, 10)
    expect(r.truncated).toBe(true)
    expect(String(r.content)).toContain("[truncated")
    // No trailing original content appended.
    expect(String(r.content).endsWith("x")).toBe(false)
  })
})
