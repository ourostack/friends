import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const dir = join(__dirname, "..", "..", "tools", "ouro-actions")
const manifest = JSON.parse(readFileSync(join(dir, "dist-manifest.json"), "utf8")) as {
  coreTag: string
  files: Record<string, string>
}
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

describe("vendored ouro-actions from ouro-ui-core's release", () => {
  it("is the release the manifest names, file by file", () => {
    expect(manifest.coreTag).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(sha256(join(dir, "ouro-actions.mts"))).toBe(manifest.files["dist/actions/ouro-actions.mts"])
    expect(sha256(join(dir, "actions.claims.json"))).toBe(manifest.files["dist/ax/actions.claims.json"])
  })
})
