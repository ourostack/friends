# @ouro.bot/friends

The who's-who of an agent — its identity, relationship, and trust substrate.

> "It is the time you have wasted for your rose that makes your rose so important. […]
> People have forgotten this truth," said the fox. "But you must not forget it. You become
> responsible, forever, for what you have tamed."
> — Antoine de Saint-Exupéry, *The Little Prince*

`friends` is where an agent keeps track of *who it knows*. Every person and peer the agent
meets becomes a `FriendRecord` — a single merged identity (who they are across channels) and
the notes the agent has written about them. Relationships sit on a **trust ladder**, and the
agent's behavior is gated by where someone sits on it.

This is the soul of the fox's lesson: a stranger is just another voice until ties are
established. Establishing those ties — *taming*, in the book's word — is what moves someone up
the ladder from `stranger` to `acquaintance` to `friend` to `family`, and what makes the agent
responsible for them.

## The trust ladder

| Level | Meaning | Grants |
|---|---|---|
| `family` | The machine owner and those closest. | Full tool access, proactive follow-through, local operations. |
| `friend` | A directly-trusted relationship. | Full collaborative access (same as family for gating purposes). |
| `acquaintance` | Known through a **shared group** context, not direct endorsement. | Group-safe coordination; guarded local actions. |
| `stranger` | Cold first contact. | Safe orientation only; no privileged actions. |

`family` and `friend` are the **trusted** levels (`TRUSTED_LEVELS` / `isTrustedLevel`) — they
unlock full tool access and proactive sends. `acquaintance` and `stranger` are gated.

Trust is *assigned*, not guessed:

- **First contact** on a populated bundle starts at `stranger`.
- The **machine owner** (the OS user running the daemon) resolves to `family` — they own the
  agent and its bundle, so they are never a stranger.
- A **shared group** (a group chat) promotes its participants from `stranger` to
  `acquaintance` — the agent now knows them *through* a context it trusts.

## Multi-party and multi-agent

`friends` is not just 1:1. It models:

- **Multi-party** — group chats route through `upsertGroupContextParticipants`, which links
  every participant to the shared group and promotes strangers to acquaintances.
- **Multi-agent** — peers reached over the A2A protocol (`a2a-agent` provider) resolve to
  `kind: "agent"` records carrying `AgentMeta` (bundle name, familiarity, shared missions,
  outcomes, and A2A card/endpoint coordinates).

## How it's consumed

Two seams. You bring a **store**; you resolve through the **resolver**.

```ts
import { FileFriendStore, FriendResolver, describeTrustContext } from "@ouro.bot/friends"

// 1. A store — where friend records live. FileFriendStore persists one JSON file
//    per friend under the directory you give it. Or implement FriendStore yourself.
const store = new FileFriendStore("/path/to/bundle/friends")

// 2. A resolver — turns an incoming external identity into a FriendRecord +
//    the capabilities of the channel it arrived on. Created per incoming message.
const { friend, channel } = await new FriendResolver(store, {
  provider: "aad",
  externalId: "aad-object-id",
  tenantId: "tenant-guid",
  displayName: "Jordan",
  channel: "teams",
}).resolve()

// 3. Gate behavior on trust.
const trust = describeTrustContext({ friend, channel: channel.channel })
//   → { level, basis: "direct" | "shared_group" | "unknown", permits, constraints, ... }
```

`FriendStore` is the injectable abstraction — no friend code touches `fs` directly except the
`FileFriendStore` adapter, so you can back friends with anything (in-memory, a database, a
remote service) by implementing the interface.

## Storage is first-class — bring your own

**`friends` never decides where or how your data lives.** *Where* is the path / connection
string you pass; *how* is a `FriendStore` / `GrantStore` implementation you choose or write. The
core domain logic — resolver, trust, notes, consent, share, import — is **100%
persistence-agnostic**: it only ever calls the two store interfaces.

`openFileBundle` is a one-liner for the filesystem case, encapsulating the sibling `_grants/`
convention (the explicit two-store construction stays available):

```ts
import { openFileBundle } from "@ouro.bot/friends"

const { store, grants } = openFileBundle("/bundle/friends") // grants live at /bundle/friends/_grants
```

### The two seams as a contract

A third-party backend implements two interfaces. Get these three behaviors right or
cross-channel / cross-agent unification breaks:

- **`findByExternalId(provider, externalId, tenantId?)`** — the cross-agent join-key lookup. A
  match requires `provider` + `externalId` **and** (`tenantId` undefined ⇒ any tenant, else an
  exact tenant match). This is how the same person is recognized across channels and how an
  import resolves its subject by join key.
- **`get(id)` — UUID-then-name fallback.** Look up by UUID first; if not found, fall back to a
  **case-insensitive name** lookup (the documented path for proactive sends). A DB backend should
  index the UUID and MAY implement the name fallback.
- **Round-trip discipline (load-bearing).** A backend MUST preserve the **full `FriendRecord`
  losslessly** — including `importedNotes` **and future additive fields** (e.g.
  `agentMeta.a2a.mailbox`). Storing a lossy projection breaks the schemaVersion-1 guarantee for
  non-file backends. Prefer storing the **whole record as a JSON blob keyed by id**, with side
  indexes for lookups.

### Sketch: a SQLite backend (illustrative — not shipped code)

The entire moat works **unchanged** over a database, because the domain only ever calls the
`FriendStore` interface. Store the record as a JSON blob (lossless) with an index table for the
join-key lookup:

```ts
// friends(id TEXT PRIMARY KEY, name TEXT, record TEXT /* JSON */)
// external_ids(provider TEXT, external_id TEXT, tenant_id TEXT, friend_id TEXT)
class SqliteFriendStore implements FriendStore {
  constructor(private readonly db: Database) {}

  async put(id: string, record: FriendRecord): Promise<void> {
    // Lossless: the WHOLE record as JSON — importedNotes + any additive field survive.
    this.db.run("INSERT OR REPLACE INTO friends (id, name, record) VALUES (?, ?, ?)",
      id, record.name, JSON.stringify(record))
    this.db.run("DELETE FROM external_ids WHERE friend_id = ?", id)
    for (const ext of record.externalIds) {
      this.db.run("INSERT INTO external_ids (provider, external_id, tenant_id, friend_id) VALUES (?, ?, ?, ?)",
        ext.provider, ext.externalId, ext.tenantId ?? null, id)
    }
  }

  async get(id: string): Promise<FriendRecord | null> {
    const byId = this.db.get("SELECT record FROM friends WHERE id = ?", id)
    if (byId) return JSON.parse(byId.record)
    // UUID-then-name fallback (case-insensitive).
    const byName = this.db.get("SELECT record FROM friends WHERE LOWER(name) = LOWER(?)", id)
    return byName ? JSON.parse(byName.record) : null
  }

  async findByExternalId(provider: string, externalId: string, tenantId?: string): Promise<FriendRecord | null> {
    const row = this.db.get(
      "SELECT friend_id FROM external_ids WHERE provider = ? AND external_id = ? AND (? IS NULL OR tenant_id = ?)",
      provider, externalId, tenantId ?? null, tenantId ?? null)
    return row ? this.get(row.friend_id) : null
  }
  // delete / listAll / hasAnyFriends follow the same id-keyed-blob shape.
}
```

`GrantStore` is the same shape — an id-keyed JSON blob (no external-id index needed). Swap either
store in and **every import-safety invariant still holds**, because they are structural
properties of the domain logic, not of the filesystem.

## Channels

Each channel an agent speaks on (`cli`, `teams`, `bluebubbles`, `mail`, `voice`, `a2a`,
`inner`, `mcp`) has fixed **capabilities** — its sense type (`open` / `closed` / `local` /
`internal`), which integrations it exposes, and whether it supports markdown, streaming, and
rich cards. Look them up with `getChannelCapabilities`. The sense type, combined with trust,
is what decides whether a first-contact stranger reaches the full model on an open channel.

## Observability

The package emits structured events through `emitNervesEvent`. By default these are **dropped**
(no-op) so the package is fully self-contained. To forward them somewhere real, inject an
emitter once at startup:

```ts
import { setNervesEmitter } from "@ouro.bot/friends"

setNervesEmitter((event) => {
  // forward `event` to your logging / observability pipeline
})
```

## MCP server

`@ouro.bot/friends` ships an MCP server (`friends-mcp`) that exposes the library as a tool
surface for any MCP-speaking harness. **The server runs no agent turn — it is a pure record
read/write surface over the library, which is exactly what makes it harness-agnostic.** No
daemon, no LLM, no session: each tool call reads or writes friend records against a directory
you point it at.

### Configuration (`.mcp.json`)

The server speaks JSON-RPC 2.0 over stdio with **dual framing** — Content-Length (Claude Code)
and newline-delimited JSON (Codex), auto-detected from the first message.

The **documented (published) form** uses `npx` — but note it requires the package to be
published to npm first (not yet live):

```json
{
  "mcpServers": {
    "friends": {
      "command": "npx",
      "args": ["-y", "--package", "@ouro.bot/friends", "friends-mcp", "--dir", "<path-to-friends-dir>"]
    }
  }
}
```

Until then, the **dev / node form** is what runs against a local build:

```json
{
  "mcpServers": {
    "friends": {
      "command": "node",
      "args": ["<repo>/dist/mcp/bin.js", "--dir", "<path-to-friends-dir>"]
    }
  }
}
```

For local development you can also `npm pack` then
`npx -y --package ./ouro.bot-friends-<version>.tgz friends-mcp --dir <path>`, or `npm link`
then `friends-mcp --dir <path>`.

### The `--dir` coupling

The store directory is the **only** coupling between the server and a bundle. Provide it with
`--dir <path>` or the `FRIENDS_DIR` environment variable; **the flag wins** when both are set,
and one of them is required (the server exits otherwise). It points at the bundle's `friends/`
directory — the same directory a `FileFriendStore` persists to.

### Tool surface

26 tools, a thin 1:1 mapping over the library (no domain logic in the server):

| Tool | What it does |
|---|---|
| `resolve_party` | Resolve an external identity into a friend record (creating one on first contact); returns `{ friend, channel, created }`. |
| `describe_trust` | Explain a friend's trust context (level, basis, permits, constraints). |
| `get_friend` | Fetch one friend record by uuid or name. |
| `list_friends` | List friends, optionally filtered by trust / kind and limited. |
| `save_note` | Save a friend's name, a tool preference, or a general note (with `override`). |
| `record_interaction` | Accumulate token usage and/or append a shared-mission outcome. |
| `upsert_group` | Link participants to a shared group, promoting strangers to acquaintances. |
| `set_trust` | Set a friend's trust level (mirrored onto `role`). |
| `link_identity` | Link an external identity, merging any orphan record that holds it. |
| `unlink_identity` | Remove an external identity from a friend. |
| `onboard_agent` | Upsert an agent-peer record from resolved coordinates (no HTTP fetch). |
| `whoami` | Resolve the machine owner and which record represents the self. |
| `channel_caps` | Return a channel's capabilities. |
| `resolve_room` | Resolve a room (a group's external id) into its members, each with trust context and `knownVia`. |
| `share_profile` | **Producer** — prepare a consent-gated, scope-filtered, provenance-preserving profile-share envelope for another agent. |
| `import_profile` | **Consumer** — import a profile-share envelope (non-clobbering merge into the imported namespace; never touches first-party notes or trust). |
| `grant_share` | Mint an explicit, revocable consent grant (an agent may receive a scope of a subject — a friend's profile or a mission). |
| `revoke_share` | Revoke a consent grant by id (tombstones it; the right-to-be-forgotten lever). |
| `list_shares` | List consent grants with their effective state (the audit + revoke surface). |
| `record_mission` | Upsert a shared **mission** by its `missionKey` — append first-party learnings / participants / outcomes, set status. |
| `get_mission` | Fetch one mission record by its local uuid id. |
| `list_missions` | List mission records, optionally limited. |
| `share_mission` | **Producer** — prepare a consent-gated, scope-filtered mission-share envelope (`mission` = shareable learnings; `outcomes` = the result rows). |
| `import_mission` | **Consumer** — import a mission-share envelope (non-clobbering merge into the imported namespace; never touches first-party learnings or status). |
| `assess_standing` | Assess a peer's **earned standing** from your first-party outcomes — a tier (proven/reliable/mixed/untested/troubled) + basis count + tally. Advisory; never writes trust, never shared. |
| `explain_standing` | Explain a peer's earned standing in words (tier, why, advisory notes that frame it as input to a *manual* trust decision — never an instruction to change trust). |

The `share_profile` / `import_profile` / `grant_share` / `revoke_share` / `list_shares` tools
need a **grant store** (consent persistence). The bin wires one automatically at a sibling
`_grants/` directory under `--dir`; an embedded server gets one by passing `grants` to
`createFriendsMcpServer`. Without it those five tools report `{ ok: false, status: "unsupported" }`
and everything else works store-only.

The `record_mission` / `get_mission` / `list_missions` / `share_mission` / `import_mission` tools
need a **mission store**, wired the same way at a sibling `_missions/` directory under `--dir` (or
by passing `missions` to `createFriendsMcpServer`); without it they report
`{ ok: false, status: "unsupported" }`. `share_mission` additionally needs the grant store (a
mission is just another grant subject, keyed by its `missionKey`).

The server module is consumed in code from the `@ouro.bot/friends/mcp` subpath, exporting
`createFriendsMcpServer`, `getToolSchemas`, and `runMain` (plus the `McpToolSchema`,
`FriendsMcpServer`, and `RunMainIo` types).

## The `./a2a` git-mailbox transport

The package ships an optional **`@ouro.bot/friends/a2a`** sub-export — a *pure* git-mailbox
transport for the cross-agent moat. It has **zero runtime dependencies** and does **no git or
network itself**: **the host does every git op** (clone / pull / add / commit / push) and writes
the bytes; the library only **computes a message file's path + bytes** and **parses / validates /
orders / dedups** the files the host hands back.

```ts
import { buildOutgoing, readIncoming, markSeen, isSeen } from "@ouro.bot/friends/a2a"

// Producer: compute the file to write (the host then `git add/commit/push`es it).
const { relativePath, bytes } = buildOutgoing({ envelope, fromAgentId: "agent-a", toAgentId: "agent-b" })
//   relativePath → agents/agent-a/outbox/agent-b/<issuedAt>--<uuid>.json

// Consumer: the host `git pull`s + reads the files, then validates/orders/dedups them.
const { ready, skippedSeen, rejected } = readIncoming({ files, selfAgentId: "agent-b", seen })
//   ready: self-addressed, path-bound, not-yet-seen messages, ordered by issuedAt
//   skippedSeen: messageIds already in the seen ledger (replay-safe)
//   rejected: { relativePath, reason } — e.g. from_path_mismatch (a spoofed sender)
```

Frame the two sides generically as **two agents that authenticate as two distinct git
identities**, sharing a dedicated **private** mailbox repo. Addressing lives in the path
(`agents/<from>/outbox/<to>/…`), each agent is the **single writer** of its own outbox dir, and
`readIncoming` **path-binds** every message — rejecting any whose claimed sender/recipient
doesn't match the path. The mailbox is **untrusted infrastructure**: a hostile mailbox can only
**deny or replay**, never escalate, because `import_profile` never touches first-party notes or
trust. See [`examples/a2a-git-mailbox.ts`](./examples/a2a-git-mailbox.ts)
(`npm run example:a2a-git-mailbox`) for an end-to-end, git-free proof of every invariant.

## Cross-agent sharing (the moat)

Two *different* agents (different owners) can agree a party is the same person **and** share what
they know about them — **with consent, without first-party knowledge being clobbered**. The
package stays store-only and transport-agnostic: it produces and consumes a `ProfileShareEnvelope`;
the **wire between two agents is the caller's job** (the same split that keeps A2A transport
harness-side). The package does **authorization** — how much a verified peer's claims count, via
the trust ladder; **authentication of the wire** is plugged in through an `AgentVerifier`.

```ts
import {
  prepareProfileShare, importProfileShare,
  grantShare, listShares, revokeShare,
  FileFriendStore, FileGrantStore, grantsDirFor,
} from "@ouro.bot/friends"

const store = new FileFriendStore("/bundle/friends")
const grants = new FileGrantStore(grantsDirFor("/bundle/friends")) // sibling _grants/ dir

// Consent is an explicit, auditable, revocable grant.
await grantShare(grants, { subjectKey, recipientAgentId, scope: "notes:safe" })

// Producer: a consent-gated, scope-filtered, provenance-preserving envelope that
// names the party by JOIN KEY (externalIds), never the local UUID.
const out = await prepareProfileShare(store, grants, {
  friendId, toAgentId: recipientAgentId, scope: "notes:safe", selfAgentId,
})
// → { ok: true, envelope } | { ok: false, status }

// ...caller ships `out.envelope` to the other agent over its own transport...

// Consumer: the non-clobbering merge, on the OTHER agent's store.
const result = await importProfileShare(store, {
  envelope, fromAgentId, trustOfSource, // this agent's resolved trust in the source
})
// → { ok: true, status: "imported" | "seeded", record } | { ok: false, status }

// Audit + revoke (the right-to-be-forgotten seam).
await listShares(grants, { subjectKey })
await revokeShare(grants, grantId)
```

**Import safety invariants** (each is structurally enforced and tested):

- the party is resolved by **join key** (`findByExternalId` over the envelope's `externalIds`);
- imported facts land in a **separate `importedNotes` namespace** (`origin: "imported"` +
  `assertedBy` + `importedAt`) — **first-party `notes` are physically untouchable; first-party
  always wins**;
- the **source agent's trust caps acceptance** — a `stranger` source is refused (the floor is
  configurable via `minTrustToAccept`);
- **imports NEVER change the party's trust level** (non-transitive — the single most important
  invariant);
- an **unknown party** is seeded (at `acquaintance`) **only when the introducing peer is
  `friend`/`family`**; a `stranger`/`acquaintance` peer may not seed a new record.

Provenance is never laundered: a first-party note shared onward is attributed to *this* agent;
an *imported* note shared onward carries its `originallyAssertedBy` through, so an imported fact
never masquerades as first-party.

### Consent posture — the swap point

The producer is gated by a **`ConsentPolicy`**. Three postures ship, sharing one machinery, so
choosing a posture is a **one-line default swap, not a rebuild**:

- **`strictPolicy`** — consented only by a non-revoked, non-expired explicit `ShareGrant`.
- **`trustImpliedPolicy`** — an explicit grant, *or* recipient trust ≥ `friend` (any scope).
- **`tieredPolicy`** *(default)* — identity-scope shares (the join key: `name` / `identity`) are
  consented on recipient trust ≥ `friend`; any **note-content scope** (`notes:*`, `outcomes`)
  requires an explicit grant.

**The swap point is `DEFAULT_CONSENT_POLICY` in [`src/consent.ts`](./src/consent.ts).** Point it at
`strictPolicy` / `trustImpliedPolicy` / `tieredPolicy` to change the product's privacy posture
globally; or pass an explicit policy as the 4th argument to `prepareProfileShare` to override
per-call. The `AgentVerifier` defaults to **trust-on-first-use** (`tofuVerifier`), which ignores the
envelope's reserved opaque `proof` slot — a stronger verifier (DID/VC) can be dropped in with no
envelope change.

## Cross-agent mission ledger (shared work memory)

The moat shares **who a person is**. The mission ledger shares **what two agents collectively
learned doing work together**. It re-aims the same import machinery — first-party / imported split,
attribution, the consent stack, the `./a2a` transport — from a *person* at a **mission**: one new
persistence noun (the mission record) and one new content slot (`learnings`). Entirely additive; the
person path is untouched.

A **mission** is named by a **`missionKey`** — a cross-agent join key (a ticket id, `repo#PR`, a
slugged name two agents agree on out of band), the mission's analogue of `provider:externalId`. The
same mission has a *different local UUID in every store*; the `missionKey` — never the UUID — is what
crosses the wire.

```ts
import {
  recordMission, prepareMissionShare, importMissionShare,
  FileMissionStore, missionsDirFor,
} from "@ouro.bot/friends"

const missions = new FileMissionStore(missionsDirFor("/bundle/friends")) // sibling _missions/ dir

// Record a mission + a first-party learning (private by default; mark shareable to share it).
await recordMission(missions, {
  missionKey: "PROJ-1234",
  title: "Ship the ledger",
  learnings: [{ key: "gotcha", value: "rebase, never merge", shareable: true }],
})

// Consent: a mission is just another grant subject, keyed by its missionKey.
await grantShare(grants, { subjectKey: "PROJ-1234", recipientAgentId, scope: "mission" })

// Producer: a consent-gated, scope-filtered envelope that names the mission by missionKey,
// never the local UUID. scope "mission" carries the SHAREABLE learnings (attributed to self);
// scope "outcomes" carries the mission's result rows.
const out = await prepareMissionShare(missions, store, grants, {
  missionId, toAgentId: recipientAgentId, scope: "mission", selfAgentId,
})
// → { ok: true, envelope } | { ok: false, status: "not_found" | "no_consent" | "no_recipient" }

// ...the envelope crosses the wire (e.g. kind:"mission_share" over the ./a2a mailbox)...

// Consumer: the non-clobbering merge, on the OTHER agent's store.
const result = await importMissionShare(missions, { envelope, fromAgentId, trustOfSource })
// → { ok: true, status: "imported" | "seeded", record } | { ok: false, status }
```

**The `"mission"` scope** carries the whole artifact (title / status + *shareable* learnings); the
existing `"outcomes"` scope carries just the result rows. Both are **content** → under the tiered
default they **always need an explicit grant** (trust agrees on *who*; content still needs consent).

**Import safety invariants** (each is structurally enforced and tested), the mission analogue of the
moat's:

- the mission is resolved by **`missionKey`** (`findByMissionKey`), never the local UUID;
- **first-party-wins**: imported learnings land in a separate **`importedLearnings[fromAgentId]`**
  namespace — first-party `learnings` are physically untouched;
- **no laundering**: an imported learning records the source as `assertedBy` + carries
  `originallyAssertedBy`, so it can never be re-shared as first-party;
- **non-transitive**: a peer's envelope **never recomputes** the mission's `status` or `participants`
  (a peer saying "this failed" never flips your mission's status);
- **outcome merge** (genuinely new logic): imported outcomes are append-merged, stamped
  `origin:"imported"` + the source attribution, and **deduped by
  `(missionId, timestamp, assertedBy.agentId)`** — the same peer's row is idempotent, different
  peers' rows coexist;
- **seeding gate**: an unknown mission is **seeded only by a friend/family** introducing peer (else
  `untrusted_introduction` for an acquaintance, `untrusted_source` for a stranger); a seeded mission
  starts `status:"active"` with empty first-party learnings.

**Over the `./a2a` transport** a mission share is **`kind:"mission_share"`** carrying a
`MissionShareEnvelope` verbatim. The mailbox (addressing, path-binding, single-writer outboxes,
seen-ledger dedup, ordering) is payload-agnostic, so it carries it with no transport change;
`buildOutgoing` defaults `kind` to `"profile_share"` for backward-compat and the host branches on the
`IncomingMessage.kind` to call `importProfileShare` vs `importMissionShare`. The brick-2 threat model
holds verbatim: a forged mission envelope is an attributed, quarantined, status-non-transitive claim —
it escalates nothing.

## Earned standing (first-party reputation)

The agent already records a `RelationshipOutcome[]` per agent peer (via `record_interaction`) — but
never read it back. **Earned standing** is that read: a derived, advisory assessment of how a peer has
actually performed on work *you personally did with it*. It is a lens, like `describeTrustContext` —
computed on read, persisted nowhere, and removable tomorrow without changing any other behavior.

The mental model is a bright line: **trust decides, standing informs.** `trustLevel` answers "how much
authority do I grant" (manual, deliberate — the gate). Standing answers "how has this peer actually
done on our shared work" (derived, advisory — never the gate). `assessStanding` returns a value; it
never calls `setFriendTrust`.

```ts
import { assessStanding, explainStanding } from "@ouro.bot/friends"

const standing = assessStanding(peerRecord)
// → { tier: "proven", basisCount: 3, tally: { success: 3, partial: 0, failed: 0 }, familiarity: 3, assessedAt }

const explained = explainStanding(peerRecord)
// → { standing, summary, why, advisory: [ "...", "Standing is advisory only - it does not change this
//     peer's trust level. Adjust trust deliberately with set_trust if warranted." ] }
```

Four firewalls keep standing on the right side of the non-transitivity invariant the whole package
guards — each mirrors a proven guarantee:

1. **First-party only.** `assessStanding` filters `agentMeta.outcomes` to `provenance.origin !==
   "imported"`. A peer's claim about a third agent (the imported namespace a mission/profile share lands
   in) **never feeds your standing** — reputation can't be laundered across a hop.
2. **Never writes `trustLevel`.** A pure function returning a value; no store-write path; it cannot
   reach `setFriendTrust`. Standing is an input to a *manual* trust decision, never an automatic one.
3. **Never on the wire.** There is no `standing` envelope field and no `kind:"standing_share"` — no way
   for A to tell B "C is great." The type to express standing on the wire does not exist (the anti-Sybil
   core: a collusion ring can't vouch each other into your standing).
4. **Advisory, never a gate.** No consent / share / trust path reads standing; `explainStanding`'s
   `advisory` says so in plain words. Removing standing changes zero behavior of the rest of the package.

The tier ladder is a fixed, transparent, **count-based** rule (not ML, no time-decay yet):

| Tier | Rule |
|---|---|
| `untested` | no first-party outcomes recorded yet |
| `troubled` | failures outnumber successes |
| `proven` | ≥3 clean successes, no failures, and enough familiarity |
| `reliable` | ≥1 clean success, no failures (but not yet proven) |
| `mixed` | any other signal (partials, or wins alongside a non-dominant failure) |

The rule is injectable: `DEFAULT_STANDING_RULE` is the active `StandingRule`, the single swap point
(mirroring `DEFAULT_CONSENT_POLICY`). Pass a custom `rule` to `assessStanding` / `explainStanding`, or
swap the default, to change the ladder — e.g. a later recency/decay rule is an additive swap here, not a
rebuild. The two MCP tools (`assess_standing`, `explain_standing`) use the default.

## Public API

**Types:** `FriendRecord`, `FriendConnection`, `ExternalId`, `IdentityProvider`, `Channel`,
`TrustLevel`, `AgentMeta`, `AgentAttribution`, `RelationshipOutcome`, `NoteProvenance`,
`ImportedNote`, `ShareScope`, `ShareGrant`, `ChannelCapabilities`, `ResolvedContext`, `SenseType`,
`Facing`, `TrustExplanation`, `TrustBasis`, `Standing`, `StandingTier`, `StandingTally`,
`StandingExplanation`, `StandingRule`, `StandingRuleInput`, `FriendStore`, `GrantStore`, `FriendResolverParams`,
`GroupContextParticipant`, `GroupContextUpsertResult`, `UsageData`, `FriendOpResult`,
`FriendOpStatus`, `ApplyFriendNoteInput`, `WhoamiResult`, `RoomView`, `RoomMember`, `RoomKnownVia`,
`ConsentPolicy`, `ConsentRecipient`, `ConsentDecisionInput`, `AgentVerifier`,
`ProfileShareEnvelope`, `SharedNote`, `PrepareProfileShareInput`, `PrepareProfileShareResult`,
`PrepareProfileShareStatus`, `ImportProfileShareInput`, `ImportProfileShareOptions`,
`ImportProfileShareResult`, `ImportProfileShareStatus`, `GrantShareInput`, `RevokeShareResult`,
`ListSharesFilter`, `ListedShare`, `FileBundle`, `NervesEvent`, `MissionKey`, `MissionLearning`,
`ImportedLearning`, `MissionRecord`, `MissionStore`, `MissionShareEnvelope`, `SharedLearning`,
`RecordMissionInput`, `PrepareMissionShareInput`, `PrepareMissionShareResult`,
`PrepareMissionShareStatus`, `ImportMissionShareInput`, `ImportMissionShareOptions`,
`ImportMissionShareResult`, `ImportMissionShareStatus`.

**Values:** `TRUSTED_LEVELS`, `IDENTITY_SCOPES`, `isTrustedLevel`, `isIdentityProvider`,
`isShareScope`, `FileFriendStore`, `FileGrantStore`, `grantsDirFor`, `FriendResolver`,
`machineOwnerUsername`, `isLocalMachineOwnerIdentity`, `getChannelCapabilities`, `channelToFacing`,
`isRemoteChannel`, `getAlwaysOnSenseNames`, `describeTrustContext`, `assessStanding`,
`explainStanding`, `DEFAULT_STANDING_RULE`, `upsertGroupContextParticipants`, `accumulateFriendTokens`,
`applyFriendNote`, `setFriendTrust`,
`linkExternalId`, `unlinkExternalId`, `upsertAgentPeer`, `recordRelationshipOutcome`, `whoami`,
`resolveRoom`, `strictPolicy`, `trustImpliedPolicy`, `tieredPolicy`, `DEFAULT_CONSENT_POLICY`,
`tofuVerifier`, `DEFAULT_AGENT_VERIFIER`, `prepareProfileShare`, `importProfileShare`, `grantShare`,
`revokeShare`, `listShares`, `isGrantEffective`, `openFileBundle`, `setNervesEmitter`,
`recordMission`, `prepareMissionShare`, `importMissionShare`, `FileMissionStore`, `missionsDirFor`.

**From `@ouro.bot/friends/mcp`:** `createFriendsMcpServer`, `getToolSchemas`, `runMain`.

**From `@ouro.bot/friends/a2a`:** `buildOutgoing`, `readIncoming`, `markSeen`, `isSeen`,
`compareReady`, `MAILBOX_VERSION` (+ the `MailboxMessage`, `BuildOutgoingInput`,
`BuildOutgoingResult`, `IncomingFile`, `IncomingMessage`, `ReadIncomingInput`, `ReadIncomingResult`,
`RejectedMessage`, `SeenLedger` types).

## License

[Apache-2.0](./LICENSE)
