// FriendResolver -- resolves external identity into a FriendRecord + channel capabilities.
// Created per-request (per-incoming-message), per-friend.
// Replaces the old ContextResolver: no authority checker, no separate note resolution.

import { randomUUID } from "crypto"
import { userInfo } from "os"
import type { FriendStore } from "./store"
import type { IdentityProvider, FriendRecord, ResolvedContext, ExternalId } from "./types"
import { getChannelCapabilities } from "./channel"
import { emitNervesEvent } from "./observability"
import type { RosterStore } from "./roster-store"
import type { RosterVerifier } from "./roster-verifier"
// NOTE (Unit 9a→9b): `evaluateAccountMembership` is imported + wired into the
// create-new branch in 9b (GREEN). In 9a the roster context is accepted but not yet
// consulted (the RED state), so the value import is deferred to keep noUnusedLocals
// happy while the tests are RED.

/** Optional roster context for a cold-contact resolution (Bug C). When supplied AND
 * the candidate's `did` is a key-verified member of the pinned account roster, the
 * resolver seats `family` (attributable to `same_account`) even when the peer is on
 * a different OS user. Constructor-injected (not a `resolve()` arg) so existing
 * `new FriendResolver(store, params)` call sites stay source-compatible. The
 * resolver stays core-clean: the Ed25519 `verifier` arrives via the seam — never an
 * a2a-client import. */
export interface FriendResolverRosterContext {
  store: RosterStore
  accountId: string
  candidateDid: string
  verifier?: RosterVerifier
}

export interface FriendResolverParams {
  provider: IdentityProvider
  externalId: string
  tenantId?: string
  displayName: string
  channel: string
}

const CURRENT_SCHEMA_VERSION = 1

// Test seam: when set (including to null), overrides OS detection of the
// machine-owner username so resolver tests are deterministic.
let machineOwnerOverride: string | null | undefined
export function _setMachineOwnerUsernameForTest(value: string | null | undefined): void {
  machineOwnerOverride = value
}

/**
 * The OS username that owns this daemon process, or null if undetectable. The
 * person running the daemon owns this agent + its bundle, so the local friend
 * that names them is the machine owner (family), not a stranger.
 */
export function machineOwnerUsername(): string | null {
  if (machineOwnerOverride !== undefined) return machineOwnerOverride
  try {
    return userInfo().username
  } catch {
    /* v8 ignore next -- defensive: userInfo() only throws when the running user has no passwd entry @preserve */
    return null
  }
}

/**
 * True when (provider, externalId) names the local machine owner — the OS user
 * running the daemon. Matches the bare username or a `user@host` external id.
 */
export function isLocalMachineOwnerIdentity(
  provider: string,
  externalId: string,
  ownerUsername: string | null,
): boolean {
  if (provider !== "local" || !ownerUsername) return false
  return externalId === ownerUsername || externalId.startsWith(`${ownerUsername}@`)
}

export class FriendResolver {
  private readonly store: FriendStore
  private readonly params: FriendResolverParams
  private readonly roster?: FriendResolverRosterContext

  constructor(store: FriendStore, params: FriendResolverParams, roster?: FriendResolverRosterContext) {
    this.store = store
    this.params = params
    this.roster = roster
  }

  async resolve(): Promise<ResolvedContext> {
    const friend = await this.resolveOrCreate()
    const channel = getChannelCapabilities(this.params.channel)
    return { friend, channel }
  }

  private async resolveOrCreate(): Promise<FriendRecord> {
    // Try to find existing friend by external ID
    let existing: FriendRecord | null = null
    try {
      existing = await this.store.findByExternalId(
        this.params.provider,
        this.params.externalId,
        this.params.tenantId,
      )
    } catch {
      // Store search failure -- fall through to create new (D16)
    }

    if (existing) return existing

    // Migration: local provider previously used "${username}@${hostname}" format.
    // If no exact match, try finding a friend with old-format external ID.
    /* v8 ignore start -- migration path: only fires when legacy hostname-format friend exists @preserve */
    if (this.params.provider === "local" && !this.params.externalId.includes("@")) {
      try {
        const all = typeof this.store.listAll === "function" ? await this.store.listAll() : []
        /* v8 ignore start -- migration path: only fires when legacy hostname-format friend exists @preserve */
        const migrationMatch = all.find((f) =>
          f.externalIds.some(
            (eid) => eid.provider === "local" && eid.externalId.startsWith(this.params.externalId + "@"),
          ),
        )
        if (migrationMatch) {
          const now = new Date().toISOString()
          migrationMatch.externalIds.push({
            provider: this.params.provider,
            externalId: this.params.externalId,
            linkedAt: now,
          })
          migrationMatch.updatedAt = now
          try {
            await this.store.put(migrationMatch.id, migrationMatch)
          } catch {
            // best-effort persist
          }
          emitNervesEvent({
            component: "friends",
            event: "friends.local_id_migrated",
            message: `migrated local friend identity from hostname format to username-only`,
            meta: { friendId: migrationMatch.id, newExternalId: this.params.externalId },
          })
          return migrationMatch
        }
        /* v8 ignore stop */
      } catch {
        // fall through to create new
      }
    }
    /* v8 ignore stop */

    // First encounter -- create new FriendRecord
    const now = new Date().toISOString()
    const externalId: ExternalId = {
      provider: this.params.provider,
      externalId: this.params.externalId,
      linkedAt: now,
      ...(this.params.tenantId !== undefined ? { tenantId: this.params.tenantId } : {}),
    }

    const tenantMemberships: string[] =
      this.params.tenantId ? [this.params.tenantId] : []

    let hasAnyFriends = false
    try {
      if (typeof this.store.hasAnyFriends === "function") {
        hasAnyFriends = await this.store.hasAnyFriends()
      }
    } catch {
      hasAnyFriends = false
    }

    const isFirstImprint = !hasAnyFriends
    const isA2AAgent = this.params.provider === "a2a-agent"
    // Unit 9a RED state: the roster context is accepted but NOT yet consulted (the
    // create-new branch still uses the OS-owner + cold-A2A default unchanged). 9b
    // wires `evaluateAccountMembership` here. The `void` keeps the field "read" so
    // the stub compiles while the roster-awareness tests are RED.
    void this.roster
    // The local friend that names the OS user running the daemon is the machine
    // owner (family) — they own the agent + its bundle. Usually this friend already
    // exists as a family/primary hatch imprint; this covers the un-imprinted boss
    // path (e.g. a Workbench boss check-in on a bundle that skipped imprint).
    const isLocalMachineOwner = isLocalMachineOwnerIdentity(
      this.params.provider,
      this.params.externalId,
      machineOwnerUsername(),
    )

    // BlueBubbles group chats route through here as `imessage-handle` with an
    // externalId of the form `group:any;+;<chatHash>`. When the harness auto-
    // creates the group friend at stranger trust, we mark the record so that
    // the trust gate can surface the relationship for explicit acknowledgment
    // later instead of letting messages accumulate silently.
    const isImessageGroup =
      this.params.provider === "imessage-handle" &&
      typeof this.params.externalId === "string" &&
      this.params.externalId.startsWith("group:")
    const notes: Record<string, { value: string; savedAt: string }> = {}
    if (this.params.displayName !== "Unknown") {
      notes.name = { value: this.params.displayName, savedAt: now }
    }
    if (isImessageGroup && !isFirstImprint) {
      notes.autoCreatedGroup = { value: "true", savedAt: now }
    }

    const friend: FriendRecord = {
      id: randomUUID(),
      name: this.params.displayName,
      role: isA2AAgent ? "agent-peer" : isFirstImprint ? "primary" : isLocalMachineOwner ? "family" : "stranger",
      trustLevel: isA2AAgent ? "stranger" : (isFirstImprint || isLocalMachineOwner) ? "family" : "stranger",
      connections: [],
      externalIds: [externalId],
      tenantMemberships,
      toolPreferences: {},
      notes,
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      kind: isA2AAgent ? "agent" : "human",
      ...(isA2AAgent ? {
        agentMeta: {
          bundleName: this.params.displayName,
          familiarity: 0,
          sharedMissions: [],
          outcomes: [],
          a2a: { agentId: this.params.externalId },
        },
      } : {}),
    }

    // Persist -- log and continue on failure (D16)
    try {
      await this.store.put(friend.id, friend)
    } catch (err) {
      emitNervesEvent({
        level: "error",
        event: "friends.persist_error",
        component: "friends",
        message: "failed to persist friend record",
        meta: { reason: err instanceof Error ? err.message : String(err) },
      })
    }

    return friend
  }
}
