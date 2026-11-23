import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const expectedVersion = "0.1.0-alpha.25"
const expectedChanges = [
  "record_interaction says what it did. A friend that doesn't exist answers not_found; it used to answer success. Usage that isn't an object whose output_tokens is a whole number of 0 or more, an outcome without a missionId and a result of success, partial or failed, or an outcome for someone who isn't an agent answers invalid and saves nothing; unreadable JSON there used to be ignored, and an outcome for a person used to answer recorded while the store dropped it. A successful call answers ok true, status recorded, with tokensAccumulated false when there were no output tokens to add. save_note, record_interaction, set_trust, link_identity and unlink_identity now work on a friend named rather than given by uuid: they write by the record's own id, which the file store used to refuse. A name two records share, or an empty friendId, now finds no friend rather than the first file read, so a write by name can't land on the wrong person. A link by name also never mistakes the record itself for a duplicate. The set_trust audit line names the record's id. record_interaction now has an Ouro AX card."
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
