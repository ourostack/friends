// String-capping helper, copied verbatim from the harness's
// `heart/session-events.ts` (`capStructuredRecordString` +
// `truncateLargeEventContent` + `EVENT_CONTENT_MAX_CHARS`).
//
// Used by FileFriendStore to bound the size of free-text note values before they
// are written to disk, so a single runaway note can't bloat a friend record.

export const EVENT_CONTENT_MAX_CHARS = 256 * 1024

export function truncateLargeEventContent(
  content: unknown,
  maxChars: number,
): { content: unknown; truncated: boolean; originalLength: number } {
  /* v8 ignore next 3 -- copied verbatim from the harness; the non-string guard is
     unreachable through this package's API (note values are typed `string`) but is
     kept so the harness can drop in its real emitter without behavior drift @preserve */
  if (typeof content !== "string") {
    return { content, truncated: false, originalLength: 0 }
  }
  if (content.length <= maxChars) {
    return { content, truncated: false, originalLength: content.length }
  }
  const marker = `[truncated — event content exceeded ${maxChars} chars; original length ${content.length} chars]`
  const remainingBudget = Math.max(0, maxChars - marker.length)
  const headLength = Math.ceil(remainingBudget * 0.75)
  const tailLength = Math.max(0, remainingBudget - headLength)
  return {
    content: `${content.slice(0, headLength)}${marker}${tailLength > 0 ? content.slice(-tailLength) : ""}`,
    truncated: true,
    originalLength: content.length,
  }
}

export function capStructuredRecordString(value: string): string {
  return truncateLargeEventContent(value, EVENT_CONTENT_MAX_CHARS).content as string
}
