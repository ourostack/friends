// JCS (RFC 8785) — hand-rolled canonicalization. The number-serialization edge
// cases are tested EXHAUSTIVELY per the grounding mandate (a hand-rolled JCS must
// prove §3.2.2). Ordering, whitespace, escaping, nesting, and the reject paths are
// all pinned.
import { describe, expect, it } from "vitest"

import { jcsBytes, jcsString } from "../a2a-client/jcs"

describe("jcsString — structure (RFC 8785)", () => {
  it("sorts object keys by UTF-16 code-unit order, recursively", () => {
    // Deliberately-unsorted, nested input.
    const input = { b: { d: 4, c: 3 }, a: 1 }
    expect(jcsString(input)).toBe('{"a":1,"b":{"c":3,"d":4}}')
  })

  it("matches the RFC-8785-style ordering example {a:1,b:[2,3]}", () => {
    expect(jcsString({ b: [2, 3], a: 1 })).toBe('{"a":1,"b":[2,3]}')
  })

  it("emits no insignificant whitespace", () => {
    const s = jcsString({ x: 1, y: "z", arr: [1, 2] })
    expect(s).not.toMatch(/\s/)
    expect(s).toBe('{"arr":[1,2],"x":1,"y":"z"}')
  })

  it("preserves array element order (arrays are NOT sorted)", () => {
    expect(jcsString([3, 1, 2])).toBe("[3,1,2]")
    expect(jcsString(["b", "a", "c"])).toBe('["b","a","c"]')
  })

  it("escapes strings using JSON string escaping (RFC 8785 string rules == JSON)", () => {
    expect(jcsString('quote " and \\ backslash')).toBe('"quote \\" and \\\\ backslash"')
    expect(jcsString("tab\tnewline\n")).toBe('"tab\\tnewline\\n"')
    // A non-ASCII codepoint is preserved (JSON.stringify keeps it literal).
    expect(jcsString("café")).toBe('"café"')
  })

  it("serializes booleans and null literally", () => {
    expect(jcsString(true)).toBe("true")
    expect(jcsString(false)).toBe("false")
    expect(jcsString(null)).toBe("null")
  })

  it("omits undefined-valued object keys (JSON-absent) without throwing", () => {
    expect(jcsString({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}')
  })

  it("UTF-16 ordering: keys with shared prefixes sort by code unit", () => {
    // "a" < "aa" < "b"; also a capital sorts before a lowercase (code units).
    expect(jcsString({ b: 1, aa: 1, a: 1, B: 1 })).toBe('{"B":1,"a":1,"aa":1,"b":1}')
  })

  it("canonicalizes a nested envelope-shaped value end to end", () => {
    const env = {
      v: 1,
      recipientDid: "did:key:zABC",
      counts: [1, 2, 3],
      meta: { issuedAt: "2026-01-01T00:00:00.000Z", from: "agent-a" },
    }
    expect(jcsString(env)).toBe(
      '{"counts":[1,2,3],"meta":{"from":"agent-a","issuedAt":"2026-01-01T00:00:00.000Z"},"recipientDid":"did:key:zABC","v":1}',
    )
  })
})

describe("jcsString — number serialization (RFC 8785 §3.2.2, exhaustive)", () => {
  it("serializes zero and negative zero both as 0", () => {
    expect(jcsString(0)).toBe("0")
    expect(jcsString(-0)).toBe("0")
  })

  it("serializes integers without a fractional part", () => {
    expect(jcsString(1)).toBe("1")
    expect(jcsString(1000000)).toBe("1000000")
    expect(jcsString(-42)).toBe("-42")
  })

  it("serializes finite non-integers via ECMAScript Number.prototype.toString", () => {
    expect(jcsString(1.5)).toBe("1.5")
    expect(jcsString(-0.25)).toBe("-0.25")
  })

  it("serializes a value needing exponent form consistently with Number.prototype.toString", () => {
    expect(jcsString(1e21)).toBe((1e21).toString())
    expect(jcsString(5e-7)).toBe((5e-7).toString())
  })

  it("THROWS on NaN", () => {
    expect(() => jcsString(NaN)).toThrow(/non-finite/)
  })

  it("THROWS on Infinity and -Infinity", () => {
    expect(() => jcsString(Infinity)).toThrow(/non-finite/)
    expect(() => jcsString(-Infinity)).toThrow(/non-finite/)
  })
})

describe("jcsString — invalid JSON values are rejected", () => {
  it("THROWS on a top-level undefined", () => {
    expect(() => jcsString(undefined)).toThrow(/undefined/)
  })

  it("THROWS on a function value", () => {
    expect(() => jcsString(() => 1)).toThrow(/function/)
  })

  it("THROWS on a symbol value", () => {
    expect(() => jcsString(Symbol("x"))).toThrow(/symbol/)
  })

  it("THROWS on a bigint value", () => {
    expect(() => jcsString(10n)).toThrow(/bigint/)
  })

  it("THROWS on a nested non-finite number", () => {
    expect(() => jcsString({ a: { b: Infinity } })).toThrow(/non-finite/)
  })
})

describe("jcsBytes", () => {
  it("returns the UTF-8 bytes of jcsString", () => {
    const value = { a: 1, b: "café" }
    const bytes = jcsBytes(value)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(bytes)).toBe(jcsString(value))
    // "café" → the é is 2 UTF-8 bytes, so the byte length exceeds the char count.
    expect(bytes.length).toBe(Buffer.byteLength(jcsString(value), "utf-8"))
  })
})
