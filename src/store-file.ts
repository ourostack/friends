// FileFriendStore -- filesystem adapter for FriendStore.
// Stores each friend as one unified JSON file in bundle `friends/`.

import * as fs from "fs"
import * as fsPromises from "fs/promises"
import * as path from "path"
import { createHash, randomUUID } from "crypto"
import { capStructuredRecordString } from "./util/cap-string"
import { emitNervesEvent } from "./observability"
import { isIdentityProvider } from "./types"
import type {
  ExternalIdClaimInput,
  ExternalIdClaimResult,
  ExternalIdClaimStore,
} from "./store"
import type {
  AdmissionState,
  AgentMeta,
  FriendRecord,
  InitiativePolicy,
  RelationshipPolicy,
  RelationshipPolicyPreference,
  TrustLevel,
} from "./types"

const DEFAULT_ROLE = "friend"
const DEFAULT_TRUST_LEVEL: TrustLevel = "friend"
const DEFAULT_ADMISSION_STATE: AdmissionState = "unverified"
const DEFAULT_INITIATIVE_POLICY: InitiativePolicy = "none"
const CLAIMS_DIR_NAME = "_external-id-claims"
const MAX_CLAIM_BYTES = 1_048_576
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

interface ExternalIdClaimJournalBase {
  schemaVersion: 1
  identityDigest: string
  externalId: ExternalIdClaimInput["externalId"]
  friendId: string
  recordIncarnation: string
}

type PendingExternalIdClaim = ExternalIdClaimJournalBase & (
  | { state: "pending"; targetKind: "create"; createRecord: FriendRecord }
  | { state: "pending"; targetKind: "link" }
)

type CommittedExternalIdClaim = ExternalIdClaimJournalBase & {
  state: "committed"
  targetKind: "create" | "link"
}

type ExternalIdClaimJournal = PendingExternalIdClaim | CommittedExternalIdClaim

export class FileFriendStore implements ExternalIdClaimStore {
  private readonly friendsPath: string
  private readonly friendsDirectoryFd: number
  private readonly friendsDirectoryIdentity: { dev: number; ino: number }
  private claimsDirectoryFd?: number
  private claimsDirectoryIdentity?: { dev: number; ino: number }

  constructor(friendsPath: string) {
    const absolutePath = path.resolve(friendsPath)
    if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isSymbolicLink()) {
      throw new Error("friends directory must not be a symbolic link")
    }
    let existingAncestor = path.dirname(absolutePath)
    const missingSegments: string[] = []
    while (!fs.existsSync(existingAncestor)) {
      missingSegments.unshift(path.basename(existingAncestor))
      existingAncestor = path.dirname(existingAncestor)
    }
    const parentPath = path.join(fs.realpathSync(existingAncestor), ...missingSegments)
    fs.mkdirSync(parentPath, { recursive: true })
    this.friendsPath = path.join(parentPath, path.basename(absolutePath))
    fs.mkdirSync(this.friendsPath, { recursive: true })
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    this.friendsDirectoryFd = fs.openSync(this.friendsPath, flags)
    const stat = fs.fstatSync(this.friendsDirectoryFd)
    this.friendsDirectoryIdentity = { dev: stat.dev, ino: stat.ino }
    this.assertFriendsDirectoryIdentity()
    emitNervesEvent({
      component: "friends",
      event: "friends.store_init",
      message: "file friend store initialized",
      meta: {},
    })
  }

  async get(id: string): Promise<FriendRecord | null> {
    // Direct UUID lookup
    const record = await this.readJson(path.join(this.friendsPath, `${id}.json`))
    if (record) return await this.normalizeWithClaims(record)

    // Fallback: if id is a name (not UUID), scan for matching friend
    /* v8 ignore start -- name fallback: exercised by live proactive sends @preserve */
    try {
      this.assertFriendsDirectoryIdentity()
      const entries = await fsPromises.readdir(this.friendsPath)
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue
        const raw = await this.readJson(path.join(this.friendsPath, entry))
        if (!raw) continue
        const normalized = await this.normalizeWithClaims(raw)
        if (normalized.name?.toLowerCase() === id.toLowerCase()) {
          return normalized
        }
      }
      this.assertFriendsDirectoryIdentity()
    } catch { /* directory unreadable — return null */ }
    /* v8 ignore stop */

    return null
  }

  async put(id: string, record: FriendRecord): Promise<void> {
    if (!SAFE_RECORD_ID.test(id) || record.id !== id) throw new Error("friend record id is invalid")
    const existing = await this.readJson(path.join(this.friendsPath, `${id}.json`))
    const existingIncarnation = typeof existing?.recordIncarnation === "string" && existing.recordIncarnation
      ? existing.recordIncarnation
      : undefined
    const existingGeneration = Number.isSafeInteger(existing?.recordGeneration) && (existing?.recordGeneration as number) >= 0
      ? existing?.recordGeneration as number
      : -1
    await this.writeJson(
      path.join(this.friendsPath, `${id}.json`),
      this.normalize({
        ...record,
        id,
        recordIncarnation: existingIncarnation ?? randomUUID(),
        recordGeneration: existingGeneration + 1,
      }),
    )
  }

  async delete(id: string): Promise<void> {
    await this.removeFile(path.join(this.friendsPath, `${id}.json`))
  }

  async findByExternalId(
    provider: string,
    externalId: string,
    tenantId?: string,
  ): Promise<FriendRecord | null> {
    let entries: string[]
    try {
      this.assertFriendsDirectoryIdentity()
      entries = await fsPromises.readdir(this.friendsPath)
      this.assertFriendsDirectoryIdentity()
    } catch {
      return null
    }

    const matches: FriendRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const raw = await this.readJson(path.join(this.friendsPath, entry))
      if (!raw) continue
      const record = await this.normalizeWithClaims(raw)

      const match = record.externalIds.some(
        (ext) =>
          ext.provider === provider &&
          ext.externalId === externalId &&
          (tenantId === undefined || ext.tenantId === tenantId),
      )

      if (match) {
        matches.push(record)
      }
    }
    if (matches.length > 1) throw new Error("external identity is ambiguously bound to multiple friends")
    return matches[0] ?? null
  }

  async hasAnyFriends(): Promise<boolean> {
    let entries: string[]
    try {
      this.assertFriendsDirectoryIdentity()
      entries = await fsPromises.readdir(this.friendsPath)
      this.assertFriendsDirectoryIdentity()
    } catch {
      return false
    }

    return entries.some((entry) => entry.endsWith(".json"))
  }

  async listAll(): Promise<FriendRecord[]> {
    let entries: string[]
    try {
      this.assertFriendsDirectoryIdentity()
      entries = await fsPromises.readdir(this.friendsPath)
      this.assertFriendsDirectoryIdentity()
    } catch {
      return []
    }

    const records: FriendRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const raw = await this.readJson(path.join(this.friendsPath, entry))
      if (!raw) continue
      records.push(await this.normalizeWithClaims(raw))
    }
    return records
  }

  async claimExternalId(input: ExternalIdClaimInput): Promise<ExternalIdClaimResult> {
    let phase: "validating" | "journal_durable" | "friend_durable" | "committed" = "validating"
    try {
      if (!this.isClaimInputStructure(input)) throw new Error("external identity claim input is invalid")
      this.validateClaimInput(input)
      await this.ensureClaimsDirectory()
      const journalPath = this.pendingClaimPath(input.externalId)
      const journal = await this.readClaimIfPresent(journalPath, input.externalId)
      const existing = await this.findExactExternalId(
        input.externalId.provider,
        input.externalId.externalId,
        input.externalId.tenantId,
      )
      const targetId = input.target.kind === "link" ? input.target.friendId : input.target.record.id
      if (existing && !journal) {
        if (input.target.kind === "link" && existing.id !== targetId) {
          return this.emitClaimResult(input, { ok: false, status: "collision", existingFriendId: existing.id })
        }
        return this.emitClaimResult(input, { ok: true, status: "already_claimed", record: existing })
      }
      if (existing && journal?.state === "committed") {
        if (existing.id !== journal.friendId || existing.recordIncarnation !== journal.recordIncarnation) {
          throw new Error("external identity claim target incarnation no longer exists")
        }
        if (input.target.kind === "link" && existing.id !== targetId) {
          return this.emitClaimResult(input, { ok: false, status: "collision", existingFriendId: existing.id })
        }
        return this.emitClaimResult(input, { ok: true, status: "already_claimed", record: existing })
      }

      const requestedTarget = await this.resolveRequestedTarget(input)
      if (!requestedTarget) return this.emitClaimResult(input, { ok: false, status: "not_found" })
      const pending = journal ?? await this.createOrReadPendingClaim(input, requestedTarget)
      phase = "journal_durable"
      const pendingTarget = await this.resolveJournalTarget(pending)
      if (!pendingTarget) {
        return this.emitClaimResult(input, { ok: false, status: "not_found" })
      }
      const updated = await this.reconcileClaimedExternalIds(pendingTarget)
      phase = "friend_durable"
      await this.commitClaimIndex(pending)
      phase = "committed"

      if (input.target.kind === "link" && updated.id !== input.target.friendId) {
        return this.emitClaimResult(input, { ok: false, status: "collision", existingFriendId: updated.id })
      }
      const status = existing || updated.id !== requestedTarget.id
        ? "already_claimed"
        : input.target.kind === "create" && pending.state === "pending" && pending.targetKind === "create" && pending.createRecord.id === input.target.record.id
          ? "created"
          : "linked"
      return this.emitClaimResult(input, { ok: true, status, record: updated })
    } catch (error: unknown) {
      emitNervesEvent({
        component: "friends",
        event: "friends.external_id_claim_error",
        message: "external identity claim failed",
        level: "error",
        meta: {
          provider: this.claimInputProvider(input),
          targetKind: this.claimInputTargetKind(input),
          phase,
          /* v8 ignore next -- thrown filesystem/JSON values are Error objects; preserve a safe fallback @preserve */
          error: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }

  private normalize(raw: FriendRecord): FriendRecord {
    const trustLevel = raw.trustLevel
    const normalizedTrustLevel: TrustLevel =
      trustLevel === "family" ||
      trustLevel === "friend" ||
      trustLevel === "acquaintance" ||
      trustLevel === "stranger"
        ? trustLevel
        : DEFAULT_TRUST_LEVEL

    const kind: "human" | "agent" =
      raw.kind === "human" || raw.kind === "agent" ? raw.kind : "human"

    const agentMeta = kind === "agent" ? this.normalizeAgentMeta(raw.agentMeta) : undefined
    const admissionState = this.normalizeAdmissionState(raw.admissionState)
    const initiativePolicy = this.normalizeInitiativePolicy(raw.initiativePolicy)
    const relationshipPolicy = this.normalizeRelationshipPolicy(raw.relationshipPolicy)
    const capabilityProfileId = typeof raw.capabilityProfileId === "string" && raw.capabilityProfileId.trim()
      ? raw.capabilityProfileId.trim()
      : undefined

    return {
      id: raw.id,
      ...(typeof raw.recordIncarnation === "string" && raw.recordIncarnation ? { recordIncarnation: raw.recordIncarnation } : {}),
      recordGeneration: Number.isSafeInteger(raw.recordGeneration) && (raw.recordGeneration as number) >= 0 ? raw.recordGeneration : 0,
      name: raw.name,
      role: typeof raw.role === "string" && raw.role.trim() ? raw.role : DEFAULT_ROLE,
      trustLevel: normalizedTrustLevel,
      admissionState,
      initiativePolicy,
      relationshipPolicy,
      ...(capabilityProfileId ? { capabilityProfileId } : {}),
      connections: Array.isArray(raw.connections)
        ? raw.connections
            .filter(
              (connection): connection is { name: string; relationship: string } => (
                typeof connection === "object" &&
                connection !== null &&
                typeof (connection as { name?: unknown }).name === "string" &&
                typeof (connection as { relationship?: unknown }).relationship === "string"
              ),
            )
            .map((connection) => ({
              name: connection.name,
              relationship: connection.relationship,
            }))
        : [],
      externalIds: Array.isArray(raw.externalIds) ? raw.externalIds : [],
      tenantMemberships: Array.isArray(raw.tenantMemberships) ? raw.tenantMemberships : [],
      toolPreferences: raw.toolPreferences && typeof raw.toolPreferences === "object"
        ? raw.toolPreferences
        : {},
      notes: raw.notes && typeof raw.notes === "object" ? raw.notes : {},
      // Imported facts (the cross-agent share namespace) are preserved verbatim
      // when present. Absent on records that have never imported anything.
      ...(raw.importedNotes && typeof raw.importedNotes === "object" && !Array.isArray(raw.importedNotes)
        ? { importedNotes: raw.importedNotes }
        : {}),
      totalTokens: typeof raw.totalTokens === "number" ? raw.totalTokens : 0,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
      kind,
      agentMeta,
    }
  }

  private async normalizeWithClaims(raw: FriendRecord): Promise<FriendRecord> {
    const normalized = this.normalize(raw)
    if (!normalized.recordIncarnation) return normalized
    const claims = await this.readAllClaimsForTarget(normalized.id, normalized.recordIncarnation)
    if (claims.length === 0) return normalized
    const externalIds = [...normalized.externalIds]
    for (const claim of claims) {
      if (!externalIds.some((candidate) => this.externalIdentityKey(candidate) === this.externalIdentityKey(claim.externalId))) {
        externalIds.push(claim.externalId)
      }
    }
    return { ...normalized, externalIds }
  }

  private normalizeAdmissionState(raw: unknown): AdmissionState {
    return raw === "active" || raw === "revoked" || raw === "unverified"
      ? raw
      : DEFAULT_ADMISSION_STATE
  }

  private normalizeInitiativePolicy(raw: unknown): InitiativePolicy {
    return raw === "none" || raw === "reactive_only" || raw === "request_follow_up_only" || raw === "proactive"
      ? raw
      : DEFAULT_INITIATIVE_POLICY
  }

  private normalizeRelationshipPolicy(raw: unknown): RelationshipPolicy {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { schemaVersion: 1, version: 0, preferences: {} }
    }
    const policy = raw as Record<string, unknown>
    if (policy.schemaVersion !== 1 || !Number.isSafeInteger(policy.version) || (policy.version as number) < 0) {
      return { schemaVersion: 1, version: 0, preferences: {} }
    }
    const preferences = policy.preferences && typeof policy.preferences === "object" && !Array.isArray(policy.preferences)
      ? Object.fromEntries(
          Object.entries(policy.preferences)
            .map(([key, value]) => [key, this.normalizeRelationshipPreference(value)] as const)
            .filter((entry): entry is [string, RelationshipPolicyPreference] => entry[1] !== undefined),
        )
      : {}
    return { schemaVersion: 1, version: policy.version as number, preferences }
  }

  private normalizeRelationshipPreference(raw: unknown): RelationshipPolicyPreference | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const preference = raw as Record<string, unknown>
    if (
      (typeof preference.value !== "string" && typeof preference.value !== "number" && typeof preference.value !== "boolean") ||
      (typeof preference.value === "number" && !Number.isFinite(preference.value)) ||
      (preference.provenance !== "stated" && preference.provenance !== "observed" && preference.provenance !== "default") ||
      !Number.isSafeInteger(preference.version) ||
      (preference.version as number) < 1 ||
      typeof preference.source !== "string" ||
      !preference.source.trim() ||
      (preference.expiresAt !== undefined && (
        typeof preference.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(preference.expiresAt)) ||
        new Date(preference.expiresAt).toISOString() !== preference.expiresAt
      ))
    ) return undefined
    return {
      value: preference.value,
      provenance: preference.provenance,
      version: preference.version as number,
      source: preference.source,
      ...(typeof preference.expiresAt === "string" ? { expiresAt: preference.expiresAt } : {}),
    } as RelationshipPolicyPreference
  }

  private async findExactExternalId(
    provider: string,
    externalId: string,
    tenantId?: string,
  ): Promise<FriendRecord | null> {
    const records = await this.listAll()
    const matches = records.filter((record) => record.externalIds.some((candidate) =>
      candidate.provider === provider &&
      candidate.externalId === externalId &&
      candidate.tenantId === tenantId,
    ))
    if (matches.length > 1) throw new Error("external identity is ambiguously bound to multiple friends")
    return matches[0] ?? null
  }

  private externalIdentityKey(externalId: ExternalIdClaimInput["externalId"]): string {
    return JSON.stringify([externalId.provider, externalId.externalId, externalId.tenantId ?? null])
  }

  private externalIdentityDigest(externalId: ExternalIdClaimInput["externalId"]): string {
    return createHash("sha256").update(this.externalIdentityKey(externalId)).digest("hex")
  }

  private pendingClaimPath(externalId: ExternalIdClaimInput["externalId"]): string {
    const digest = this.externalIdentityDigest(externalId)
    return path.join(this.friendsPath, CLAIMS_DIR_NAME, `${digest}.json`)
  }

  private async createOrReadPendingClaim(
    input: ExternalIdClaimInput,
    target: FriendRecord,
  ): Promise<ExternalIdClaimJournal> {
    const claimsDir = path.join(this.friendsPath, CLAIMS_DIR_NAME)
    const claimPath = this.pendingClaimPath(input.externalId)
    const isStoreCreate = input.target.kind === "create" && !await this.getExact(target.id)
    const pending: PendingExternalIdClaim = {
      schemaVersion: 1,
      state: "pending",
      identityDigest: this.externalIdentityDigest(input.externalId),
      externalId: input.externalId,
      friendId: target.id,
      recordIncarnation: target.recordIncarnation!,
      targetKind: isStoreCreate ? "create" : "link",
      ...(isStoreCreate
        ? { createRecord: target }
        : {}),
    } as PendingExternalIdClaim
    const serialized = JSON.stringify(pending)
    const tempPath = path.join(claimsDir, `.${randomUUID()}.tmp`)
    try {
      const temp = await fsPromises.open(tempPath, "wx", 0o600)
      try {
        await temp.writeFile(serialized, "utf-8")
        await temp.sync()
      } finally {
        await temp.close()
      }
      try {
        await fsPromises.link(tempPath, claimPath)
        this.syncClaimsDirectory()
        return pending
      } catch (error: unknown) {
        /* v8 ignore next -- same-directory hard-link failures other than contention propagate unchanged @preserve */
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        return await this.readPendingClaim(claimPath, pending.identityDigest)
      }
    } finally {
      await fsPromises.rm(tempPath, { force: true })
      this.syncClaimsDirectory()
    }
  }

  private async readPendingClaim(claimPath: string, identityDigest: string): Promise<ExternalIdClaimJournal> {
    this.assertClaimsDirectoryIdentity()
    const handle = await fsPromises.open(claimPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CLAIM_BYTES || stat.mode % 0o1000 !== 0o600 || (process.getuid && stat.uid !== process.getuid())) {
      await handle.close()
      throw new Error("external identity claim journal has unsafe ownership, mode, type, or size")
    }
    let serialized: string
    try {
      serialized = await handle.readFile("utf-8")
    } finally {
      await handle.close()
    }
    this.assertClaimsDirectoryIdentity()
    const parsed = JSON.parse(serialized) as Record<string, unknown>
    const state = parsed.state
    const targetKind = parsed.targetKind
    const expectedKeys = state === "pending" && targetKind === "create"
      ? ["createRecord", "externalId", "friendId", "identityDigest", "recordIncarnation", "schemaVersion", "state", "targetKind"]
      : state === "pending" && targetKind === "link"
        ? ["externalId", "friendId", "identityDigest", "recordIncarnation", "schemaVersion", "state", "targetKind"]
        : state === "committed" && (targetKind === "create" || targetKind === "link")
          ? ["externalId", "friendId", "identityDigest", "recordIncarnation", "schemaVersion", "state", "targetKind"]
          : []
    if (
      !this.hasExactKeys(parsed, expectedKeys) ||
      parsed.schemaVersion !== 1 ||
      (state !== "pending" && state !== "committed") ||
      (targetKind !== "create" && targetKind !== "link") ||
      parsed.identityDigest !== identityDigest ||
      !this.isSafeExternalId(parsed.externalId) ||
      this.externalIdentityDigest(parsed.externalId) !== identityDigest ||
      typeof parsed.friendId !== "string" ||
      !SAFE_RECORD_ID.test(parsed.friendId) ||
      !this.isSafeRecordIncarnation(parsed.recordIncarnation) ||
      (state === "pending" && targetKind === "create" && (
        !this.isSafeJournalCreateRecord(parsed.createRecord) ||
        parsed.createRecord.id !== parsed.friendId ||
        parsed.createRecord.recordIncarnation !== parsed.recordIncarnation
      )) ||
      (state !== "pending" || targetKind !== "create") && parsed.createRecord !== undefined
    ) {
      throw new Error("external identity claim journal is invalid")
    }
    return parsed as unknown as ExternalIdClaimJournal
  }

  private async commitClaimIndex(
    pending: ExternalIdClaimJournal,
  ): Promise<void> {
    const claimPath = this.pendingClaimPath(pending.externalId)
    const tempPath = `${claimPath}.${randomUUID()}.tmp`
    const committed: CommittedExternalIdClaim = {
      schemaVersion: 1,
      state: "committed",
      identityDigest: pending.identityDigest,
      externalId: pending.externalId,
      friendId: pending.friendId,
      recordIncarnation: pending.recordIncarnation,
      targetKind: pending.targetKind,
    }
    try {
      const temp = await fsPromises.open(tempPath, "wx", 0o600)
      try {
        await temp.writeFile(JSON.stringify(committed), "utf-8")
        await temp.sync()
      } finally {
        await temp.close()
      }
      await fsPromises.rename(tempPath, claimPath)
      this.syncClaimsDirectory()
    } finally {
      await fsPromises.rm(tempPath, { force: true })
      this.syncClaimsDirectory()
    }
  }

  private validateClaimInput(input: ExternalIdClaimInput): void {
    if (input.target.kind === "create" && !this.isSafeCreateCandidate(input.target.record)) {
      throw new Error("external identity create candidate is invalid")
    }
    const id = input.target.kind === "link" ? input.target.friendId : input.target.record.id
    if (!SAFE_RECORD_ID.test(id)) throw new Error("external identity claim target id is invalid")
    if (!this.isSafeExternalId(input.externalId)) throw new Error("external identity claim is invalid")
  }

  private isClaimInputStructure(input: unknown): input is ExternalIdClaimInput {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false
    const candidate = input as Record<string, unknown>
    if (!this.hasExactKeys(candidate, ["externalId", "target"]) || !candidate.target || typeof candidate.target !== "object" || Array.isArray(candidate.target)) return false
    const target = candidate.target as Record<string, unknown>
    return target.kind === "create"
      ? this.hasExactKeys(target, ["kind", "record"])
      : target.kind === "link" && this.hasExactKeys(target, ["friendId", "kind"]) && typeof target.friendId === "string"
  }

  private claimInputProvider(input: unknown): string {
    if (!input || typeof input !== "object" || Array.isArray(input)) return "invalid"
    const externalId = (input as Record<string, unknown>).externalId
    return externalId && typeof externalId === "object" && !Array.isArray(externalId) && typeof (externalId as Record<string, unknown>).provider === "string"
      ? (externalId as Record<string, unknown>).provider as string
      : "invalid"
  }

  private claimInputTargetKind(input: unknown): string {
    if (!input || typeof input !== "object" || Array.isArray(input)) return "invalid"
    const target = (input as Record<string, unknown>).target
    return target && typeof target === "object" && !Array.isArray(target) && ((target as Record<string, unknown>).kind === "create" || (target as Record<string, unknown>).kind === "link")
      ? (target as Record<string, unknown>).kind as string
      : "invalid"
  }

  private isSafeCreateCandidate(record: unknown): boolean {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false
    const candidate = record as Partial<FriendRecord>
    return typeof candidate.id === "string" &&
      SAFE_RECORD_ID.test(candidate.id) &&
      typeof candidate.name === "string" &&
      candidate.name.trim().length > 0 &&
      candidate.name.length <= 256 &&
      candidate.recordIncarnation === undefined &&
      candidate.recordGeneration === undefined &&
      (candidate.trustLevel === undefined || candidate.trustLevel === "stranger") &&
      (candidate.admissionState === undefined || candidate.admissionState === "unverified") &&
      (candidate.initiativePolicy === undefined || candidate.initiativePolicy === "none") &&
      (candidate.relationshipPolicy === undefined || this.isEmptyRelationshipPolicy(candidate.relationshipPolicy)) &&
      candidate.capabilityProfileId === undefined &&
      (candidate.externalIds === undefined || (Array.isArray(candidate.externalIds) && candidate.externalIds.length === 0)) &&
      (candidate.tenantMemberships === undefined || (Array.isArray(candidate.tenantMemberships) && candidate.tenantMemberships.length === 0)) &&
      (candidate.toolPreferences === undefined || this.isEmptyRecord(candidate.toolPreferences)) &&
      (candidate.notes === undefined || this.isEmptyRecord(candidate.notes)) &&
      (candidate.connections === undefined || candidate.connections.length === 0) &&
      candidate.importedNotes === undefined &&
      candidate.agentMeta === undefined &&
      (candidate.kind === undefined || candidate.kind === "human") &&
      (candidate.totalTokens === undefined || candidate.totalTokens === 0)
  }

  private isSafeJournalCreateRecord(record: unknown): record is FriendRecord {
    if (!record || typeof record !== "object" || Array.isArray(record)) return false
    const candidate = record as Record<string, unknown>
    const expectedKeys = ["admissionState", "connections", "createdAt", "externalIds", "id", "initiativePolicy", "kind", "name", "notes", "recordGeneration", "recordIncarnation", "relationshipPolicy", "role", "schemaVersion", "tenantMemberships", "toolPreferences", "totalTokens", "trustLevel", "updatedAt"]
    return this.hasExactKeys(candidate, expectedKeys) &&
      typeof candidate.id === "string" &&
      SAFE_RECORD_ID.test(candidate.id) &&
      typeof candidate.recordIncarnation === "string" &&
      this.isSafeRecordIncarnation(candidate.recordIncarnation) &&
      Number.isSafeInteger(candidate.recordGeneration) &&
      (candidate.recordGeneration as number) >= 0 &&
      typeof candidate.name === "string" &&
      candidate.name.length > 0 &&
      candidate.name.length <= 256 &&
      candidate.name === candidate.name.trim() &&
      candidate.role === "friend" &&
      candidate.trustLevel === "stranger" &&
      candidate.admissionState === "unverified" &&
      candidate.initiativePolicy === "none" &&
      this.isEmptyRelationshipPolicy(candidate.relationshipPolicy) &&
      Array.isArray(candidate.connections) && candidate.connections.length === 0 &&
      Array.isArray(candidate.externalIds) && candidate.externalIds.length === 0 &&
      Array.isArray(candidate.tenantMemberships) && candidate.tenantMemberships.length === 0 &&
      this.isEmptyRecord(candidate.toolPreferences) &&
      this.isEmptyRecord(candidate.notes) &&
      candidate.totalTokens === 0 &&
      candidate.schemaVersion === 1 &&
      candidate.kind === "human" &&
      this.isCanonicalTimestamp(candidate.createdAt) &&
      this.isCanonicalTimestamp(candidate.updatedAt)
  }

  private isSafeExternalId(externalId: unknown): externalId is ExternalIdClaimInput["externalId"] {
    if (!externalId || typeof externalId !== "object" || Array.isArray(externalId)) return false
    const candidate = externalId as Record<string, unknown>
    const expectedKeys = candidate.tenantId === undefined
      ? ["externalId", "linkedAt", "provider"]
      : ["externalId", "linkedAt", "provider", "tenantId"]
    return this.hasExactKeys(candidate, expectedKeys) &&
      isIdentityProvider(candidate.provider) &&
      typeof candidate.externalId === "string" &&
      candidate.externalId.length > 0 &&
      candidate.externalId.length <= 512 &&
      (candidate.tenantId === undefined || (typeof candidate.tenantId === "string" && candidate.tenantId.length > 0 && candidate.tenantId.length <= 512)) &&
      typeof candidate.linkedAt === "string" &&
      Number.isFinite(Date.parse(candidate.linkedAt)) &&
      new Date(candidate.linkedAt).toISOString() === candidate.linkedAt
  }

  private isSafeRecordIncarnation(value: unknown): value is string {
    return typeof value === "string" && value.length <= 64 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  }

  private isCanonicalTimestamp(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
  }

  private isEmptyRelationshipPolicy(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const policy = value as Record<string, unknown>
    return this.hasExactKeys(policy, ["preferences", "schemaVersion", "version"]) &&
      policy.schemaVersion === 1 &&
      policy.version === 0 &&
      this.isEmptyRecord(policy.preferences)
  }

  private isEmptyRecord(value: unknown): boolean {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0
  }

  private hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
    return expected.length > 0 && Object.keys(value).sort().join("\u0000") === [...expected].sort().join("\u0000")
  }

  private async ensureClaimsDirectory(): Promise<void> {
    this.assertFriendsDirectoryIdentity()
    const claimsDir = path.join(this.friendsPath, CLAIMS_DIR_NAME)
    await fsPromises.mkdir(claimsDir, { recursive: true, mode: 0o700 })
    this.assertPrivateClaimsDirectory(await fsPromises.lstat(claimsDir))
    if (this.claimsDirectoryFd === undefined) {
      const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      this.claimsDirectoryFd = fs.openSync(claimsDir, flags)
      const retained = fs.fstatSync(this.claimsDirectoryFd)
      this.claimsDirectoryIdentity = { dev: retained.dev, ino: retained.ino }
    }
    this.assertClaimsDirectoryIdentity()
    this.syncFriendsDirectory()
  }

  private assertPrivateClaimsDirectory(stat: fs.Stats): void {
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode % 0o1000 !== 0o700 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("external identity claims directory has unsafe ownership, mode, or type")
    }
  }

  private assertFriendsDirectoryIdentity(): void {
    const retained = fs.fstatSync(this.friendsDirectoryFd)
    const current = fs.lstatSync(this.friendsPath)
    if (
      !retained.isDirectory() ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      retained.dev !== this.friendsDirectoryIdentity.dev ||
      retained.ino !== this.friendsDirectoryIdentity.ino ||
      current.dev !== this.friendsDirectoryIdentity.dev ||
      current.ino !== this.friendsDirectoryIdentity.ino
    ) throw Object.assign(new Error("friends directory identity changed or became unsafe"), { code: "ENOTDIR" })
  }

  private assertClaimsDirectoryIdentity(): void {
    this.assertFriendsDirectoryIdentity()
    const retained = fs.fstatSync(this.claimsDirectoryFd!)
    const current = fs.lstatSync(path.join(this.friendsPath, CLAIMS_DIR_NAME))
    this.assertPrivateClaimsDirectory(current)
    if (
      retained.dev !== this.claimsDirectoryIdentity!.dev ||
      retained.ino !== this.claimsDirectoryIdentity!.ino ||
      current.dev !== this.claimsDirectoryIdentity!.dev ||
      current.ino !== this.claimsDirectoryIdentity!.ino
    ) throw new Error("external identity claims directory identity changed")
  }

  private syncFriendsDirectory(): void {
    this.assertFriendsDirectoryIdentity()
    fs.fsyncSync(this.friendsDirectoryFd)
    this.assertFriendsDirectoryIdentity()
  }

  private syncClaimsDirectory(): void {
    this.assertClaimsDirectoryIdentity()
    fs.fsyncSync(this.claimsDirectoryFd!)
    this.assertClaimsDirectoryIdentity()
  }

  private async readClaimIfPresent(
    claimPath: string,
    externalId: ExternalIdClaimInput["externalId"],
  ): Promise<ExternalIdClaimJournal | undefined> {
    try {
      return await this.readPendingClaim(claimPath, this.externalIdentityDigest(externalId))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  private async resolveRequestedTarget(input: ExternalIdClaimInput): Promise<FriendRecord | null> {
    if (input.target.kind === "link") {
      const target = await this.getExact(input.target.friendId)
      if (!target) return null
      if (!target.recordIncarnation) throw new Error("friend record needs an incarnation before linking an external identity")
      return target
    }
    const existing = await this.getExact(input.target.record.id)
    if (existing) {
      if (!existing.recordIncarnation) throw new Error("friend record needs an incarnation before linking an external identity")
      return existing
    }
    const now = new Date().toISOString()
    return this.normalize({
      id: input.target.record.id,
      name: input.target.record.name.trim(),
      recordIncarnation: randomUUID(),
      recordGeneration: 0,
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
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
      kind: "human",
    })
  }

  private async resolveJournalTarget(pending: ExternalIdClaimJournal): Promise<FriendRecord | null> {
    const target = await this.getExact(pending.friendId) ?? (pending.state === "pending" && pending.targetKind === "create" ? pending.createRecord : null)
    if (target && target.recordIncarnation !== pending.recordIncarnation) {
      throw new Error("external identity claim target incarnation no longer exists")
    }
    return target
  }

  private async readAllClaimsForTarget(friendId: string, recordIncarnation: string): Promise<ExternalIdClaimJournal[]> {
    const claimsDir = path.join(this.friendsPath, CLAIMS_DIR_NAME)
    try {
      if (this.claimsDirectoryFd === undefined) {
        this.assertPrivateClaimsDirectory(await fsPromises.lstat(claimsDir))
        const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        this.claimsDirectoryFd = fs.openSync(claimsDir, flags)
        const retained = fs.fstatSync(this.claimsDirectoryFd)
        this.claimsDirectoryIdentity = { dev: retained.dev, ino: retained.ino }
      }
      this.assertClaimsDirectoryIdentity()
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const entries = await fsPromises.readdir(claimsDir)
    this.assertClaimsDirectoryIdentity()
    const claims: ExternalIdClaimJournal[] = []
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue
      const claim = await this.readPendingClaim(path.join(claimsDir, entry), entry.slice(0, -5))
      if (claim.friendId === friendId && claim.recordIncarnation === recordIncarnation) claims.push(claim)
    }
    return claims
  }

  private async reconcileClaimedExternalIds(target: FriendRecord): Promise<FriendRecord> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const current = await this.getExact(target.id) ?? target
      if (current.recordIncarnation !== target.recordIncarnation) {
        throw new Error("external identity claim target incarnation changed during commit")
      }
      const claims = await this.readAllClaimsForTarget(target.id, target.recordIncarnation!)
      const externalIds = [...current.externalIds]
      for (const claim of claims) {
        if (!externalIds.some((candidate) => this.externalIdentityKey(candidate) === this.externalIdentityKey(claim.externalId))) {
          externalIds.push(claim.externalId)
        }
      }
      const updated = this.normalize({
        ...current,
        externalIds,
        recordGeneration: current.recordGeneration! + 1,
        updatedAt: new Date().toISOString(),
      })
      await this.writeJson(path.join(this.friendsPath, `${updated.id}.json`), updated)
      const verified = await this.getExact(updated.id)
      const latestClaims = await this.readAllClaimsForTarget(updated.id, updated.recordIncarnation!)
      if (verified && latestClaims.every((claim) => verified.externalIds.some((candidate) => this.externalIdentityKey(candidate) === this.externalIdentityKey(claim.externalId)))) {
        return verified
      }
    }
    throw new Error("external identity claims did not converge")
  }

  private emitClaimResult(
    input: ExternalIdClaimInput,
    result: ExternalIdClaimResult,
  ): ExternalIdClaimResult {
    emitNervesEvent({
      component: "friends",
      event: "friends.external_id_claim_result",
      message: "external identity claim completed",
      meta: { provider: input.externalId.provider, targetKind: input.target.kind, status: result.status },
    })
    return result
  }

  private normalizeAgentMeta(raw: unknown): AgentMeta | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const meta = raw as Record<string, unknown>
    if (typeof meta.bundleName !== "string") return undefined

    // Mailbox is top-level on AgentMeta since the phase-8 demote. Read the
    // top-level `meta.mailbox` first; if absent, MIGRATE-ON-READ from a legacy
    // alpha.4 record that nested it under `a2a.mailbox`. schemaVersion stays 1;
    // every legacy record reads clean.
    const a2aRaw = meta.a2a && typeof meta.a2a === "object" && !Array.isArray(meta.a2a)
      ? (meta.a2a as Record<string, unknown>)
      : undefined
    const mailbox =
      this.normalizeMailbox(meta.mailbox) ??
      (a2aRaw ? this.normalizeMailbox(a2aRaw.mailbox) : undefined)

    const a2a = this.normalizeA2AMeta(meta.a2a)
    return {
      bundleName: meta.bundleName,
      familiarity: typeof meta.familiarity === "number" ? meta.familiarity : 0,
      sharedMissions: Array.isArray(meta.sharedMissions) ? meta.sharedMissions : [],
      outcomes: Array.isArray(meta.outcomes) ? meta.outcomes : [],
      ...(a2a ? { a2a } : {}),
      ...(mailbox ? { mailbox } : {}),
    }
  }

  private normalizeA2AMeta(raw: unknown): AgentMeta["a2a"] | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const meta = raw as Record<string, unknown>
    const relay = this.normalizeRelay(meta.relay)
    const a2a = {
      ...(typeof meta.cardUrl === "string" ? { cardUrl: meta.cardUrl } : {}),
      ...(typeof meta.endpointUrl === "string" ? { endpointUrl: meta.endpointUrl } : {}),
      ...(typeof meta.agentId === "string" ? { agentId: meta.agentId } : {}),
      ...(typeof meta.protocolVersion === "string" ? { protocolVersion: meta.protocolVersion } : {}),
      ...(relay ? { relay } : {}),
      ...(typeof meta.did === "string" ? { did: meta.did } : {}),
    }
    return Object.keys(a2a).length > 0 ? a2a : undefined
  }

  /** Preserve the top-level mailbox coord only when both fields are strings;
   * otherwise drop it (absent ⇒ unchanged — the additive guarantee). Also used to
   * migrate a legacy nested `a2a.mailbox`. */
  private normalizeMailbox(raw: unknown): { repo: string; selfOutboxAgentId: string } | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const m = raw as Record<string, unknown>
    if (typeof m.repo !== "string" || typeof m.selfOutboxAgentId !== "string") return undefined
    return { repo: m.repo, selfOutboxAgentId: m.selfOutboxAgentId }
  }

  /** Preserve an additive a2a.relay coord only when both fields are strings;
   * otherwise drop it (absent ⇒ unchanged — the additive guarantee). */
  private normalizeRelay(raw: unknown): { url: string; handle: string } | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const r = raw as Record<string, unknown>
    if (typeof r.url !== "string" || typeof r.handle !== "string") return undefined
    return { url: r.url, handle: r.handle }
  }

  private async readJson(filePath: string): Promise<FriendRecord | null> {
    this.assertFriendsDirectoryIdentity()
    try {
      const handle = await fsPromises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("friend record file is unsafe")
        let parsed: unknown
        try {
          parsed = JSON.parse(await handle.readFile("utf-8"))
        } catch {
          return null
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
        return parsed as FriendRecord
      } finally {
        await handle.close()
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return null
    } finally {
      this.assertFriendsDirectoryIdentity()
    }
  }

  private async getExact(id: string): Promise<FriendRecord | null> {
    const record = await this.readJson(path.join(this.friendsPath, `${id}.json`))
    return record ? await this.normalizeWithClaims(record) : null
  }

  private async writeJson(filePath: string, data: FriendRecord): Promise<void> {
    this.assertFriendsDirectoryIdentity()
    const notes = Object.fromEntries(Object.entries(data.notes).map(([key, note]) => [
      key,
      {
        ...note,
        value: capStructuredRecordString(note.value),
      },
    ]))
    const tempPath = `${filePath}.${randomUUID()}.tmp`
    try {
      const temp = await fsPromises.open(tempPath, "wx", 0o600)
      try {
        await temp.writeFile(JSON.stringify({ ...data, notes }, null, 2), "utf-8")
        await temp.sync()
      } finally {
        await temp.close()
      }
      this.assertFriendsDirectoryIdentity()
      await fsPromises.rename(tempPath, filePath)
      this.syncFriendsDirectory()
    } finally {
      await fsPromises.rm(tempPath, { force: true })
      this.syncFriendsDirectory()
    }
  }

  private async removeFile(filePath: string): Promise<void> {
    this.assertFriendsDirectoryIdentity()
    try {
      await fsPromises.unlink(filePath)
      this.syncFriendsDirectory()
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return
      throw err
    }
  }
}
