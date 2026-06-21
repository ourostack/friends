// JCS — JSON Canonicalization Scheme (RFC 8785), hand-rolled.
//
// Why hand-rolled (not a dep): the obvious dep `canonicalize` is ESM-only, and
// friends compiles to CommonJS with JCS called SYNCHRONOUSLY on the crypto hot
// path (both Ed25519 signing AND the AEAD associated-data construction). A
// dynamic `import()` (the only way CJS reaches ESM-only) would force seal/sign
// async — unacceptable. Hand-rolling keeps JCS sync and the only new runtime dep
// `libsodium-wrappers`. The RFC 8785 number-serialization edge cases are
// exhaustively unit-tested (see a2a-client-jcs.test.ts).
//
// The canonical form (RFC 8785):
//   • object keys sorted by UTF-16 code-unit order, recursively;
//   • no insignificant whitespace;
//   • arrays preserve element order;
//   • strings serialized with JSON string escaping (which IS RFC 8785's);
//   • numbers serialized per RFC 8785 §3.2.2 — ECMAScript `Number.prototype
//     .toString` for finite values (integers carry no fractional part), with
//     `-0` normalized to `0`; NaN / Infinity are rejected;
//   • `null` → "null"; booleans literal.
// Our envelopes carry only strings, ISO-date strings, small integers (v:1,
// counts) and nested objects/arrays — no floats on the wire — but the number
// path is tested anyway. `undefined` / functions / symbols are NOT valid JSON
// values and are rejected loudly rather than silently dropped.

/** Serialize a number per RFC 8785 §3.2.2. Rejects non-finite values. */
function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`JCS: non-finite number cannot be canonicalized: ${String(n)}`)
  }
  // ECMAScript Number.prototype.toString is the RFC 8785 number production for
  // finite values; it already emits integers without a fractional part and uses
  // the shortest round-tripping form. Normalize negative zero to "0" (RFC 8785
  // serializes -0 as 0).
  if (Object.is(n, -0)) return "0"
  return n.toString()
}

/** Canonicalize a single value into its JCS string fragment. */
function canonicalize(value: unknown): string {
  if (value === null) return "null"

  const t = typeof value
  if (t === "string") return JSON.stringify(value)
  if (t === "boolean") return value ? "true" : "false"
  if (t === "number") return serializeNumber(value as number)
  if (t === "bigint") {
    throw new Error("JCS: bigint cannot be canonicalized (not a JSON number)")
  }
  if (t === "undefined" || t === "function" || t === "symbol") {
    throw new Error(`JCS: ${t} is not a valid JSON value`)
  }

  if (Array.isArray(value)) {
    return `[${value.map((el) => canonicalize(el)).join(",")}]`
  }

  // Plain object: sort keys by UTF-16 code-unit order (the default `<` on JS
  // strings), recurse. Keys whose value is `undefined` are omitted (matching
  // JSON.stringify), but a value that is a function/symbol is omitted too — to
  // stay strict we DROP only `undefined` (JSON-absent) and reject the rest.
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const key of keys) {
    const v = obj[key]
    if (v === undefined) continue // JSON omits undefined-valued keys
    parts.push(`${JSON.stringify(key)}:${canonicalize(v)}`)
  }
  return `{${parts.join(",")}}`
}

/** The JCS canonical JSON string for `value` (RFC 8785). */
export function jcsString(value: unknown): string {
  return canonicalize(value)
}

/** The UTF-8 bytes of the JCS canonical JSON string — the message fed to
 * Ed25519 signing and used as AEAD associated-data. */
export function jcsBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(jcsString(value))
}
