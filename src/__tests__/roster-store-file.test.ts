import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import * as fsPromises from "fs/promises"

import { FileRosterStore, rostersDirFor, MemoryRosterStore } from "../index"
import type { AccountRoster, RosterPin } from "../index"

const NOW = "2026-03-14T18:00:00.000Z"

function roster(overrides: Partial<AccountRoster> = {}): AccountRoster {
  return {
    accountId: "acct-1",
    members: [{ handle: "alice", did: "did:key:zA" }],
    epoch: 1,
    sig: "c2ln",
    ...overrides,
  }
}

function pin(overrides: Partial<RosterPin> = {}): RosterPin {
  return {
    accountId: "acct-1",
    rosterKey: "a2V5",
    pinnedAt: NOW,
    ...overrides,
  }
}

describe("rostersDirFor", () => {
  it("returns the sibling _rosters dir under the friends dir", () => {
    expect(rostersDirFor("/bundle/friends")).toBe(join("/bundle/friends", "_rosters"))
  })
})

describe("FileRosterStore", () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("mkdirs the rosters dir on construction", () => {
    dir = mkdtempSync(join(tmpdir(), "friends-rosters-"))
    const rostersPath = rostersDirFor(dir)
    new FileRosterStore(rostersPath)
    expect(existsSync(rostersPath)).toBe(true)
  })

  it("putRoster then getRoster round-trips a roster", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-rosters-"))
    const store = new FileRosterStore(rostersDirFor(dir))
    await store.putRoster(roster({ epoch: 7, members: [{ handle: "bob", did: "did:key:zB" }] }))
    const loaded = await store.getRoster("acct-1")
    expect(loaded?.accountId).toBe("acct-1")
    expect(loaded?.epoch).toBe(7)
    expect(loaded?.members).toEqual([{ handle: "bob", did: "did:key:zB" }])
  })

  it("getRoster returns null for a missing accountId", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-rosters-"))
    const store = new FileRosterStore(rostersDirFor(dir))
    expect(await store.getRoster("nope")).toBeNull()
  })

  it("putPin then getPin round-trips a pin", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-rosters-"))
    const store = new FileRosterStore(rostersDirFor(dir))
    await store.putPin(pin({ rosterKey: "S0VZMg==" }))
    const loaded = await store.getPin("acct-1")
    expect(loaded?.accountId).toBe("acct-1")
    expect(loaded?.rosterKey).toBe("S0VZMg==")
    expect(loaded?.pinnedAt).toBe(NOW)
  })

  it("getPin returns null for a missing accountId", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-rosters-"))
    const store = new FileRosterStore(rostersDirFor(dir))
    expect(await store.getPin("nope")).toBeNull()
  })

  it("getRoster returns null on malformed JSON on disk (guarded read)", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-rosters-"))
    const rostersPath = rostersDirFor(dir)
    new FileRosterStore(rostersPath)
    await fsPromises.writeFile(join(rostersPath, "broken.roster.json"), "{not json", "utf-8")
    const store = new FileRosterStore(rostersPath)
    expect(await store.getRoster("broken")).toBeNull()
  })

  it("getPin returns null on a JSON value that is not an object (guarded read)", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-rosters-"))
    const rostersPath = rostersDirFor(dir)
    new FileRosterStore(rostersPath)
    await fsPromises.writeFile(join(rostersPath, "arr.pin.json"), "[1,2,3]", "utf-8")
    const store = new FileRosterStore(rostersPath)
    expect(await store.getPin("arr")).toBeNull()
  })

  it("keeps roster and pin in separate files for the same account", async () => {
    dir = mkdtempSync(join(tmpdir(), "friends-rosters-"))
    const rostersPath = rostersDirFor(dir)
    const store = new FileRosterStore(rostersPath)
    await store.putRoster(roster())
    await store.putPin(pin())
    expect(existsSync(join(rostersPath, "acct-1.roster.json"))).toBe(true)
    expect(existsSync(join(rostersPath, "acct-1.pin.json"))).toBe(true)
  })
})

describe("MemoryRosterStore", () => {
  it("round-trips a roster and returns null for a missing accountId", async () => {
    const store = new MemoryRosterStore()
    expect(await store.getRoster("acct-1")).toBeNull()
    await store.putRoster(roster({ epoch: 9 }))
    expect((await store.getRoster("acct-1"))?.epoch).toBe(9)
    expect(await store.getRoster("nope")).toBeNull()
  })

  it("round-trips a pin and returns null for a missing accountId", async () => {
    const store = new MemoryRosterStore()
    expect(await store.getPin("acct-1")).toBeNull()
    await store.putPin(pin({ rosterKey: "mem-key" }))
    expect((await store.getPin("acct-1"))?.rosterKey).toBe("mem-key")
    expect(await store.getPin("nope")).toBeNull()
  })
})
