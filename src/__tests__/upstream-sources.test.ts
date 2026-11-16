import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const root = join(__dirname, "..", "..")

interface LockFile {
  sourcePath: string
  generatedPath: string
  sha256: string
}

const lock = JSON.parse(readFileSync(join(root, "upstream-sources.lock.json"), "utf8")) as {
  schemaVersion: number
  sources: { id: string; files: LockFile[] }[]
}

describe("upstream-sources.lock.json", () => {
  it("records the Ouro AX kit with every vendored file", () => {
    expect(lock.schemaVersion).toBe(1)
    const ax = lock.sources.find((source) => source.id === "ourostack-ouro-ui-ax")
    expect(ax?.files.length).toBeGreaterThan(0)
  })

  it.each(lock.sources.flatMap((source) => source.files))(
    "$generatedPath matches its recorded sha256",
    ({ generatedPath, sha256 }) => {
      const actual = createHash("sha256").update(readFileSync(join(root, generatedPath))).digest("hex")
      expect(actual).toBe(sha256)
    },
  )
})
