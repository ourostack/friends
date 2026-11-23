import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const expectedVersion = "0.1.0-alpha.27"
const expectedChanges = [
  "link_identity is marked destructive, because a merge deletes the record it folds in. An empty externalId, or a provider other than aad, local, teams-conversation, imessage-handle, email-address, a2a-agent or telegram-user, now answers invalid and links nothing; both used to be saved and answer linked. The provider input lists the seven providers. link_identity now has an Ouro AX card."
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
