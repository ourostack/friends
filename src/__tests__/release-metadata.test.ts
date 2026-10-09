import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const expectedVersion = "0.1.0-alpha.16"
const expectedChanges = [
  "Re-onboarding a peer under a different DID resets its trust and grants (an onboard cannot raise a reset peer; onboard_agent and connect_to audit the stored level and report an ignored raise), and group context no longer promotes a reset record.",
  "Rotated DID pins are kept as retired tombstones that receiveShare rejects; a rotation must name a successor DID that belongs to the successor key and cannot overwrite another peer's pin; the new applyAcceptedRotation carries the peer's record, trust and grants to the new DID.",
  "Linking an id no longer moves an orphan's other ids onto a record that holds authority and resumes an interrupted merge the same way it started (a store without listAll reports retry_unsupported), and each peer's imported id claims on a record are capped at 32."
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
