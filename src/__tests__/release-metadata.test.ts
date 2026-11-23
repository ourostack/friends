import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const expectedVersion = "0.1.0-alpha.28"
const expectedChanges = [
  "Missions say what they saved. record_mission answers invalid, and saves nothing, for an empty missionKey, a status other than active, succeeded, partial, failed or abandoned, or participants, learnings or outcomes that aren't a list of the shape each takes (a learning key of __proto__ included); a bogus status used to be reported as given but saved as active, and learnings that weren't JSON were dropped while the call answered ok. Participants with no agentId are told apart by agentName, so two of them are both kept. import_result answers noop, keeping the first, when a result for that request from that agent was already imported, where it used to answer imported. It lands a result under the requestId it correlated on, answers no_delegation for a requestId like constructor, and answers invalid for an envelope without subject.missionKey, a requestId, or a result with a summary whose requestId, if any, is the same. import_mission answers invalid for an envelope with no mission subject, or with learnings or outcomes it can't read, and import_coordination for one with no mission subject, an unknown intent or a task without a requestId, instead of failing. record_mission and import_result now have Ouro AX cards."
]

describe("release metadata", () => {
  it("names one exact unused immutable prerelease and its changes", () => {
    const packageJson = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { version: string }
    const packageLock = JSON.parse(readFileSync(`${root}/package-lock.json`, "utf8")) as {
      version: string
      packages: Record<string, { version?: string }>
    }
    const changelog = JSON.parse(readFileSync(`${root}/changelog.json`, "utf8")) as {
      versions: Array<{ version: string; changes: string[] }>
    }

    expect(packageJson.version).toBe(expectedVersion)
    expect(packageLock.version).toBe(expectedVersion)
    expect(packageLock.packages[""].version).toBe(expectedVersion)
    expect(changelog.versions[0]).toEqual({
      version: expectedVersion,
      changes: expectedChanges,
    })
  })
})
