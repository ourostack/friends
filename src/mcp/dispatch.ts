// Tool dispatch for the friends MCP server.
//
// MCP sends string-ish args; the coercion helpers normalize them before calling
// the library fns. `dispatchTool` is a flat tool → library-fn map (D9/D10) with
// NO domain logic of its own — every behavior lives in the friends library.
import { emitNervesEvent } from "../observability"
import type { FriendStore } from "../store"
import type { GrantStore } from "../grant-store"
import type { IdentityProvider, TrustLevel, NoteProvenance, AgentMeta, ShareScope } from "../types"
import { isShareScope } from "../types"
import { FriendResolver } from "../resolver"
import { describeTrustContext } from "../trust-explanation"
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

type Args = Record<string, unknown>

export interface DispatchResult {
  result: unknown
  isError: boolean
}

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

export async function dispatchTool(
  store: FriendStore,
  name: string,
  args: Args,
  grants?: GrantStore,
): Promise<DispatchResult> {
  emitNervesEvent({
    component: "clients",
    event: "clients.mcp_dispatch",
    message: "dispatching friends mcp tool",
    meta: { tool: name },
  })

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
      const result = await setFriendTrust(store, coerceString(args.friendId), coerceString(args.trustLevel) as TrustLevel)
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
      const record = await upsertAgentPeer(store, {
        name: coerceString(args.name),
        agentId: coerceString(args.agentId),
        trustLevel: coerceOptionalString(args.trustLevel) as TrustLevel | undefined,
        a2a: parseMaybeJson<AgentMeta["a2a"]>(args.a2a),
        bundleName: coerceOptionalString(args.bundleName),
      })
      return { result: record, isError: false }
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
      const grant = await grantShare(grants, {
        subjectFriendId: coerceString(args.subjectFriendId),
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
      const result = await listShares(grants, {
        subjectFriendId: coerceOptionalString(args.subjectFriendId),
        recipientAgentId: coerceOptionalString(args.recipientAgentId),
        effectiveOnly: coerceBool(args.effectiveOnly),
      })
      return { result, isError: false }
    }

    default: {
      return { result: { error: `Unknown tool: ${name}` }, isError: true }
    }
  }
}
