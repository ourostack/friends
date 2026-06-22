// connectAgents — the `connect_to` library fn (brick 8, greenfield).
//
// The owner's first-class capability to link one of their OWN agents into the calling
// agent's fleet (introduce a target peer INTO this store). It is the single entry point
// for "go connect to @peer" (spec §3.2), gated to a management sense (§3.1) and audited
// (§3.4). Brick 8 is greenfield in friends — there is NO trust-gate.ts to patch (that
// lives in ouroboros); this composes the new authority predicate (connect-authority.ts)
// with the increment-1 roster-pre-computed membership + the increment-1 control-plane
// audit (AuditSink / action:"connect").
//
// MENTAL MODEL (resolves "A↔B on separate stores"): A and B live in SEPARATE
// stores/processes (own-fleet on two machines), so a single connectAgents call operates
// on ONE store — it upserts the named peer as an agent-peer at the linked trust + audits
// action:"connect". The bidirectional A↔B link is the owner running the introduction on
// EACH side (the LOCAL proof drives both). The fn does NOT reach across stores.
//
// CORE-CLEAN: the `membership` arrives PRE-COMPUTED via `input` (the caller runs
// evaluateAccountMembership against the increment-1 roster surface), so this module
// imports NO a2a-client / libsodium. The lint enforces the direction.
//
// DISAMBIGUATION HONESTY (spec §3.3): given a bare name with no resolvable handle/DID
// and no record hit, connectAgents returns a structured "need a handle or an
// introduction" result rather than FABRICATING a target. An agentId or a did IS an
// owner-supplied/resolved handle; a bare name resolves ONLY by matching an existing
// record (the BUILT FileFriendStore name-fallback scan) — never invented.
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { AuditSink, ControlPlaneAuditRecord } from "./audit"
import { authorizeConnect } from "./connect-authority"
import type { ConnectAuthorization } from "./connect-authority"
import { upsertAgentPeer } from "./agent-peer"
import { findFriendByDid } from "./friend-lookup"
import { resolveAgentIdentity } from "./identity"
import type { AccountMembershipResult } from "./account-roster"
import type { AgentMeta, FriendRecord, SenseType, TrustLevel } from "./types"

/** The named peer to link, by any of the three handles the owner might supply. An
 * `agentId` or `did` is a resolvable handle on its own; a bare `name` resolves ONLY by
 * hitting an existing record (§3.3 — never fabricated). */
export interface ConnectPeer {
  agentId?: string
  did?: string
  name?: string
}

export interface ConnectAgentsInput {
  peer: ConnectPeer
  /** The management sense the connect_to arrived through (the MCP boundary supplies
   * `local` for the owner-only stdio path; a network transport its real senseType). */
  senseType: SenseType
  /** The PRE-COMPUTED account-roster membership for the `closed` branch (the caller
   * runs evaluateAccountMembership). Absent ⇒ no membership proven. */
  membership?: AccountMembershipResult
  /** The trust to link the peer at. Own-fleet linked agents default to `family`. */
  trustLevel?: TrustLevel
}

export interface ConnectAgentsDeps {
  /** The control-plane audit sink. Absent ⇒ the link is made but no audit is appended
   * (no-sink no-op, mirroring setFriendTrust / the onboard_agent seat). */
  audit?: AuditSink
  /** WHO performed the connect (e.g. "owner:stdio"). */
  actor: string
  /** WHENCE — the origin sense string stamped on the audit (e.g. "stdio"). */
  originSense: string
}

export type ConnectStatus = "connected" | "needs_handle_or_introduction" | "downgraded"

export type ConnectResult =
  | { ok: true; status: "connected"; record: FriendRecord }
  | { ok: false; status: "needs_handle_or_introduction" }
  | { ok: false; status: "downgraded"; downgrade: ConnectAuthorization }

/** A peer resolved to a usable handle: its join-key `agentId`, an optional existing
 * record (so its a2a coords survive the upsert), and the display name to link under. */
interface ResolvedPeer {
  agentId: string
  existing?: FriendRecord
  name: string
}

/** Read an agent record's join-key agentId — the durable `a2a.agentId`, falling back
 * to the `a2a-agent` externalId. Returns undefined when the record names no agentId
 * (e.g. a human record), so it can never be linked as an agent target. */
function agentIdOf(record: FriendRecord): string | undefined {
  return record.agentMeta?.a2a?.agentId ?? record.externalIds.find((e) => e.provider === "a2a-agent")?.externalId
}

/** Resolve the peer to a usable handle WITHOUT fabricating one (§3.3):
 *  - `agentId` present → it IS the handle; enrich from any existing record by it.
 *  - else `did` present → resolve an existing record by did (the did is the handle);
 *    a did with no matching record does NOT resolve (needs a handle/introduction).
 *  - else `name` present → match an existing record by case-insensitive name (the
 *    FileFriendStore name-fallback semantics, made store-agnostic via listAll); a bare
 *    name with no hit does NOT resolve.
 *  - else (nothing) → does not resolve.
 * Returns null when the peer cannot be resolved to a real handle. */
async function resolvePeer(store: FriendStore, peer: ConnectPeer): Promise<ResolvedPeer | null> {
  if (peer.agentId) {
    const existing = await store.findByExternalId("a2a-agent", peer.agentId)
    return { agentId: peer.agentId, existing: existing ?? undefined, name: peer.name ?? existing?.name ?? peer.agentId }
  }
  if (peer.did) {
    const existing = await findFriendByDid(store, peer.did)
    if (!existing) return null
    const agentId = agentIdOf(existing)
    if (!agentId) return null
    return { agentId, existing, name: peer.name ?? existing.name }
  }
  if (peer.name) {
    const existing = await findByName(store, peer.name)
    if (!existing) return null
    const agentId = agentIdOf(existing)
    if (!agentId) return null
    return { agentId, existing, name: peer.name }
  }
  return null
}

/** Case-insensitive name match over the store's records (the §3.3 name-fallback scan,
 * made store-agnostic by using listAll). Returns the first match, or null. A store with
 * no listAll yields null (best-effort, never a throw). */
async function findByName(store: FriendStore, name: string): Promise<FriendRecord | null> {
  if (typeof store.listAll !== "function") return null
  const all = await store.listAll()
  const lower = name.toLowerCase()
  return all.find((f) => f.name.toLowerCase() === lower) ?? null
}

/**
 * Link a named peer into the calling agent's store from the owner's vantage. Composes:
 * authority gate (authorizeConnect) → disambiguation (resolvePeer, never fabricates) →
 * the introduce effect (upsertAgentPeer at the linked trust, default family) → the
 * action:"connect" control-plane audit (mirroring the onboard_agent seat). A downgrade
 * authorization makes NO link and writes NO audit (mirrors setFriendTrust's no-audit
 * early return); an unresolvable bare name returns needs_handle_or_introduction.
 */
export async function connectAgents(
  store: FriendStore,
  input: ConnectAgentsInput,
  deps: ConnectAgentsDeps,
): Promise<ConnectResult> {
  // 1) Authority FIRST. A downgrade never commits inline (no link, no audit).
  const authorization = authorizeConnect({ senseType: input.senseType, membership: input.membership })
  if (authorization.decision === "downgrade") {
    emitNervesEvent({
      component: "friends",
      event: "friends.connect_downgraded",
      message: "connect_to downgraded to confirm-prompt (not committed inline)",
      meta: { senseType: input.senseType, reason: authorization.reason },
    })
    return { ok: false, status: "downgraded", downgrade: authorization }
  }

  // 2) Disambiguation honesty — resolve the peer to a real handle, never fabricate.
  const resolved = await resolvePeer(store, input.peer)
  if (!resolved) {
    emitNervesEvent({
      component: "friends",
      event: "friends.connect_needs_handle",
      message: "connect_to could not resolve the peer to a handle — needs a handle or an introduction",
      meta: {},
    })
    return { ok: false, status: "needs_handle_or_introduction" }
  }

  // 3) The introduce effect — upsert the peer as an agent-peer at the linked trust.
  // Own-fleet linked agents default to family; the level is overridable. Pass any
  // existing a2a coords through so the upsert preserves them (incl. a legacy a2a.did).
  //
  // ┌─ PRE-CONDITION before any non-local / networked `controlContext` is ever wired ──────┐
  // │ (security review inc-2 findings 2-3): the `family` DEFAULT here, and the fact that    │
  // │ the TARGET is upserted with no roster constraint (TOFU — see resolvePeer above),      │
  // │ are correct + safe ONLY because the authority gate (authorizeConnect) only COMMITs    │
  // │ on the owner-only `local` stdio sense today (no wire constructs a non-`local`         │
  // │ controlContext). BEFORE any non-`local`/networked controlContext is ever wired, the   │
  // │ `connect` commit MUST add target-side roster verification (the target did must ALSO   │
  // │ be roster-checked, not just TOFU-upserted) AND validate the caller-supplied           │
  // │ `trustLevel` against the authority decision. The current `family` default +           │
  // │ unconstrained target are safe only for the owner-only-stdio path.                     │
  // └──────────────────────────────────────────────────────────────────────────────────────┘
  const trustLevel: TrustLevel = input.trustLevel ?? "family"
  const a2a: AgentMeta["a2a"] | undefined = resolved.existing?.agentMeta?.a2a
  const record = await upsertAgentPeer(store, {
    name: resolved.name,
    agentId: resolved.agentId,
    trustLevel,
    ...(a2a ? { a2a } : {}),
  })

  // 4) The control-plane audit — ONE action:"connect" record through the wired sink
  // (mirrors the onboard_agent seat writer). No sink ⇒ a clean no-op.
  if (deps.audit) {
    const targetDid = resolveAgentIdentity(record.agentMeta).did
    const auditRecord: ControlPlaneAuditRecord = {
      action: "connect",
      targetId: record.id,
      ...(targetDid !== undefined ? { targetDid } : {}),
      level: trustLevel,
      actor: deps.actor,
      originSense: deps.originSense,
      ts: record.updatedAt,
    }
    await deps.audit.append(auditRecord)
  }

  emitNervesEvent({
    component: "friends",
    event: "friends.connect_linked",
    message: "connect_to linked an own-fleet agent peer",
    meta: { targetId: record.id, level: trustLevel },
  })
  return { ok: true, status: "connected", record }
}
