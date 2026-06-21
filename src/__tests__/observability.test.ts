import { describe, it, expect, afterEach } from "vitest"

import {
  emitNervesEvent,
  setNervesEmitter,
  describeTrustContext,
} from "../index"
import type { NervesEvent, FriendRecord } from "../index"

function friend(trustLevel: FriendRecord["trustLevel"]): FriendRecord {
  return {
    id: "f-1",
    name: "Person",
    trustLevel,
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
  }
}

describe("observability seam", () => {
  afterEach(() => setNervesEmitter(null))

  it("emitNervesEvent is a no-op by default (does not throw)", () => {
    setNervesEmitter(null)
    expect(() =>
      emitNervesEvent({ component: "friends", event: "test.event", message: "hi" }),
    ).not.toThrow()
  })

  it("forwards events to an injected emitter", () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    emitNervesEvent({ component: "friends", event: "test.event", message: "hi", meta: { a: 1 } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ component: "friends", event: "test.event", message: "hi", meta: { a: 1 } })
  })

  it("real friend operations report through the injected emitter", () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    describeTrustContext({ friend: friend("family"), channel: "cli" })
    expect(seen.some((e) => e.event === "friends.trust_explained")).toBe(true)
  })

  it("setNervesEmitter(null) resets back to the no-op", () => {
    const seen: NervesEvent[] = []
    setNervesEmitter((e) => seen.push(e))
    setNervesEmitter(null)
    emitNervesEvent({ component: "friends", event: "after.reset", message: "x" })
    expect(seen).toHaveLength(0)
  })
})
