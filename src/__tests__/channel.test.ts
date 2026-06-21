import { describe, it, expect } from "vitest"

import {
  getChannelCapabilities,
  channelToFacing,
  isRemoteChannel,
  getAlwaysOnSenseNames,
} from "../index"

describe("getChannelCapabilities", () => {
  it("returns CLI capabilities (local, streaming, no markdown)", () => {
    const c = getChannelCapabilities("cli")
    expect(c.channel).toBe("cli")
    expect(c.senseType).toBe("local")
    expect(c.supportsStreaming).toBe(true)
    expect(c.supportsMarkdown).toBe(false)
    expect(c.availableIntegrations).toEqual([])
  })

  it("returns Teams capabilities (closed, integrations, rich cards)", () => {
    const c = getChannelCapabilities("teams")
    expect(c.senseType).toBe("closed")
    expect(c.availableIntegrations).toEqual(["ado", "graph", "github"])
    expect(c.supportsMarkdown).toBe(true)
    expect(c.supportsRichCards).toBe(true)
  })

  it("returns BlueBubbles capabilities (open, no formatting)", () => {
    const c = getChannelCapabilities("bluebubbles")
    expect(c.senseType).toBe("open")
    expect(c.supportsMarkdown).toBe(false)
    expect(c.supportsStreaming).toBe(false)
  })

  it("returns mail capabilities (open)", () => {
    expect(getChannelCapabilities("mail").senseType).toBe("open")
  })

  it("returns voice capabilities (local, streaming)", () => {
    const c = getChannelCapabilities("voice")
    expect(c.senseType).toBe("local")
    expect(c.supportsStreaming).toBe(true)
  })

  it("returns a2a capabilities (open, markdown)", () => {
    const c = getChannelCapabilities("a2a")
    expect(c.senseType).toBe("open")
    expect(c.supportsMarkdown).toBe(true)
  })

  it("returns inner capabilities (internal)", () => {
    expect(getChannelCapabilities("inner").senseType).toBe("internal")
  })

  it("returns mcp capabilities (local, markdown)", () => {
    const c = getChannelCapabilities("mcp")
    expect(c.senseType).toBe("local")
    expect(c.supportsMarkdown).toBe(true)
  })

  it("returns default (cli-shaped, local) capabilities for an unknown channel", () => {
    const c = getChannelCapabilities("nope")
    expect(c.senseType).toBe("local")
    expect(c.availableIntegrations).toEqual([])
    expect(c.supportsStreaming).toBe(false)
  })
})

describe("channelToFacing", () => {
  it("maps agent-facing channels to 'agent'", () => {
    expect(channelToFacing("inner")).toBe("agent")
    expect(channelToFacing("mcp")).toBe("agent")
    expect(channelToFacing("a2a")).toBe("agent")
  })
  it("maps human-facing channels to 'human'", () => {
    expect(channelToFacing("cli")).toBe("human")
    expect(channelToFacing("teams")).toBe("human")
  })
  it("treats undefined as human-facing", () => {
    expect(channelToFacing(undefined)).toBe("human")
  })
})

describe("isRemoteChannel", () => {
  it("is true for open and closed sense types", () => {
    expect(isRemoteChannel(getChannelCapabilities("teams"))).toBe(true)
    expect(isRemoteChannel(getChannelCapabilities("bluebubbles"))).toBe(true)
  })
  it("is false for local and internal sense types", () => {
    expect(isRemoteChannel(getChannelCapabilities("cli"))).toBe(false)
    expect(isRemoteChannel(getChannelCapabilities("inner"))).toBe(false)
  })
  it("is false when capabilities are undefined", () => {
    expect(isRemoteChannel(undefined)).toBe(false)
  })
})

describe("getAlwaysOnSenseNames", () => {
  it("returns only open/closed channels", () => {
    const names = getAlwaysOnSenseNames().sort()
    expect(names).toEqual(["a2a", "bluebubbles", "mail", "teams"])
  })
})
