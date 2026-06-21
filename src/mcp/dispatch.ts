// Tool dispatch for the friends MCP server.
//
// MCP sends string-ish args; the coercion helpers normalize them before calling
// the library fns. `dispatchTool` is a flat tool → library-fn map (D9/D10) with
// NO domain logic of its own — every behavior lives in the friends library.
import { emitNervesEvent } from "../observability"
import type { FriendStore } from "../store"
import type { IdentityProvider, TrustLevel, NoteProvenance, AgentMeta } from "../types"
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

export async function dispatchTool(store: FriendStore, name: string, args: Args): Promise<DispatchResult> {
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

    case "share_profile": {
      return { result: { supported: false }, isError: false }
    }

    default: {
      return { result: { error: `Unknown tool: ${name}` }, isError: true }
    }
  }
}
