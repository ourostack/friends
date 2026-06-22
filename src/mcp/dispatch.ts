// Tool dispatch for the friends MCP server.
//
// MCP sends string-ish args; the coercion helpers normalize them before calling
// the library fns. `dispatchTool` is a flat tool → library-fn map (D9/D10) with
// NO domain logic of its own — every behavior lives in the friends library.
import { emitNervesEvent } from "../observability"
import type { FriendStore } from "../store"
import type { GrantStore } from "../grant-store"
import type { MissionStore } from "../mission-store"
import type { AuditSink, ControlPlaneAuditRecord } from "../audit"
import { resolveAgentIdentity } from "../identity"
import type { IdentityProvider, TrustLevel, NoteProvenance, AgentMeta, ShareScope, AgentAttribution } from "../types"
import { isShareScope } from "../types"
import { FriendResolver } from "../resolver"
import { describeTrustContext } from "../trust-explanation"
import { assessStanding, explainStanding } from "../standing"
import { getChannelCapabilities } from "../channel"
import { upsertGroupContextParticipants } from "../group-context"
import type { GroupContextParticipant } from "../group-context"
import { accumulateFriendTokens } from "../tokens"
import type { UsageData } from "../tokens"
import { applyFriendNote } from "../notes"
import { setFriendTrust } from "../trust-mutation"
import { linkExternalId, unlinkExternalId } from "../link-identity"
import { upsertAgentPeer } from "../agent-peer"
import { recordRelationshipOutcome } from "../outcomes"
import { whoami } from "../whoami"
import { resolveRoom } from "../room"
import { prepareProfileShare, importProfileShare } from "../share"
import type { ProfileShareEnvelope } from "../share"
import { grantShare, revokeShare, listShares } from "../grants"
import { recordMission } from "../missions"
import type { RecordMissionInput } from "../missions"
import { prepareMissionShare, importMissionShare } from "../mission-share"
import type { MissionShareEnvelope } from "../mission-share"
import { prepareCoordination, importCoordination } from "../coordination"
import type { CoordinationEnvelope } from "../coordination"
import { isCoordinationIntent } from "../types"
import { connectAgents } from "../connect"
import type { SenseType } from "../types"
import type { AccountMembershipResult } from "../account-roster"

type Args = Record<string, unknown>

export interface DispatchResult {
  result: unknown
  isError: boolean
}

/** WHO/WHENCE context stamped onto a control-plane audit record (finding 3). The MCP
 * server passes the local owner/sense it was constructed with. */
export interface ControlPlaneContext {
  actor?: string
  originSense?: string
  /** The management SENSE the gate evaluates for `connect_to` (p11 inc2, brick 8).
   * The stdio path is owner-only, so this defaults to `local` (`?? "local"`) — a
   * `local` management sense COMMITS. A network/multi-tenant transport that constructs
   * the server MUST pass its real senseType (`open` ⇒ confirm-prompt downgrade; `closed`
   * ⇒ gated by `membership`). Distinct from `originSense` (a free-form audit string like
   * "stdio"); this is the typed SenseType the authority predicate consumes. */
  senseType?: SenseType
  /** The PRE-COMPUTED account-roster membership for a `closed`-sense `connect_to`
   * (p11 inc2). The stdio `local` path never consults it (left `undefined`); a `closed`
   * network transport supplies the membership it already evaluated against the roster.
   * The boundary stays thin — it forwards this to the library, computing no membership
   * itself (the MCP `resolve_party` path does not wire a roster context). */
  membership?: AccountMembershipResult
}

/** SECURITY (finding 3-A): the friends MCP server speaks JSON-RPC over **stdio**, and
 * stdio is an owner-only channel — the local user who launched the process is the only
 * actor. So when no explicit controlContext is wired, audited mutations are attributed
 * to the stdio owner boundary rather than the generic "unknown". A network/multi-tenant
 * transport MUST pass its own authenticated actor instead of relying on these. */
const STDIO_OWNER_ACTOR = "owner:stdio"
const STDIO_ORIGIN_SENSE = "stdio"

/** Whether wiring an AuditSink should also stamp a record for an `onboard_agent` trust
 * seat: only when the owner explicitly set a trustLevel (a deliberate trust decision).
 * A cold contact with no trustLevel lands at the safe `stranger` default (Bug A) and is
 * NOT an owner trust mutation, so it is not audited. */

export function coerceBool(v: unknown): boolean {
  return v === true || v === "true"
}

export function coerceInt(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  const n = typeof v === "number" ? v : parseInt(String(v), 10)
  return Number.isNaN(n) ? undefined : n
}

export function coerceString(v: unknown): string {
  return typeof v === "string" ? v : ""
}

export function coerceOptionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Parse a value that may be a JSON-string-encoded object/array. Returns
 * undefined when the value is absent or the string fails to parse (guarded). */
function parseMaybeJson<T>(v: unknown): T | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T
    } catch {
      return undefined
    }
  }
  return v as T
}

/** A grant-backed tool was called without a GrantStore wired (a store-only
 * embedding). The consent surface needs grant persistence, so report it cleanly
 * rather than guessing. */
const NO_GRANT_STORE = { ok: false, status: "unsupported", message: "no grant store configured (consent/share tools require one)" } as const

/** A mission-backed tool was called without a MissionStore wired (a store-only
 * embedding). The mission ledger needs mission persistence, so report it cleanly
 * rather than guessing. */
const NO_MISSION_STORE = { ok: false, status: "unsupported", message: "no mission store configured (mission tools require one)" } as const

export async function dispatchTool(
  store: FriendStore,
  name: string,
  args: Args,
  grants?: GrantStore,
  missions?: MissionStore,
  audit?: AuditSink,
  controlContext?: ControlPlaneContext,
): Promise<DispatchResult> {
  emitNervesEvent({
    component: "clients",
    event: "clients.mcp_dispatch",
    message: "dispatching friends mcp tool",
    meta: { tool: name },
  })

  // SECURITY (finding 3 / 3-A): resolve the WHO/WHENCE for an audited mutation. With
  // no explicit context, attribute to the stdio owner boundary (the only actor on an
  // owner-only stdio channel) rather than the generic "unknown".
  const auditActor = controlContext?.actor ?? STDIO_OWNER_ACTOR
  const auditOriginSense = controlContext?.originSense ?? STDIO_ORIGIN_SENSE

  switch (name) {
    case "resolve_party": {
      const provider = coerceString(args.provider) as IdentityProvider
      const externalId = coerceString(args.externalId)
      const tenantId = coerceOptionalString(args.tenantId)
      const displayName = coerceString(args.displayName) || "Unknown"
      const channel = coerceString(args.channel)
      const existing = await store.findByExternalId(provider, externalId, tenantId)
      const created = existing === null
      const resolved = await new FriendResolver(store, { provider, externalId, tenantId, displayName, channel }).resolve()
      return { result: { friend: resolved.friend, channel: resolved.channel, created }, isError: false }
    }

    case "describe_trust": {
      const friend = await store.get(coerceString(args.friendId))
      if (!friend) {
        return { result: { ok: false, status: "not_found", message: "friend record not found" }, isError: true }
      }
      const explanation = describeTrustContext({
        friend,
        channel: coerceString(args.channel) as Parameters<typeof describeTrustContext>[0]["channel"],
        isGroupChat: coerceBool(args.isGroupChat),
      })
      return { result: explanation, isError: false }
    }

    case "assess_standing": {
      // Pure read mirroring describe_trust: resolve the record, run the store-free
      // assessment, return the value. No rule injected at the boundary — the tool
      // uses DEFAULT_STANDING_RULE via the fn's `rule ?? DEFAULT` fallback. Never
      // writes trust; never produces a wire artifact.
      const friend = await store.get(coerceString(args.friendId))
      if (!friend) {
        return { result: { ok: false, status: "not_found", message: "friend record not found" }, isError: true }
      }
      return { result: assessStanding(friend), isError: false }
    }

    case "explain_standing": {
      const friend = await store.get(coerceString(args.friendId))
      if (!friend) {
        return { result: { ok: false, status: "not_found", message: "friend record not found" }, isError: true }
      }
      return { result: explainStanding(friend), isError: false }
    }

    case "get_friend": {
      const friend = await store.get(coerceString(args.friendId))
      if (!friend) {
        return { result: { ok: false, status: "not_found", message: "friend record not found" }, isError: true }
      }
      return { result: friend, isError: false }
    }

    case "list_friends": {
      const all = typeof store.listAll === "function" ? await store.listAll() : []
      const trust = coerceOptionalString(args.trust)
      const kind = coerceOptionalString(args.kind)
      const limit = coerceInt(args.limit)
      let filtered = all
      if (trust !== undefined) filtered = filtered.filter((f) => f.trustLevel === trust)
      if (kind !== undefined) filtered = filtered.filter((f) => f.kind === kind)
      if (limit !== undefined) filtered = filtered.slice(0, limit)
      return { result: filtered, isError: false }
    }

    case "save_note": {
      const type = coerceString(args.type)
      // The library helper takes a typed `type` union; the MCP boundary validates
      // the raw string here so an unknown type is a clean `invalid` result
      // rather than garbage written under an undefined key.
      if (type !== "name" && type !== "tool_preference" && type !== "note") {
        return {
          result: { ok: false, status: "invalid", message: `unrecognized note type '${type}' — use name, tool_preference, or note` },
          isError: true,
        }
      }
      const result = await applyFriendNote(store, coerceString(args.friendId), {
        type,
        key: coerceOptionalString(args.key),
        content: coerceString(args.content),
        override: coerceBool(args.override),
        provenance: parseMaybeJson<NoteProvenance>(args.provenance),
      })
      return { result, isError: result.ok === false }
    }

    case "record_interaction": {
      const friendId = coerceString(args.friendId)
      const usage = parseMaybeJson<UsageData>(args.usage)
      const outcome = parseMaybeJson<{ missionId: string; result: "success" | "partial" | "failed"; note?: string; provenance?: NoteProvenance }>(args.outcome)
      const familiarityDelta = coerceInt(args.familiarityDelta)
      const provenance = parseMaybeJson<NoteProvenance>(args.provenance)

      if (usage === undefined && outcome === undefined) {
        return { result: { ok: true, status: "noop", message: "no usage or outcome provided" }, isError: false }
      }

      const combined: { tokensAccumulated?: boolean; outcome?: unknown } = {}
      if (usage !== undefined) {
        await accumulateFriendTokens(store, friendId, usage)
        combined.tokensAccumulated = true
      }
      if (outcome !== undefined) {
        combined.outcome = await recordRelationshipOutcome(
          store,
          friendId,
          { missionId: outcome.missionId, result: outcome.result, note: outcome.note, provenance: outcome.provenance ?? provenance },
          familiarityDelta,
        )
      }
      return { result: combined, isError: false }
    }

    case "upsert_group": {
      const participants = parseMaybeJson<GroupContextParticipant[]>(args.participants) ?? []
      const results = await upsertGroupContextParticipants({
        store,
        participants,
        groupExternalId: coerceString(args.groupExternalId),
      })
      return { result: results, isError: false }
    }

    case "set_trust": {
      // SECURITY (finding 3): thread the audit sink + owner/sense context so the LIVE
      // trust mutation actually writes a control-plane record. With no sink wired,
      // setFriendTrust treats the ctx as a no-op (back-compat).
      const result = await setFriendTrust(store, coerceString(args.friendId), coerceString(args.trustLevel) as TrustLevel, {
        ...(audit ? { sink: audit } : {}),
        actor: auditActor,
        originSense: auditOriginSense,
      })
      return { result, isError: result.ok === false }
    }

    case "link_identity": {
      const result = await linkExternalId(store, coerceString(args.friendId), {
        provider: coerceString(args.provider) as IdentityProvider,
        externalId: coerceString(args.externalId),
        tenantId: coerceOptionalString(args.tenantId),
      })
      return { result, isError: result.ok === false }
    }

    case "unlink_identity": {
      const result = await unlinkExternalId(store, coerceString(args.friendId), {
        provider: coerceString(args.provider) as IdentityProvider,
        externalId: coerceString(args.externalId),
      })
      return { result, isError: result.ok === false }
    }

    case "onboard_agent": {
      const explicitTrustLevel = coerceOptionalString(args.trustLevel) as TrustLevel | undefined
      const record = await upsertAgentPeer(store, {
        name: coerceString(args.name),
        agentId: coerceString(args.agentId),
        trustLevel: explicitTrustLevel,
        a2a: parseMaybeJson<AgentMeta["a2a"]>(args.a2a),
        mailbox: parseMaybeJson<{ repo: string; selfOutboxAgentId: string }>(args.mailbox),
        bundleName: coerceOptionalString(args.bundleName),
      })
      // SECURITY (finding 3): an owner-initiated trust SEAT (an explicit trustLevel) is
      // a control-plane trust mutation, so audit it through the wired sink. A cold
      // contact with no trustLevel falls to the safe `stranger` default (Bug A) — not
      // an owner trust decision — so it is left unaudited.
      if (audit && explicitTrustLevel !== undefined) {
        const targetDid = resolveAgentIdentity(record.agentMeta).did
        const auditRecord: ControlPlaneAuditRecord = {
          action: "set_trust",
          targetId: record.id,
          ...(targetDid !== undefined ? { targetDid } : {}),
          level: explicitTrustLevel,
          actor: auditActor,
          originSense: auditOriginSense,
          ts: record.updatedAt,
        }
        await audit.append(auditRecord)
      }
      return { result: record, isError: false }
    }

    case "connect_to": {
      // The management-sense control plane (p11 inc2, brick 8). The boundary stays
      // thin — coerce the peer handles + level, resolve the gate's management sense
      // (the stdio path is owner-only ⇒ `local`), and forward to the library, which
      // owns the authority gate + disambiguation + introduce + audit. `isError` reflects
      // ok===false (a `downgraded` / `needs_handle_or_introduction` result is an error
      // result like the other mutation cases).
      const result = await connectAgents(
        store,
        {
          peer: {
            agentId: coerceOptionalString(args.agentId),
            did: coerceOptionalString(args.did),
            name: coerceOptionalString(args.name),
          },
          // The stdio default is `local` (owner-only); a network transport supplies its
          // real senseType via controlContext. The proof's stdio path commits.
          senseType: controlContext?.senseType ?? "local",
          ...(controlContext?.membership ? { membership: controlContext.membership } : {}),
          trustLevel: coerceOptionalString(args.trustLevel) as TrustLevel | undefined,
        },
        {
          ...(audit ? { audit } : {}),
          actor: auditActor,
          originSense: auditOriginSense,
        },
      )
      return { result, isError: result.ok === false }
    }

    case "whoami": {
      return { result: await whoami(store), isError: false }
    }

    case "channel_caps": {
      return { result: getChannelCapabilities(coerceString(args.channel)), isError: false }
    }

    case "resolve_room": {
      const view = await resolveRoom(
        store,
        coerceString(args.groupExternalId),
        (coerceOptionalString(args.channel) ?? "mcp") as Parameters<typeof resolveRoom>[2],
      )
      return { result: view, isError: false }
    }

    case "share_profile": {
      // De-stubbed producer. Self identity comes from whoami (the dispatch is
      // store-only); the subject is named by join key inside the library.
      if (!grants) return { result: NO_GRANT_STORE, isError: true }
      const scope = coerceString(args.scope)
      if (!isShareScope(scope)) {
        return {
          result: { ok: false, status: "invalid", message: `unrecognized scope '${scope}' — use name, identity, notes:safe, notes:all, or outcomes` },
          isError: true,
        }
      }
      const self = await whoami(store)
      // whoami sets selfFriendId + selfAgentName together or neither; the local
      // self id (selfFriendId) is the asserter tag. "" when there is no self yet.
      const selfAgentId = self.selfFriendId ?? ""
      const result = await prepareProfileShare(store, grants, {
        friendId: coerceString(args.friendId),
        toAgentId: coerceString(args.toAgentId),
        scope: scope as ShareScope,
        selfAgentId,
        proof: coerceOptionalString(args.proof),
      })
      return { result, isError: result.ok === false }
    }

    case "import_profile": {
      const envelope = parseMaybeJson<ProfileShareEnvelope>(args.envelope)
      if (!envelope || typeof envelope !== "object") {
        return { result: { ok: false, status: "invalid", message: "an envelope object is required" }, isError: true }
      }
      const result = await importProfileShare(store, {
        envelope,
        fromAgentId: coerceString(args.fromAgentId),
        trustOfSource: coerceString(args.trustOfSource) as TrustLevel,
      })
      return { result, isError: result.ok === false }
    }

    case "grant_share": {
      if (!grants) return { result: NO_GRANT_STORE, isError: true }
      const scope = coerceString(args.scope)
      if (!isShareScope(scope)) {
        return {
          result: { ok: false, status: "invalid", message: `unrecognized scope '${scope}' — use name, identity, notes:safe, notes:all, or outcomes` },
          isError: true,
        }
      }
      // Fork D compat seam (b): accept the new `subjectKey` arg, falling back to
      // the legacy `subjectFriendId` so old-arg callers (incl. the unmodified
      // examples) keep working. coerceString gives "" when an arg is absent, so
      // `||` selects subjectKey when present, else subjectFriendId.
      const grant = await grantShare(grants, {
        subjectKey: coerceString(args.subjectKey) || coerceString(args.subjectFriendId),
        recipientAgentId: coerceString(args.recipientAgentId),
        scope: scope as ShareScope,
        expiresAt: coerceOptionalString(args.expiresAt),
      })
      return { result: grant, isError: false }
    }

    case "revoke_share": {
      if (!grants) return { result: NO_GRANT_STORE, isError: true }
      const result = await revokeShare(grants, coerceString(args.grantId))
      return { result, isError: result.ok === false }
    }

    case "list_shares": {
      if (!grants) return { result: NO_GRANT_STORE, isError: true }
      // Fork D compat seam (b): accept `subjectKey`, falling back to the legacy
      // `subjectFriendId` filter arg.
      const result = await listShares(grants, {
        subjectKey: coerceOptionalString(args.subjectKey) ?? coerceOptionalString(args.subjectFriendId),
        recipientAgentId: coerceOptionalString(args.recipientAgentId),
        effectiveOnly: coerceBool(args.effectiveOnly),
      })
      return { result, isError: false }
    }

    case "record_mission": {
      if (!missions) return { result: NO_MISSION_STORE, isError: true }
      const input: RecordMissionInput = {
        missionKey: coerceString(args.missionKey),
        title: coerceOptionalString(args.title),
        status: coerceOptionalString(args.status) as RecordMissionInput["status"],
        participants: parseMaybeJson<AgentAttribution[]>(args.participants),
        learnings: parseMaybeJson<RecordMissionInput["learnings"]>(args.learnings),
        outcomes: parseMaybeJson<RecordMissionInput["outcomes"]>(args.outcomes),
      }
      const record = await recordMission(missions, input)
      return { result: record, isError: false }
    }

    case "get_mission": {
      if (!missions) return { result: NO_MISSION_STORE, isError: true }
      const record = await missions.get(coerceString(args.missionId))
      if (!record) {
        return { result: { ok: false, status: "not_found", message: "mission record not found" }, isError: true }
      }
      return { result: record, isError: false }
    }

    case "list_missions": {
      if (!missions) return { result: NO_MISSION_STORE, isError: true }
      const all = await missions.listAll()
      const limit = coerceInt(args.limit)
      const result = limit !== undefined ? all.slice(0, limit) : all
      return { result, isError: false }
    }

    case "share_mission": {
      // Producer. Self identity comes from whoami (the dispatch is store-only);
      // the mission is named by its missionKey inside the library. Gated on BOTH a
      // GrantStore (consent) and a MissionStore.
      if (!missions || !grants) return { result: NO_MISSION_STORE, isError: true }
      const scope = coerceString(args.scope)
      if (scope !== "mission" && scope !== "outcomes") {
        return {
          result: { ok: false, status: "invalid", message: `unrecognized mission scope '${scope}' — use mission or outcomes` },
          isError: true,
        }
      }
      const self = await whoami(store)
      const selfAgentId = self.selfFriendId ?? ""
      const result = await prepareMissionShare(missions, store, grants, {
        missionId: coerceString(args.missionId),
        toAgentId: coerceString(args.toAgentId),
        scope,
        selfAgentId,
        proof: coerceOptionalString(args.proof),
      })
      return { result, isError: result.ok === false }
    }

    case "import_mission": {
      if (!missions) return { result: NO_MISSION_STORE, isError: true }
      const envelope = parseMaybeJson<MissionShareEnvelope>(args.envelope)
      if (!envelope || typeof envelope !== "object") {
        return { result: { ok: false, status: "invalid", message: "an envelope object is required" }, isError: true }
      }
      const result = await importMissionShare(missions, {
        envelope,
        fromAgentId: coerceString(args.fromAgentId),
        trustOfSource: coerceString(args.trustOfSource) as TrustLevel,
      })
      return { result, isError: result.ok === false }
    }

    case "coordinate": {
      // Producer (brick 5). Self identity comes from whoami (the dispatch is
      // store-only); the mission is named by its missionKey inside the library.
      // Gated on BOTH a GrantStore (consent via the "coordinate" scope) and a
      // MissionStore — like share_mission.
      if (!missions || !grants) return { result: NO_MISSION_STORE, isError: true }
      const intent = coerceString(args.intent)
      if (!isCoordinationIntent(intent)) {
        return {
          result: { ok: false, status: "invalid", message: `unrecognized coordination intent '${intent}' — use request, offer, accept, decline, or handoff` },
          isError: true,
        }
      }
      const self = await whoami(store)
      const selfAgentId = self.selfFriendId ?? ""
      const result = await prepareCoordination(missions, store, grants, {
        missionId: coerceString(args.missionId),
        toAgentId: coerceString(args.toAgentId),
        intent,
        note: coerceOptionalString(args.note),
        proposedAssignee: parseMaybeJson<AgentAttribution>(args.proposedAssignee),
        selfAgentId,
        proof: coerceOptionalString(args.proof),
      })
      return { result, isError: result.ok === false }
    }

    case "import_coordination": {
      if (!missions) return { result: NO_MISSION_STORE, isError: true }
      const envelope = parseMaybeJson<CoordinationEnvelope>(args.envelope)
      if (!envelope || typeof envelope !== "object") {
        return { result: { ok: false, status: "invalid", message: "an envelope object is required" }, isError: true }
      }
      const result = await importCoordination(missions, {
        envelope,
        fromAgentId: coerceString(args.fromAgentId),
        trustOfSource: coerceString(args.trustOfSource) as TrustLevel,
      })
      return { result, isError: result.ok === false }
    }

    case "get_coordination": {
      // Read lens (brick 5), like get_mission: return the mission's coordination
      // sub-object (assignee + log), or the empty default when unset.
      if (!missions) return { result: NO_MISSION_STORE, isError: true }
      const record = await missions.get(coerceString(args.missionId))
      if (!record) {
        return { result: { ok: false, status: "not_found", message: "mission record not found" }, isError: true }
      }
      return { result: record.coordination ?? { assignee: undefined, log: [] }, isError: false }
    }

    default: {
      return { result: { error: `Unknown tool: ${name}` }, isError: true }
    }
  }
}
