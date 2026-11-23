import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const expectedVersion = "0.1.0-alpha.26"
const expectedChanges = [
  "set_trust, onboard_agent and connect_to save the trust level they report. A level other than family, friend, acquaintance or stranger, including one that isn't text and a missing one for set_trust, now answers invalid and changes nothing; the store used to save it as friend while the answer and the audit line said otherwise. onboard_agent's trustLevel input lists the four levels, an empty name or agentId answers invalid instead of saving a nameless peer, and both are saved without surrounding spaces. connect_to by name links only when exactly one agent has that name; two of the same name answer needs_handle_or_introduction instead of linking the first. The three tools now have Ouro AX cards."
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
