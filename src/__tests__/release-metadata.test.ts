import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const expectedVersion = "0.1.0-alpha.24"
const expectedChanges = [
  "Sharing tells the truth about grants and imports. revoke_share answers invalid for a grant id that isn't letters, digits, dots, underscores and hyphens starting with a letter or digit; a grant id like \"../<friend id>\" used to read a friend record as a grant, answer revoked and write a bogus grant file. The grant store reads, writes and deletes only files named directly inside _grants, names each grant by its file, and writes a revocation back to that file. Damage reads as less consent, never more: a grant file whose scope friends doesn't know is skipped (it used to read as an identity grant), any revokedAt revokes, and an expiresAt that isn't an ISO date, empty included, consents to nothing (it used to last forever). grant_share answers invalid for an expiresAt that isn't an ISO date, such as 2027-01-01 or 2027-01-01T00:00:00Z. import_profile lands an outcomes share's outcomes in the record's new importedOutcomes, under the agent that shared them, newest 256 per agent, with first-party outcomes untouched and damaged entries already in that slot dropped, and answers importedOutcomes, the number that landed; before, it answered imported and kept none. It answers invalid, instead of failing partway, for an envelope without a subject whose externalIds is a list of { provider, externalId }, notes that aren't a list of { key, value } (a key of __proto__ included), outcomes that aren't a list, or an empty fromAgentId. import_profile and revoke_share now have Ouro AX cards."
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
