import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))
const expectedVersion = "0.1.0-alpha.15"
const expectedChanges = [
  "Bind every signed envelope to its recipient, kind, a random message id and its issue time (signed binding field). receiveShare rejects re-sealed, replayed, stale and unbound delegated envelopes, dedupes concurrent deliveries (a duplicate in flight gets the retryable in_flight), leaves a message redeliverable when it fails before its signature verifies (once verified it is consumed), also marks the bare seal nonce so an older receiver cannot replay it, returns the signed id as bindingId, and reports explicit reasons. New checkEnvelopeBinding export and rejectUnboundEnvelopes option; invalid time options throw a TypeError.",
  "Deprecate the friend-record DelegationGrant as authority; add PinnedDelegationGrant and checkPinnedDelegationGrant for hosts that keep grants in trusted storage. setFriendTrust and upsertAgentPeer clear the legacy grant whenever trust is below family; setFriendTrust reports delegationSuspended.",
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
