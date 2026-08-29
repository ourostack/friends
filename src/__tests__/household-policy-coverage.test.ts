import { afterEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { FileFriendStore, setNervesEmitter, type NervesEvent } from "../index"

const runFile = promisify(execFile)
const NOW = "2026-08-29T18:00:00.000Z"
const INCARNATION_A = "00000000-0000-4000-8000-000000000001"
const INCARNATION_B = "00000000-0000-4000-8000-000000000002"

function record(id: string, name = id) {
  return {
    id,
    name,
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  }
}

function journalRecord(id: string, recordIncarnation: string) {
  return {
    id,
    recordIncarnation,
    recordGeneration: 0,
    name: id,
    role: "friend",
    trustLevel: "stranger",
    admissionState: "unverified",
    initiativePolicy: "none",
    relationshipPolicy: { schemaVersion: 1, version: 0, preferences: {} },
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    kind: "human",
  }
}

function claimPath(friendsPath: string): { identityDigest: string; path: string } {
  const identityKey = JSON.stringify(["telegram-user", "42", null])
  const identityDigest = createHash("sha256").update(identityKey).digest("hex")
  return {
    identityDigest,
    path: join(friendsPath, "_external-id-claims", `${identityDigest}.json`),
  }
}

describe("household policy defensive coverage", () => {
  const dirs: string[] = []

  afterEach(() => {
    setNervesEmitter(null)
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function store(): { store: FileFriendStore; friendsPath: string } {
    const root = mkdtempSync(join(tmpdir(), "friends-policy-coverage-"))
    dirs.push(root)
    const friendsPath = join(root, "friends")
    return { store: new FileFriendStore(friendsPath), friendsPath }
  }

  it("normalizes every malformed policy boundary", async () => {
    const { store: subject, friendsPath } = store()
    writeFileSync(join(friendsPath, "boundaries.json"), JSON.stringify({
      id: "boundaries",
      name: "Boundaries",
      relationshipPolicy: { schemaVersion: 1, version: 1, preferences: null },
    }))
    expect((await subject.get("boundaries"))?.relationshipPolicy?.preferences).toEqual({})

    writeFileSync(join(friendsPath, "entries.json"), JSON.stringify({
      id: "entries",
      name: "Entries",
      relationshipPolicy: {
        schemaVersion: 1,
        version: 1,
        preferences: {
          nullValue: null,
          infinite: { value: "Infinity", provenance: "stated", version: 1, source: "event:1" },
          withoutExpiry: { value: 2, provenance: "observed", version: 1, source: "event:2" },
          withExpiry: { value: false, provenance: "default", version: 1, source: "bundle:defaults", expiresAt: "2026-09-01T00:00:00.000Z" },
          looseDate: { value: "x", provenance: "stated", version: 1, source: "event:4", expiresAt: "2026" },
        },
      },
    }))
    expect((await subject.get("entries"))?.relationshipPolicy?.preferences).toEqual({
      infinite: { value: "Infinity", provenance: "stated", version: 1, source: "event:1" },
      withoutExpiry: { value: 2, provenance: "observed", version: 1, source: "event:2" },
      withExpiry: { value: false, provenance: "default", version: 1, source: "bundle:defaults", expiresAt: "2026-09-01T00:00:00.000Z" },
    })

    await subject.put("nonfinite", {
      ...record("nonfinite"),
      relationshipPolicy: {
        schemaVersion: 1,
        version: 1,
        preferences: {
          infinite: { value: Number.POSITIVE_INFINITY, provenance: "stated", version: 1, source: "event:3" },
        },
      },
    })
    expect((await subject.get("nonfinite"))?.relationshipPolicy?.preferences).toEqual({})
  })

  it("uses exact friend IDs for link targets instead of the legacy name fallback", async () => {
    const { store: subject } = store()
    await subject.put("uuid-1", record("uuid-1", "Mom"))
    const result = await subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "Mom" },
    })
    expect(result).toEqual({ ok: false, status: "not_found" })
    expect((await subject.get("uuid-1"))?.externalIds).toEqual([])
  })

  it("fails closed on a corrupt or identity-mismatched pending claim", async () => {
    const { store: subject, friendsPath } = store()
    const pending = claimPath(friendsPath)
    mkdirSync(join(friendsPath, "_external-id-claims"), { mode: 0o700 })
    writeFileSync(pending.path, JSON.stringify({ schemaVersion: 1, state: "pending", targetKind: "create", identityDigest: "wrong", externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW }, friendId: "wrong", recordIncarnation: INCARNATION_A, createRecord: journalRecord("wrong", INCARNATION_A) }), { mode: 0o600 })
    let failure: unknown
    try {
      await subject.claimExternalId({
        externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
        target: { kind: "create", record: record("candidate") },
      })
    } catch (error: unknown) {
      failure = error
    }
    expect(failure).toMatchObject({ message: "external identity claim journal is invalid" })
    expect(await subject.get("candidate")).toBeNull()
    expect(await subject.get("wrong")).toBeNull()
  })

  it("fails closed on an unknown pending target variant", async () => {
    const { store: subject, friendsPath } = store()
    const pending = claimPath(friendsPath)
    mkdirSync(join(friendsPath, "_external-id-claims"), { mode: 0o700 })
    writeFileSync(pending.path, JSON.stringify({ schemaVersion: 1, state: "bogus", targetKind: "create", identityDigest: pending.identityDigest, externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW }, friendId: "candidate", recordIncarnation: INCARNATION_A }), { mode: 0o600 })
    await expect(subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: record("candidate") },
    })).rejects.toThrow("external identity claim journal is invalid")
  })

  it("keeps an immutable claim when its exact link target is missing", async () => {
    const { store: subject, friendsPath } = store()
    await subject.put("requester", record("requester"))
    const pending = claimPath(friendsPath)
    mkdirSync(join(friendsPath, "_external-id-claims"), { mode: 0o700 })
    writeFileSync(pending.path, JSON.stringify({
      schemaVersion: 1,
      state: "pending",
      identityDigest: pending.identityDigest,
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      friendId: "deleted-target",
      recordIncarnation: INCARNATION_A,
      targetKind: "link",
    }), { mode: 0o600 })
    const result = await subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "requester" },
    })
    expect(result).toEqual({ ok: false, status: "not_found" })
    expect((await subject.get("requester"))?.externalIds).toEqual([])
  })

  it("finalizes a crashed winner then reports a competing link as collision", async () => {
    const { store: subject, friendsPath } = store()
    await subject.put("requester", record("requester"))
    const pending = claimPath(friendsPath)
    mkdirSync(join(friendsPath, "_external-id-claims"), { mode: 0o700 })
    writeFileSync(pending.path, JSON.stringify({
      schemaVersion: 1,
      state: "pending",
      identityDigest: pending.identityDigest,
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      friendId: "crashed-winner",
      recordIncarnation: INCARNATION_A,
      targetKind: "create",
      createRecord: journalRecord("crashed-winner", INCARNATION_A),
    }), { mode: 0o600 })
    const result = await subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "requester" },
    })
    expect(result).toEqual({ ok: false, status: "collision", existingFriendId: "crashed-winner" })
    expect((await subject.get("crashed-winner"))?.externalIds).toHaveLength(1)
    expect((await subject.get("requester"))?.externalIds).toEqual([])
  })

  it("serializes real child processes to one immutable identity winner", async () => {
    const { store: subject, friendsPath } = store()
    const entry = resolve(__dirname, "../../dist/index.js")
    const script = `
      const { FileFriendStore } = require(process.argv[1]);
      const [friendsPath, id] = process.argv.slice(2);
      const now = "${NOW}";
      const record = { id, name: id, externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 };
      new FileFriendStore(friendsPath).claimExternalId({ externalId: { provider: "telegram-user", externalId: "42", linkedAt: now }, target: { kind: "create", record } }).then((result) => process.stdout.write(JSON.stringify({ status: result.status, id: result.record && result.record.id }))).catch((error) => { process.stderr.write(error.stack); process.exit(1); });
    `
    const [first, second] = await Promise.all([
      runFile(process.execPath, ["-e", script, entry, friendsPath, "child-a"]),
      runFile(process.execPath, ["-e", script, entry, friendsPath, "child-b"]),
    ])
    const results = [JSON.parse(first.stdout), JSON.parse(second.stdout)] as Array<{ status: string; id: string }>
    expect(results.map((result) => result.status).sort()).toEqual(["already_claimed", "created"])
    expect(results[0].id).toBe(results[1].id)
    expect((await subject.listAll()).filter((friend) => friend.externalIds.some((id) => id.provider === "telegram-user"))).toHaveLength(1)
  })

  it("converges 24 child processes linking different identities to one Friend incarnation", async () => {
    const { store: subject, friendsPath } = store()
    await subject.put("shared", record("shared"))
    const entry = resolve(__dirname, "../../dist/index.js")
    const script = `
      const { FileFriendStore } = require(process.argv[1]);
      const [friendsPath, externalId] = process.argv.slice(2);
      const now = "${NOW}";
      new FileFriendStore(friendsPath).claimExternalId({ externalId: { provider: "telegram-user", externalId, linkedAt: now }, target: { kind: "link", friendId: "shared" } }).then((result) => process.stdout.write(result.status)).catch((error) => { process.stderr.write(error.stack); process.exit(1); });
    `
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) =>
      runFile(process.execPath, ["-e", script, entry, friendsPath, String(1000 + index)]),
    ))
    expect(results.every((result) => result.stdout === "linked")).toBe(true)
    const linked = await subject.get("shared")
    expect(linked?.externalIds.map((externalId) => externalId.externalId).sort()).toEqual(
      Array.from({ length: 24 }, (_, index) => String(1000 + index)).sort(),
    )
  })

  it("rejects delete-and-recreate ABA even when the Friend UUID is reused", async () => {
    const { store: subject } = store()
    await subject.put("same-id", { ...record("same-id"), recordIncarnation: "caller-controlled" })
    const firstIncarnation = (await subject.get("same-id"))!.recordIncarnation
    expect(firstIncarnation).not.toBe("caller-controlled")
    await subject.put("same-id", { ...record("same-id"), recordIncarnation: "mutated-by-caller" })
    expect((await subject.get("same-id"))!.recordIncarnation).toBe(firstIncarnation)
    const input = {
      externalId: { provider: "telegram-user" as const, externalId: "42", linkedAt: NOW },
      target: { kind: "link" as const, friendId: "same-id" },
    }
    expect((await subject.claimExternalId(input)).status).toBe("linked")
    await subject.delete("same-id")
    await subject.put("same-id", { ...record("same-id"), recordIncarnation: firstIncarnation })
    expect((await subject.get("same-id"))!.recordIncarnation).not.toBe(firstIncarnation)
    await expect(subject.claimExternalId(input)).rejects.toThrow("external identity claim target incarnation no longer exists")
    expect((await subject.get("same-id"))?.externalIds).toEqual([])
  })

  it("forbids create candidates from smuggling preclaimed external IDs", async () => {
    const { store: subject } = store()
    await expect(subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: { ...record("candidate"), externalIds: [{ provider: "aad", externalId: "smuggled", linkedAt: NOW }] } },
    })).rejects.toThrow("create candidate is invalid")
    expect(await subject.get("candidate")).toBeNull()

    await expect(subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "43", linkedAt: NOW },
      target: {
        kind: "create",
        record: {
          ...record("privileged"),
          trustLevel: "family",
          admissionState: "active",
          initiativePolicy: "proactive",
          capabilityProfileId: "operator",
          tenantMemberships: ["admin"],
          toolPreferences: { shell: { allow: true } },
        },
      },
    })).rejects.toThrow("create candidate is invalid")
    expect(await subject.get("privileged")).toBeNull()
  })

  it("constructs a minimal store-owned unverified Friend for a create claim", async () => {
    const { store: subject } = store()
    const result = await subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: { id: "new-contact", name: "  New Contact  " } },
    })
    expect(result).toMatchObject({
      ok: true,
      status: "created",
      record: {
        id: "new-contact",
        name: "New Contact",
        trustLevel: "stranger",
        admissionState: "unverified",
        initiativePolicy: "none",
        relationshipPolicy: { schemaVersion: 1, version: 0, preferences: {} },
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
      },
    })
    if (!result.ok) throw new Error("expected create claim success")
    expect(result.record.recordIncarnation).toEqual(expect.any(String))
    expect(result.record.capabilityProfileId).toBeUndefined()
  })

  it("rejects every malformed or authority-bearing journal state", async () => {
    const cases = [
      (base: Record<string, unknown>) => ({ ...base, createRecord: null }),
      (base: Record<string, unknown>) => ({ ...base, extra: true }),
      (base: Record<string, unknown>) => ({ ...base, externalId: { provider: "telegram-user", externalId: "42", linkedAt: "2026" } }),
      (base: Record<string, unknown>) => ({ ...base, createRecord: { ...base.createRecord as object, externalIds: [{ provider: "aad", externalId: "smuggled", linkedAt: NOW }] } }),
      (base: Record<string, unknown>) => ({ ...base, createRecord: { ...base.createRecord as object, name: 42 } }),
      (base: Record<string, unknown>) => ({ ...base, createRecord: { ...base.createRecord as object, name: " x " } }),
      (base: Record<string, unknown>) => ({ ...base, createRecord: { ...base.createRecord as object, name: "x".repeat(257) } }),
      (base: Record<string, unknown>) => ({ ...base, createRecord: { ...base.createRecord as object, role: "operator" } }),
      (base: Record<string, unknown>) => ({ ...base, createRecord: { ...base.createRecord as object, trustLevel: "family" } }),
      (base: Record<string, unknown>) => ({ ...base, createRecord: { ...base.createRecord as object, recordGeneration: -1 } }),
      (base: Record<string, unknown>) => ({ ...base, createRecord: { ...base.createRecord as object, createdAt: "2026" } }),
      (base: Record<string, unknown>) => ({ ...base, recordIncarnation: "caller", createRecord: { ...base.createRecord as object, recordIncarnation: "caller" } }),
      (base: Record<string, unknown>) => ({ ...base, state: "committed", createRecord: base.createRecord }),
    ]
    for (const mutate of cases) {
      const current = store()
      const pending = claimPath(current.friendsPath)
      mkdirSync(join(current.friendsPath, "_external-id-claims"), { mode: 0o700 })
      const base = {
        schemaVersion: 1,
        state: "pending",
        targetKind: "create",
        identityDigest: pending.identityDigest,
        externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
        friendId: "crafted",
        recordIncarnation: INCARNATION_A,
        createRecord: journalRecord("crafted", INCARNATION_A),
      }
      writeFileSync(pending.path, JSON.stringify(mutate(base)), { mode: 0o600 })
      await expect(current.store.claimExternalId({
        externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
        target: { kind: "create", record: record("retry") },
      })).rejects.toThrow("claim journal is invalid")
      expect(await current.store.get("crafted")).toBeNull()
    }
  })

  it("rejects symlinked and replaced Friend or claim directories without redirected writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "friends-directory-safety-"))
    dirs.push(root)
    const redirected = join(root, "redirected")
    mkdirSync(redirected)
    const symlinked = join(root, "symlinked")
    symlinkSync(redirected, symlinked)
    expect(() => new FileFriendStore(symlinked)).toThrow("must not be a symbolic link")

    const nested = new FileFriendStore(join(root, "missing", "parent", "friends"))
    await nested.put("nested", record("nested"))
    expect((await nested.get("nested"))?.id).toBe("nested")
    await expect(nested.put("wrong", record("different"))).rejects.toThrow("friend record id is invalid")

    const friendsPath = join(root, "friends")
    const subject = new FileFriendStore(friendsPath)
    const movedFriends = join(root, "friends-retained")
    renameSync(friendsPath, movedFriends)
    symlinkSync(redirected, friendsPath)
    await expect(subject.put("escaped", record("escaped"))).rejects.toThrow("friends directory identity changed")
    expect(readdirSync(redirected)).toEqual([])

    const claimsRoot = mkdtempSync(join(tmpdir(), "claims-directory-safety-"))
    dirs.push(claimsRoot)
    const claimsFriendsPath = join(claimsRoot, "friends")
    const claimsStore = new FileFriendStore(claimsFriendsPath)
    await claimsStore.put("target", record("target"))
    await claimsStore.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "41", linkedAt: NOW },
      target: { kind: "link", friendId: "target" },
    })
    const claimsDirectory = join(claimsFriendsPath, "_external-id-claims")
    renameSync(claimsDirectory, join(claimsFriendsPath, "claims-retained"))
    const redirectedClaims = join(claimsRoot, "redirected-claims")
    mkdirSync(redirectedClaims)
    symlinkSync(redirectedClaims, claimsDirectory)
    await expect(claimsStore.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "target" },
    })).rejects.toThrow("claims directory has unsafe")
    expect(existsSync(join(redirectedClaims, `${claimPath(claimsFriendsPath).identityDigest}.json`))).toBe(false)

    const replacedRoot = mkdtempSync(join(tmpdir(), "claims-directory-replaced-"))
    dirs.push(replacedRoot)
    const replacedFriendsPath = join(replacedRoot, "friends")
    const replacedStore = new FileFriendStore(replacedFriendsPath)
    await replacedStore.put("target", record("target"))
    await replacedStore.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "41", linkedAt: NOW },
      target: { kind: "link", friendId: "target" },
    })
    const replacedClaims = join(replacedFriendsPath, "_external-id-claims")
    renameSync(replacedClaims, join(replacedFriendsPath, "claims-retained"))
    mkdirSync(replacedClaims, { mode: 0o700 })
    await expect(replacedStore.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "target" },
    })).rejects.toThrow("claims directory identity changed")
  })

  it("rejects unsafe Friend record leaves and propagates non-absence delete failures", async () => {
    const first = store()
    mkdirSync(join(first.friendsPath, "directory-record.json"))
    await expect(first.store.get("directory-record")).rejects.toThrow("friend record file is unsafe")

    symlinkSync(join(first.friendsPath, "missing.json"), join(first.friendsPath, "redirected.json"))
    await expect(first.store.get("redirected")).rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|EMLINK/) })

    mkdirSync(join(first.friendsPath, "undeletable.json"))
    await expect(first.store.delete("undeletable")).rejects.toMatchObject({ code: expect.stringMatching(/EPERM|EISDIR/) })
  })

  it("fails closed when legacy records ambiguously contain the same external identity", async () => {
    const { store: subject } = store()
    const externalId = { provider: "telegram-user" as const, externalId: "42", linkedAt: NOW }
    await subject.put("one", { ...record("one"), externalIds: [externalId] })
    await subject.put("two", { ...record("two"), externalIds: [externalId] })
    await expect(subject.findByExternalId("telegram-user", "42")).rejects.toThrow("ambiguously bound")
    await expect(subject.claimExternalId({ externalId, target: { kind: "link", friendId: "one" } })).rejects.toThrow("ambiguously bound")
  })

  it("heals a crash after Friend write but before pending-journal compaction", async () => {
    const { store: subject, friendsPath } = store()
    const externalId = { provider: "telegram-user" as const, externalId: "42", linkedAt: NOW }
    await subject.put("written", { ...record("written"), externalIds: [externalId] })
    const pending = claimPath(friendsPath)
    mkdirSync(join(friendsPath, "_external-id-claims"), { mode: 0o700 })
    writeFileSync(pending.path, JSON.stringify({
      schemaVersion: 1,
      state: "pending",
      identityDigest: pending.identityDigest,
      externalId,
      friendId: "written",
      recordIncarnation: (await subject.get("written"))!.recordIncarnation,
      targetKind: "create",
      createRecord: journalRecord("written", (await subject.get("written"))!.recordIncarnation!),
    }), { mode: 0o600 })
    const result = await subject.claimExternalId({ externalId, target: { kind: "create", record: record("retry") } })
    expect(result.status).toBe("already_claimed")
    expect(JSON.parse(readFileSync(pending.path, "utf-8"))).toEqual({
      schemaVersion: 1,
      state: "committed",
      identityDigest: pending.identityDigest,
      externalId,
      friendId: "written",
      recordIncarnation: (await subject.get("written"))!.recordIncarnation,
      targetKind: "create",
    })
  })

  it("reports a truthful durable phase if journal compaction fails after the Friend write", async () => {
    const { store: subject } = store()
    const events: NervesEvent[] = []
    setNervesEmitter((event) => events.push(event))
    type Internals = { commitClaimIndex(): Promise<void> }
    ;(subject as unknown as Internals).commitClaimIndex = async () => { throw new Error("simulated compaction failure") }
    await expect(subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: { id: "durable", name: "Durable" } },
    })).rejects.toThrow("simulated compaction failure")
    expect(events.find((event) => event.event === "friends.external_id_claim_error")?.meta).toMatchObject({ phase: "friend_durable" })
    expect((await subject.get("durable"))?.externalIds).toMatchObject([{ externalId: "42" }])
  })

  it("rejects null and malformed claim envelopes before dereference with safe metadata", async () => {
    const { store: subject } = store()
    const events: NervesEvent[] = []
    setNervesEmitter((event) => events.push(event))
    const malformed = [
      null,
      {},
      { externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW }, target: null },
      { externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW }, target: { kind: "bogus" } },
      { externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW }, target: { kind: "link", friendId: 42 } },
      { externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW }, target: { kind: "link", friendId: "target", extra: true } },
    ]
    for (const input of malformed) {
      await expect(subject.claimExternalId(input as never)).rejects.toThrow("claim input is invalid")
    }
    const errors = events.filter((event) => event.event === "friends.external_id_claim_error")
    expect(errors).toHaveLength(malformed.length)
    expect(errors[0].meta).toMatchObject({ provider: "invalid", targetKind: "invalid", phase: "validating" })
    expect(errors.slice(1).every((event) => event.meta?.phase === "validating")).toBe(true)
  })

  it("preserves legacy claims and applies committed-journal collision and incarnation rules", async () => {
    const legacy = store()
    const externalId = { provider: "telegram-user" as const, externalId: "42", linkedAt: NOW }
    await legacy.store.put("owner", { ...record("owner"), externalIds: [externalId] })
    const legacyResult = await legacy.store.claimExternalId({ externalId, target: { kind: "create", record: record("owner") } })
    expect(legacyResult).toMatchObject({ ok: true, status: "already_claimed", record: { id: "owner" } })

    const stale = store()
    await stale.store.put("owner", { ...record("owner"), externalIds: [externalId] })
    const staleClaim = claimPath(stale.friendsPath)
    mkdirSync(join(stale.friendsPath, "_external-id-claims"), { mode: 0o700 })
    writeFileSync(staleClaim.path, JSON.stringify({
      schemaVersion: 1,
      state: "committed",
      identityDigest: staleClaim.identityDigest,
      externalId,
      friendId: "owner",
      recordIncarnation: INCARNATION_B,
      targetKind: "create",
    }), { mode: 0o600 })
    await expect(stale.store.claimExternalId({ externalId, target: { kind: "create", record: record("retry") } })).rejects.toThrow("target incarnation no longer exists")

    const collision = store()
    await collision.store.put("owner", { ...record("owner"), externalIds: [externalId] })
    await collision.store.put("contender", record("contender"))
    const committedClaim = claimPath(collision.friendsPath)
    mkdirSync(join(collision.friendsPath, "_external-id-claims"), { mode: 0o700 })
    writeFileSync(committedClaim.path, JSON.stringify({
      schemaVersion: 1,
      state: "committed",
      identityDigest: committedClaim.identityDigest,
      externalId,
      friendId: "owner",
      recordIncarnation: (await collision.store.get("owner"))!.recordIncarnation,
      targetKind: "link",
    }), { mode: 0o600 })
    expect(await collision.store.claimExternalId({ externalId, target: { kind: "link", friendId: "contender" } })).toEqual({ ok: false, status: "collision", existingFriendId: "owner" })
  })

  it("rejects malformed identities, create records, and legacy records without incarnations", async () => {
    const invalidIdentity = store()
    await expect(invalidIdentity.store.claimExternalId({
      externalId: { provider: "", externalId: "", linkedAt: "not-a-date" },
      target: { kind: "create", record: record("candidate") },
    })).rejects.toThrow("external identity claim is invalid")

    const malformedCreate = store()
    await expect(malformedCreate.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: { ...record("candidate"), notes: [] } as unknown as ReturnType<typeof record> },
    })).rejects.toThrow("create candidate is invalid")
    await expect(malformedCreate.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: null as unknown as ReturnType<typeof record> },
    })).rejects.toThrow("create candidate is invalid")

    const malformedCandidates = [
      { ...record("candidate"), id: "../candidate" },
      { ...record("candidate"), name: 42 },
      { ...record("candidate"), name: "" },
      { ...record("candidate"), name: "x".repeat(257) },
      { ...record("candidate"), recordIncarnation: "caller" },
      { ...record("candidate"), recordGeneration: 0 },
      { ...record("candidate"), trustLevel: "family" },
      { ...record("candidate"), admissionState: "active" },
      { ...record("candidate"), initiativePolicy: "proactive" },
      { ...record("candidate"), relationshipPolicy: null },
      { ...record("candidate"), relationshipPolicy: { schemaVersion: 1, version: 1, preferences: {} } },
      { ...record("candidate"), capabilityProfileId: "operator" },
      { ...record("candidate"), externalIds: null },
      { ...record("candidate"), tenantMemberships: null },
      { ...record("candidate"), tenantMemberships: ["admin"] },
      { ...record("candidate"), toolPreferences: null },
      { ...record("candidate"), toolPreferences: [] },
      { ...record("candidate"), toolPreferences: { shell: true } },
      { ...record("candidate"), notes: null },
      { ...record("candidate"), notes: [] },
      { ...record("candidate"), notes: { secret: true } },
      { ...record("candidate"), connections: [{ name: "Ari", relationship: "owner" }] },
      { ...record("candidate"), importedNotes: {} },
      { ...record("candidate"), agentMeta: {} },
      { ...record("candidate"), kind: "agent" },
      { ...record("candidate"), totalTokens: 1 },
    ]
    for (const candidate of malformedCandidates) {
      await expect(malformedCreate.store.claimExternalId({
        externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
        target: { kind: "create", record: candidate as never },
      })).rejects.toThrow(/create candidate|target id/)
    }

    const malformedExternalIds = [
      null,
      { provider: "bogus", externalId: "42", linkedAt: NOW },
      { provider: "telegram-user", externalId: 42, linkedAt: NOW },
      { provider: "telegram-user", externalId: "", linkedAt: NOW },
      { provider: "telegram-user", externalId: "x".repeat(513), linkedAt: NOW },
      { provider: "telegram-user", externalId: "42", tenantId: 42, linkedAt: NOW },
      { provider: "telegram-user", externalId: "42", tenantId: "", linkedAt: NOW },
      { provider: "telegram-user", externalId: "42", tenantId: "x".repeat(513), linkedAt: NOW },
      { provider: "telegram-user", externalId: "42", linkedAt: 42 },
      { provider: "telegram-user", externalId: "42", linkedAt: "not-a-date" },
      { provider: "telegram-user", externalId: "42", linkedAt: "2026" },
    ]
    for (const externalId of malformedExternalIds) {
      await expect(malformedCreate.store.claimExternalId({
        externalId: externalId as never,
        target: { kind: "create", record: record("candidate") },
      })).rejects.toThrow("external identity claim is invalid")
    }

    const tenantStore = store()
    await tenantStore.store.put("target", record("target"))
    expect((await tenantStore.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", tenantId: "household", linkedAt: NOW },
      target: { kind: "link", friendId: "target" },
    })).status).toBe("linked")

    const legacyLink = store()
    writeFileSync(join(legacyLink.friendsPath, "legacy.json"), JSON.stringify(record("legacy")))
    await expect(legacyLink.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "legacy" },
    })).rejects.toThrow("needs an incarnation")

    const legacyCreate = store()
    writeFileSync(join(legacyCreate.friendsPath, "legacy.json"), JSON.stringify(record("legacy")))
    await expect(legacyCreate.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: record("legacy") },
    })).rejects.toThrow("needs an incarnation")

    const existingCreate = store()
    await existingCreate.store.put("existing", record("existing"))
    expect((await existingCreate.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: record("existing") },
    })).status).toBe("linked")

  })

  it("ignores unrelated claim journals while reconciling a Friend", async () => {
    const { store: subject, friendsPath } = store()
    await subject.put("first", record("first"))
    await subject.put("second", record("second"))
    expect((await subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "41", linkedAt: NOW },
      target: { kind: "link", friendId: "first" },
    })).status).toBe("linked")
    writeFileSync(join(friendsPath, "_external-id-claims", ".ignored.tmp"), "ignored", { mode: 0o600 })
    expect((await subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "second" },
    })).status).toBe("linked")
  })

  it("derives claimed identities from immutable journals after a stale Friend write", async () => {
    const { store: subject, friendsPath } = store()
    await subject.put("shared", record("shared"))
    for (const externalId of ["41", "42"]) {
      expect((await subject.claimExternalId({
        externalId: { provider: "telegram-user", externalId, linkedAt: NOW },
        target: { kind: "link", friendId: "shared" },
      })).status).toBe("linked")
    }
    await subject.put("shared", { ...record("shared"), externalIds: [{ provider: "telegram-user", externalId: "41", linkedAt: NOW }] })
    expect(JSON.parse(readFileSync(join(friendsPath, "shared.json"), "utf-8")).externalIds).toHaveLength(1)
    expect((await subject.get("shared"))?.externalIds.map((identity) => identity.externalId).sort()).toEqual(["41", "42"])
    expect((await subject.listAll())[0].externalIds.map((identity) => identity.externalId).sort()).toEqual(["41", "42"])
  })

  it("retries reconciliation when a claim appears after a Friend write", async () => {
    const { store: subject } = store()
    await subject.put("shared", record("shared"))
    type Journal = { externalId: { provider: string; externalId: string; linkedAt: string } }
    type Internals = { readAllClaimsForTarget(friendId: string, incarnation: string): Promise<Journal[]> }
    const internals = subject as unknown as Internals
    const original = internals.readAllClaimsForTarget.bind(subject)
    let reads = 0
    internals.readAllClaimsForTarget = async (friendId, incarnation) => {
      const claims = await original(friendId, incarnation)
      reads += 1
      return reads === 2
        ? [...claims, { externalId: { provider: "telegram-user", externalId: "late", linkedAt: NOW } }]
        : claims
    }
    expect((await subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "shared" },
    })).status).toBe("linked")
    expect(reads).toBeGreaterThan(2)
  })

  it("fails if a Friend incarnation changes during reconciliation", async () => {
    const { store: subject } = store()
    await subject.put("shared", record("shared"))
    type Internals = { getExact(id: string): Promise<ReturnType<typeof record> | null> }
    const internals = subject as unknown as Internals
    const original = internals.getExact.bind(subject)
    let reads = 0
    internals.getExact = async (id) => {
      const found = await original(id)
      reads += 1
      return reads === 3 && found ? { ...found, recordIncarnation: "replacement" } : found
    }
    await expect(subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "shared" },
    })).rejects.toThrow("incarnation changed during commit")
  })

  it("fails closed when reconciliation cannot reach a stable claim set", async () => {
    const { store: subject } = store()
    await subject.put("shared", record("shared"))
    type Journal = { externalId: { provider: string; externalId: string; linkedAt: string } }
    type Internals = { readAllClaimsForTarget(friendId: string, incarnation: string): Promise<Journal[]> }
    const internals = subject as unknown as Internals
    const original = internals.readAllClaimsForTarget.bind(subject)
    let reads = 0
    internals.readAllClaimsForTarget = async (friendId, incarnation) => {
      const claims = await original(friendId, incarnation)
      reads += 1
      return [...claims, { externalId: { provider: "telegram-user", externalId: `late-${reads}`, linkedAt: NOW } }]
    }
    await expect(subject.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "shared" },
    })).rejects.toThrow("claims did not converge")
  })

  it("rejects unsafe claim directories, journal modes, and target paths", async () => {
    const first = store()
    const elsewhere = mkdtempSync(join(tmpdir(), "friends-claims-target-"))
    dirs.push(elsewhere)
    symlinkSync(elsewhere, join(first.friendsPath, "_external-id-claims"))
    await first.store.put("candidate", record("candidate"))
    await expect(first.store.get("candidate")).rejects.toThrow("claims directory has unsafe")
    await expect(first.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: record("candidate") },
    })).rejects.toThrow("claims directory has unsafe")

    const second = store()
    mkdirSync(join(second.friendsPath, "_external-id-claims"), { mode: 0o755 })
    await expect(second.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: record("candidate") },
    })).rejects.toThrow("claims directory has unsafe")

    const third = store()
    const pending = claimPath(third.friendsPath)
    mkdirSync(join(third.friendsPath, "_external-id-claims"), { mode: 0o700 })
    writeFileSync(pending.path, "{}", { mode: 0o600 })
    chmodSync(pending.path, 0o644)
    await expect(third.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "create", record: record("candidate") },
    })).rejects.toThrow("journal has unsafe")

    const fourth = store()
    await expect(fourth.store.claimExternalId({
      externalId: { provider: "telegram-user", externalId: "42", linkedAt: NOW },
      target: { kind: "link", friendId: "../escape" },
    })).rejects.toThrow("target id is invalid")
  })
})
