// Token accumulation helper.
// Tracks cumulative token usage per friend across turns.
// Called from both CLI and Teams adapters after each agent turn.

import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"

// In the harness, UsageData lives in `mind/context`. It's inlined here (with the
// same field shape) to keep the package self-contained — `accumulateFriendTokens`
// only reads `output_tokens`, but the full shape stays compatible so the harness
// can pass its own UsageData without adaptation.
export interface UsageData {
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  total_tokens: number
}

/** Add a turn's output tokens to the friend's total. Returns whether any were added: false for no output tokens or a
 * missing friend. */
export async function accumulateFriendTokens(
  store: FriendStore,
  friendId: string,
  usage?: UsageData,
): Promise<boolean> {
  if (!usage?.output_tokens) return false

  const record = await store.get(friendId)
  if (!record) return false

  // Only count output tokens (what the model generated for this friend).
  // Input tokens are mostly system prompt re-sent every turn -- counting them
  // would inflate the total and make the onboarding threshold meaningless.
  record.totalTokens = (record.totalTokens ?? 0) + usage.output_tokens
  record.updatedAt = new Date().toISOString()
  await store.put(record.id, record)
  emitNervesEvent({
    component: "friends",
    event: "friends.tokens_accumulated",
    message: "tokens accumulated for friend",
    meta: { friendId, outputTokens: usage.output_tokens },
  })
  return true
}
