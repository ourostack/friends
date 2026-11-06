import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const expectedVersion = "0.1.0-alpha.17"
const expectedChanges = [
  "Development dependencies only, to clear npm audit: vite 8.3.5 (GHSA-587h-7wmj-h5pm, which includes its bundled launch-editor; GHSA-9jrq-w75r-8gcw; GHSA-rq7h-c2jc-7f22), vitest and @vitest/coverage-v8 4.1.12 (GHSA-qxg6-89mg-rqv8, GHSA-xp26-3454-mjgp), and an override pinning minimatch to ^11.0.1 under eslint and typescript-eslint (GHSA-g3hv-75wg-m249). The published library is unchanged."
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
