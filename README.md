# @ouro.bot/friends

**An open identity, relationship, and multiplayer substrate for AI agents.**
*Who am I, who are you, who else is in the room* — for any harness, any agent.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40ouro.bot%2Ffriends-cb3837.svg)](https://www.npmjs.com/package/@ouro.bot/friends)
&nbsp;·&nbsp; store-only &nbsp;·&nbsp; transport-agnostic &nbsp;·&nbsp; no daemon &nbsp;·&nbsp; alpha

<!-- OPERATOR: enrich the vision/soul here (the "taming" / Little-Prince framing is yours to voice) -->

> "It is the time you have wasted for your rose that makes your rose so important. […]
> People have forgotten this truth," said the fox. "But you must not forget it. You become
> responsible, forever, for what you have tamed."
> — Antoine de Saint-Exupéry, *The Little Prince*

An agent meets the same people over and over — across a CLI, a chat thread, an email, a voice
call — and it meets other agents. `friends` is where it keeps track of **who it knows**: a single
merged identity per person (who they are across every channel), the notes it has written about
them, and where each relationship sits on a **trust ladder**. A stranger is just another voice
until ties are established; establishing those ties — *taming*, in the book's word — is what moves
someone from `stranger` to `acquaintance` to `friend` to `family`, and what makes the agent
behave differently toward them.

---

## What `friends` is

`friends` is a **library + an MCP server** that gives an agent a who's-who. It is deliberately
narrow:

- **Store-only.** Every tool reads or writes *records*. There is no agent turn, no LLM call, no
  session — which is exactly what makes it harness-agnostic. The same package serves Claude Code,
  Codex, a Copilot CLI, or anything else that can call a function or speak MCP.
- **Transport-agnostic.** When two agents need to exchange something, `friends` produces and
  consumes a plain envelope; **the wire between them is the caller's job.** An optional
  git-mailbox transport ships alongside, but the core never opens a socket.
- **No daemon.** Nothing to run in the background. Point it at a directory and call it.
- **Bring your own storage.** The library never decides *where* or *how* your data lives — you
  pass a path (or a connection string) and, if you want, your own storage backend.

It is built as **six additive capability layers**. Each is a minimal primitive on the one before
it; none is a workflow engine; removing any layer leaves the ones beneath it unchanged.

---

## What it does — the six capabilities

### 1. Identity + the cross-agent moat

The foundation: **recognize a person across every channel, and decide how much to trust them.**

Every person or peer the agent meets becomes a `FriendRecord` — one merged identity that collapses
all of someone's channel handles together, keyed by a **join key** (`provider:externalId`, never a
local UUID). The same person reached on a CLI today and a chat thread tomorrow resolves to the
*same* record.

Relationships sit on a four-rung **trust ladder** (`family` / `friend` / `acquaintance` /
`stranger`), and the agent's behavior is gated by where someone sits on it. Two agents that have
never shared a database can agree a party is the same person **and** share what they know about
them — **with consent, and without first-party knowledge ever being clobbered**. First-party
knowledge is **structurally inviolable** and trust is **non-transitive**: an import can add an
attributed, quarantined note, but it can never change who you trust. (See
[Trust & consent model](#trust--consent-model).)

### 2. Connectivity — the git-backed mailbox fallback

How two agents actually reach each other, without a server in the middle. (This git-mailbox is the
demoted **offline/no-endpoint fallback** — real A2A + the friends E2E overlay is the primary path;
see `@ouro.bot/friends/a2a-client`.)

The optional `@ouro.bot/friends/mailbox` sub-export is a **pure git-mailbox transport**: zero runtime
dependencies, and it does **no git or network itself**. The host does every git op (clone / pull /
add / commit / push); the library only **computes a message file's path + bytes** and
**parses / validates / orders / dedups** the files the host hands back. Two agents authenticate as
two distinct git identities sharing a private mailbox repo; each agent is the single writer of its
own outbox.

The mailbox is treated as **untrusted infrastructure**: a hostile mailbox can only **deny or
replay** — never **escalate** — because an import never touches first-party notes or trust.

### 2b. The primary transport — real A2A + an end-to-end security overlay

The **`@ouro.bot/friends/a2a-client`** sub-export is the host-side adapter that makes friends agents
speak the **real A2A (Agent2Agent) standard** — `message/send`, agent cards at a well-known URL, a
single structured `DataPart` per envelope — and adds the **end-to-end security overlay** that keeps
the wire safe even when a relay sits in the middle. It is the only part of the package that has a
runtime dependency (`libsodium-wrappers`); the core stays zero-dep and transport-agnostic.

A friends exchange is one A2A message whose DataPart carries a **sealed envelope**. Before it ever
hits the wire, the envelope is:

- **signed** by the sender — Ed25519 over the [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785)
  canonical bytes, carried in the envelope's reserved `proof` slot; and
- **sealed** to the recipient — XChaCha20-Poly1305 AEAD over an ephemeral X25519 ECDH key, with the
  **recipient's DID bound into the AEAD associated-data** so a blob cannot be re-targeted.

The signature lives **inside** the ciphertext (sign-then-seal), so a relay never even learns who
signed. Cryptographic identity is **`did:key`** (zero-infra — the agent's DID *is* its Ed25519 key,
and the X25519 keyAgreement key is derived from it) or **`did:web`** (resolved behind an injectable
hook). Identity is `agentId === did`, pinned trust-on-first-use, with **trust-tiered key rotation**
(a family/friend peer may present a *signed* successor proof; acquaintances/strangers re-confirm out
of band).

**The friends relay (`ourostack/friends-relay`)** is the friends-family communication layer for any
agent using the friends library — a relay (agents with no reachable endpoint register; it forwards
A2A messages) plus a directory (discovery). It is built and deployed as a separate component from
this store-only library, and it is **UNTRUSTED INFRASTRUCTURE by design**: standard A2A is TLS-only
and terminates at the server, so a plain A2A relay would read every payload. The friends overlay
closes exactly that gap. The relay carries **ciphertext and a routing handle and nothing else** — it
can never **read**, **forge**, **tamper**, **re-target**, **replay-to-effect**, or **escalate**. The
only residual it has is the ability to **deny, delay, or observe handle-level metadata**.

That claim is not a promise — it is a **proof**. `examples/cross-agent-a2a-relay.ts` stands up a
deliberately-malicious in-process relay and asserts all eight properties hold against real
libsodium crypto:

```
npm run example:cross-agent-a2a-relay      # the malicious-relay proof: 8 hard assertions —
                                           #   ciphertext-only, can't-forge/tamper/re-target,
                                           #   replay-inert, moat-invariants, direct-equivalence,
                                           #   reachability ladder (direct → relay → mailbox → none)
```

Reachability is a deterministic ladder: a directly-reachable **A2A endpoint** first, else the
**relay**, else the **git-mailbox fallback** (§2), else **unreachable**. The *same* sealed envelope
rides every rung — the security never depends on which path it took.

### 3. Shared memory — the mission ledger

What two agents collectively *learned* doing work together.

A **mission** is named by a cross-agent `missionKey` (a ticket id, `repo#PR`, a slug two agents
agree on out of band). A `MissionRecord` remembers the work: its status, participants, outcomes,
and `learnings`. The same import discipline as the moat applies — first-party `learnings` are
physically separated from `importedLearnings` accepted from a peer, and an imported learning can
never masquerade as first-party.

### 4. Earned standing — advisory reputation, never on the wire

A read-only assessment of how a peer has actually performed on work *you personally did with it*.

`standing` is **derived from your own first-party outcomes** — a tier
(`proven` / `reliable` / `mixed` / `untested` / `troubled`) computed on read, persisted nowhere.
The bright line: **trust decides, standing informs.** Standing **never auto-changes trust** and
**never crosses the wire** — there is no envelope field and no message type to express it, which is
the anti-Sybil core (a collusion ring cannot vouch each other into your standing).

### 5. Coordination — negotiate who does the work

The five layers close the loop: agents can now negotiate **who does a mission.**

Five verbs — `request` / `offer` / `accept` / `decline` / `handoff` — ride one new transport `kind`
over the same mailbox. The **only** persisted effect is one additive sub-object on the mission an
agent already shares: its **assignment** (who currently holds it) plus an append-only log of every
ask, bid, and answer. It is a single negotiated *field*, not a scheduler: a `handoff` never *forces*
an assignee onto anyone (the receiver's own `accept` confirms it — non-transitive), assignment is
advisory metadata rather than a granted capability, and conflicts resolve last-writer-wins by
timestamp. No queue, no DAG, no workflow DSL.

### 6. Own-fleet delegation — link your own agents, then delegate work end-to-end

The control-plane thread: the owner can **link two of their own agents** and have one **delegate a
task** to the other, get it done, and **receive the result back** — over the same consent-gated,
trust-capped, first-party-inviolable machinery.

`connect_to` is a first-class **management-sense** capability — the owner introduces a peer into an
agent's fleet, but **only from a trusted control surface**: a `local` (owner-only) sense commits
inline; an `open` sense never does (it downgrades to a confirm-prompt); a `closed` sense is gated by
a **signed account-roster membership check** (same-account `family` via `same_account`), never a
blanket allow. The link is recorded as an `action:"connect"` control-plane audit. A bare name with
no resolvable handle is answered honestly (`needs_handle_or_introduction`) rather than invented.

Delegation then rides the layers already here: a **task-spec** travels on a coordination `request`
(correlated by a minted `requestId`), and the **result-return** (`send_result` / `import_result`)
carries the actual produced **deliverable** back — attributed to the doer, correlated to the original
delegation, landing **quarantined** in a separate namespace on import. A result for work you never
delegated is rejected (`no_delegation`); a stranger's result is refused at the trust cap; first-party
knowledge is never touched. It is a deliverable channel, **not a remote-exec grant**.

> The stack, in one line: agents **recognize** each other (1), **reach** each other (2),
> **remember** shared work (3), **assess** each other (4), **negotiate** who does what (5), and the
> owner **links their own agents to delegate end-to-end** (6) — each a minimal primitive on the last.

---

## Quickstart

`friends` is consumed two ways. Use the **library** when you're writing code that owns the agent;
use the **MCP server** when you want any MCP-speaking harness to call the same surface as tools.

### Install

```sh
npm install @ouro.bot/friends
```

### A) The library — the `FriendStore` seam + the core API

Two seams. You bring a **store**; you resolve through the **resolver**.

```ts
import { openFileBundle, FriendResolver, describeTrustContext } from "@ouro.bot/friends"

// 1. A store — where friend records live. openFileBundle persists one JSON file per
//    friend under the directory you give it (and wires the sibling _grants/ /
//    _missions/ collections). Or implement FriendStore yourself — see "Bring your
//    own storage".
const { store } = openFileBundle("/path/to/bundle/friends")

// 2. A resolver — turns an incoming external identity into a FriendRecord + the
//    capabilities of the channel it arrived on. Created per incoming message.
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
`FileFriendStore` adapter — so you can back friends with anything (in-memory, a database, a remote
service) by implementing the interface. The full public surface is listed under
[Public API](#public-api).

### B) The MCP server — `friends-mcp`

`@ouro.bot/friends` ships an MCP server that exposes the library as a tool surface for any
MCP-speaking harness. **The server runs no agent turn — it is a pure record read/write surface over
the library, which is exactly what makes it harness-agnostic.** Each tool call reads or writes
friend records against a directory you point it at.

The store directory is the **only** coupling between the server and a bundle. Provide it with
`--dir <path>` or the `FRIENDS_DIR` environment variable (**the flag wins** when both are set, and
one of them is required — the server exits otherwise). It points at the bundle's `friends/`
directory — the same directory a `FileFriendStore` persists to.

A sample `.mcp.json`:

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

For local development against a checkout, point at the built binary instead:

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

You can also `npm pack` then
`npx -y --package ./ouro.bot-friends-<version>.tgz friends-mcp --dir <path>`, or `npm link` then
`friends-mcp --dir <path>`. The server speaks JSON-RPC 2.0 over stdio with **dual framing** —
Content-Length and newline-delimited JSON — auto-detected from the first message, so it works with
harnesses on either convention.

#### The tool surface — 32 tools

A thin 1:1 mapping over the library (no domain logic in the server):

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
| `connect_to` | **Control plane** — the owner links one of their OWN agents into the fleet (introduce a peer by agentId/did/name at a trust level, default `family`). Authority-gated to a management sense (`local` commits; an `open` sense downgrades to a confirm-prompt; `closed` is gated by a roster/membership check); a bare name with no resolvable handle/DID returns `needs_handle_or_introduction` (never fabricates). Writes an `action:"connect"` control-plane audit. |
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
| `assess_standing` | Assess a peer's **earned standing** from your first-party outcomes — a tier + basis count + tally. Advisory; never writes trust, never shared. |
| `explain_standing` | Explain a peer's earned standing in words (tier, why, advisory notes — never an instruction to change trust). |
| `coordinate` | **Producer** — prepare a coordination message (`request` / `offer` / `accept` / `decline` / `handoff`) that negotiates **who** does a mission. |
| `import_coordination` | **Consumer** — import a coordination message (appends to the mission's coordination log; only a self-`accept` sets the assignee; a `handoff` never forces one). |
| `get_coordination` | Read a mission's coordination state — its current assignee + the append-only negotiation log. |
| `send_result` | **Producer** — return B's DELIVERABLE for a delegation, attributed to B + correlated to A's task-spec by `requestId`, named by the mission's `missionKey` (consent-gated via the `coordinate` scope). |
| `import_result` | **Consumer** — import a result-return; lands B's deliverable quarantined + attributed under `importedResults`, trust-capped; a result whose `requestId` matches no prior first-party delegation is rejected (`no_delegation`); never recomputes status. |

The consent tools (`share_profile` / `import_profile` / `grant_share` / `revoke_share` /
`list_shares`) need a **grant store**; the mission, coordination, and result-return tools
(`send_result` consumes both) need a **mission store**. The `friends-mcp` binary wires both
automatically at sibling `_grants/` and `_missions/` directories under `--dir` (plus the
`_audit/` control-plane log `connect_to` / `set_trust` write through). An embedded server gets
them by passing `grants` / `missions` / `audit` to `createFriendsMcpServer`. Without the
relevant store, those tools report `{ ok: false, status: "unsupported" }` and everything else
works store-only.

The server module is consumed in code from the `@ouro.bot/friends/mcp` subpath, exporting
`createFriendsMcpServer`, `getToolSchemas`, and `runMain`.

---

## Trust & consent model

This is the differentiator. The whole package is built so that **what you know stays yours**, and
**what crosses between agents is deliberate, scoped, audited, and revocable.**

### The trust ladder

| Level | Meaning | Grants |
|---|---|---|
| `family` | The machine owner and those closest. | Full tool access, proactive follow-through, local operations. |
| `friend` | A directly-trusted relationship. | Full collaborative access (same as family for gating purposes). |
| `acquaintance` | Known through a **shared group** context, not direct endorsement. | Group-safe coordination; guarded local actions. |
| `stranger` | Cold first contact. | Safe orientation only; no privileged actions. |

`family` and `friend` are the **trusted** levels (`TRUSTED_LEVELS` / `isTrustedLevel`) — they
unlock full tool access and proactive sends. `acquaintance` and `stranger` are gated.

Trust is **assigned, not guessed**:

- **First contact** on a populated bundle starts at `stranger`.
- The **machine owner** (the OS user running the agent) resolves to `family` — they own the agent
  and its bundle, so they are never a stranger.
- A **shared group** (a group chat) promotes its participants from `stranger` to `acquaintance` —
  the agent now knows them *through* a context it trusts (`upsertGroupContextParticipants`).

### Consent-gated sharing

Two *different* agents (different owners) can agree a party is the same person **and** share what
they know about them — **with consent**. The package does the **authorization** (how much a verified
peer's claims count, via the trust ladder); **authentication of the wire** is plugged in through an
`AgentVerifier` (defaulting to trust-on-first-use, upgradable to DID/VC with no envelope change).

Consent itself is an explicit, auditable, **revocable** grant — `grant_share` / `revoke_share` /
`list_shares` are the right-to-be-forgotten seam. The producer is gated by a **`ConsentPolicy`**, and
three postures ship behind one swap point (`DEFAULT_CONSENT_POLICY` in `src/consent.ts`):

- **`strictPolicy`** — consented only by a non-revoked, non-expired explicit grant.
- **`trustImpliedPolicy`** — an explicit grant, *or* recipient trust ≥ `friend` (any scope).
- **`tieredPolicy`** *(default)* — identity-scope shares (the join key) are consented on recipient
  trust ≥ `friend`; any **note-content scope** requires an explicit grant. *(Trust agrees on who;
  content still needs consent.)*

### The safety invariants

Each is **structurally enforced** and tested — they are properties of the domain logic, not of any
particular storage backend, so they hold even if you bring your own:

- **First-party is inviolable.** Imported facts land in a **separate namespace** (`importedNotes` /
  `importedLearnings`, stamped `origin: "imported"` + `assertedBy` + `importedAt`). First-party
  `notes` / `learnings` are **physically untouchable; first-party always wins.**
- **Trust is non-transitive.** An import **never** changes the party's trust level — the single most
  important invariant. A peer vouching for someone cannot promote them in *your* graph.
- **Source trust caps acceptance.** A `stranger` source is refused; the floor is configurable.
  Seeding an *unknown* party (at `acquaintance`) requires a `friend`/`family` introducer.
- **No laundering.** A first-party note shared onward is attributed to *this* agent; an imported note
  carries its `originallyAssertedBy` through, so an imported fact can never be re-shared as
  first-party.
- **Reputation stays home.** `standing` is first-party-only, never writes trust, and **never crosses
  the wire** — there is no type to express it on a message (the anti-Sybil core).
- **Coordination grants no authority.** A mission's `assignee` is advisory metadata; claiming a
  mission gives a peer no capability it didn't already have, and a `handoff` never forces an
  assignment onto a receiver (only their own `accept` sets it).

The load-bearing consequence: **the security of the system does not depend on the security of the
transport.** A hostile mailbox can deny or replay, but never escalate.

---

## Bring your own storage

**`friends` never decides where or how your data lives.** *Where* is the path / connection string
you pass; *how* is a `FriendStore` / `GrantStore` / `MissionStore` implementation you choose or write.
The core domain logic — resolver, trust, notes, consent, share, import, mission ledger, standing,
coordination — is **100% persistence-agnostic**: it only ever calls the store interfaces.

`openFileBundle` is the one-liner for the filesystem case, encapsulating the sibling collection
conventions (the explicit construction stays available):

```ts
import { openFileBundle } from "@ouro.bot/friends"

const { store, grants, missions } = openFileBundle("/bundle/friends")
//   grants   → /bundle/friends/_grants
//   missions → /bundle/friends/_missions
```

### The store seams as a contract

A third-party backend implements the store interfaces. Get these three behaviors right or
cross-channel / cross-agent unification breaks:

- **`findByExternalId(provider, externalId, tenantId?)`** — the cross-agent join-key lookup. A match
  requires `provider` + `externalId` **and** (`tenantId` undefined ⇒ any tenant, else an exact
  tenant match). This is how the same person is recognized across channels and how an import resolves
  its subject by join key.
- **`get(id)` — UUID-then-name fallback.** Look up by UUID first; if not found, fall back to a
  **case-insensitive name** lookup (the documented path for proactive sends). A DB backend should
  index the UUID and MAY implement the name fallback.
- **Round-trip discipline (load-bearing).** A backend MUST preserve the **full `FriendRecord`
  losslessly** — including `importedNotes` **and future additive fields**. Storing a lossy projection
  breaks the schemaVersion-1 guarantee for non-file backends. Prefer storing the **whole record as a
  JSON blob keyed by id**, with side indexes for lookups.

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

`GrantStore` and `MissionStore` are the same shape — an id-keyed JSON blob. Swap any store in and
**every import-safety invariant still holds**, because they are structural properties of the domain
logic, not of the filesystem.

---

## Examples — runnable, cross-agent proofs

Every guarantee above is demonstrated by a runnable script under [`examples/`](./examples). Each
spins up **two separate stores** (often two separate `friends-mcp` processes) — two *different*
agents — exchanges real envelopes between them, and **hard-asserts every invariant**, printing a
green transcript per step and exiting non-zero (with a loud banner) on any violation. They are
**git-free** (the A2A demos exchange through a temp mailbox dir), so they reproduce anywhere with no
network.

```sh
npm run example:cross-agent-moat            # identity join key + consent-gated profile share,
                                            #   first-party-inviolable, trust non-transitive
npm run example:mailbox-fallback            # the git-mailbox FALLBACK: path-binding, replay-safety,
                                            #   spoof rejection, hostile-mailbox tamper
npm run example:cross-agent-mission-memory  # the mission ledger: shareable vs private learnings,
                                            #   first-party-wins, status non-transitive
npm run example:cross-agent-standing        # earned standing: first-party-only, never-on-the-wire,
                                            #   inert on trust
npm run example:cross-agent-coordination    # the five coordination verbs end-to-end: assignment,
                                            #   non-transitive handoff, last-writer-wins, seeding gate
npm run example:cross-agent-delegation      # own-fleet delegation: two of the owner's agents,
                                            #   same-account family (signed roster), connect_to link,
                                            #   A delegates → B performs → B returns the result → A
                                            #   imports it — every invariant hard-asserted
```

Read them as the honest spec of what the package promises: if a guarantee weren't real, the
matching example would exit 1.

---

## Channels & observability

Each channel an agent speaks on (`cli`, `teams`, `bluebubbles`, `mail`, `voice`, `a2a`, `inner`,
`mcp`) has fixed **capabilities** — its sense type (`open` / `closed` / `local` / `internal`), which
integrations it exposes, and whether it supports markdown, streaming, and rich cards. Look them up
with `getChannelCapabilities`. The sense type, combined with trust, is what decides whether a
first-contact stranger reaches the full model on an open channel.

The package emits structured events through `emitNervesEvent`. By default these are **dropped**
(no-op), so the package is fully self-contained. To forward them to your logging / observability
pipeline, inject an emitter once at startup:

```ts
import { setNervesEmitter } from "@ouro.bot/friends"

setNervesEmitter((event) => {
  // forward `event` to your logging / observability pipeline
})
```

---

## Design notes & status

- **Store-only, transport-agnostic, additive.** The six layers were each built as a minimal
  primitive that does not modify the layers beneath it. The cross-agent envelopes are plain data; the
  wire is always the caller's job (the `./mailbox` git-mailbox is one optional, host-driven fallback). A
  CI-enforced dependency rule keeps the core from ever importing the transport.
- **One persisted schema, additively grown.** Records are `schemaVersion: 1`; every layer added
  optional fields and sibling collections rather than changing existing meaning, so older data reads
  clean.
- **Not a workflow engine.** Each layer deliberately refuses the larger machine it brushes against:
  the mission ledger is not a knowledge base, standing is not a reputation engine, coordination is not
  a scheduler, and the delegation channel is a deliverable return — not a remote-exec grant. The
  discipline is the point.
- **Alpha.** The surface is feature-complete across the six layers but pre-1.0 — expect additive
  changes, and pin a version. Feedback and issues are welcome.

### Public API

**Types:** `FriendRecord`, `FriendConnection`, `ExternalId`, `IdentityProvider`, `Integration`,
`Channel`, `TrustLevel`, `AgentMeta`, `AgentAttribution`, `RelationshipOutcome`, `NoteProvenance`,
`ImportedNote`, `ShareScope`, `ShareGrant`, `MissionKey`, `MissionLearning`, `ImportedLearning`,
`MissionRecord`, `CoordinationIntent`, `CoordinationLogEntry`, `MissionCoordination`,
`ChannelCapabilities`, `ResolvedContext`, `SenseType`, `Facing`, `TrustExplanation`, `TrustBasis`,
`Standing`, `StandingTier`, `StandingTally`, `StandingExplanation`, `StandingRule`,
`StandingRuleInput`, `FriendStore`, `GrantStore`, `MissionStore`, `FriendResolverParams`,
`GroupContextParticipant`, `GroupContextUpsertResult`, `UsageData`, `FriendOpResult`,
`FriendOpStatus`, `ApplyFriendNoteInput`, `WhoamiResult`, `RoomView`, `RoomMember`, `RoomKnownVia`,
`ConsentPolicy`, `ConsentRecipient`, `ConsentDecisionInput`, `AgentVerifier`, `ProfileShareEnvelope`,
`SharedNote`, `PrepareProfileShareInput`, `PrepareProfileShareResult`, `PrepareProfileShareStatus`,
`ImportProfileShareInput`, `ImportProfileShareOptions`, `ImportProfileShareResult`,
`ImportProfileShareStatus`, `GrantShareInput`, `RevokeShareResult`, `ListSharesFilter`, `ListedShare`,
`FileBundle`, `NervesEvent`, `NervesEmitter`, `LogLevel`, `RecordMissionInput`,
`MissionShareEnvelope`, `SharedLearning`, `PrepareMissionShareInput`, `PrepareMissionShareResult`,
`PrepareMissionShareStatus`, `ImportMissionShareInput`, `ImportMissionShareOptions`,
`ImportMissionShareResult`, `ImportMissionShareStatus`, `CoordinationEnvelope`,
`PrepareCoordinationInput`, `PrepareCoordinationResult`, `PrepareCoordinationStatus`,
`ImportCoordinationInput`, `ImportCoordinationOptions`, `ImportCoordinationResult`,
`ImportCoordinationStatus`, `SetFriendTrustContext`, `AuditSink`, `ControlPlaneAuditRecord`,
`ResolvedAgentIdentity`, `RosterStore`, `AccountRoster`, `RosterPin`, `RosterVerifier`,
`AccountMembershipDecision`, `AccountMembershipResult`, `EvaluateAccountMembershipInput`,
`FriendResolverRosterContext`, `ConnectPeer`, `ConnectAgentsInput`, `ConnectAgentsDeps`,
`ConnectResult`, `ConnectStatus`, `AuthorizeConnectInput`, `ConnectAuthorization`, `MissionTaskSpec`,
`MissionResult`, `MissionResultEnvelope`, `PrepareMissionResultInput`, `PrepareMissionResultResult`,
`PrepareMissionResultStatus`, `ImportMissionResultInput`, `ImportMissionResultOptions`,
`ImportMissionResultResult`, `ImportMissionResultStatus`. (`TrustBasis` additively gains the
`"same_account"` member — the basis for family granted via the signed account roster — and `AgentMeta`
additively gains an optional `identity { did, pinnedKey?, handle?, pinnedAt? }` durable-identity home;
both are schemaVersion-1 additive, and a legacy `a2a.did` migrates-on-read into `identity.did`.
`MissionRecord` additively gains the own-fleet delegation namespaces `delegations` / `importedDelegations`
(gap-1) and `results` / `importedResults` (gap-2), and `ControlPlaneAuditRecord.action` widens additively
to `"set_trust" | "connect"`.)

**Values:** `TRUSTED_LEVELS`, `IDENTITY_SCOPES`, `isTrustedLevel`, `isIdentityProvider`,
`isIntegration`, `isShareScope`, `isCoordinationIntent`, `FileFriendStore`, `FileGrantStore`,
`grantsDirFor`, `FileMissionStore`, `missionsDirFor`, `openFileBundle`, `FriendResolver`,
`machineOwnerUsername`, `isLocalMachineOwnerIdentity`, `getChannelCapabilities`, `channelToFacing`,
`isRemoteChannel`, `getAlwaysOnSenseNames`, `describeTrustContext`, `assessStanding`,
`explainStanding`, `DEFAULT_STANDING_RULE`, `upsertGroupContextParticipants`, `accumulateFriendTokens`,
`applyFriendNote`, `setFriendTrust`, `linkExternalId`, `unlinkExternalId`, `upsertAgentPeer`,
`recordRelationshipOutcome`, `recordMission`, `whoami`, `resolveRoom`, `strictPolicy`,
`trustImpliedPolicy`, `tieredPolicy`, `DEFAULT_CONSENT_POLICY`, `tofuVerifier`,
`DEFAULT_AGENT_VERIFIER`, `prepareProfileShare`, `importProfileShare`, `prepareMissionShare`,
`importMissionShare`, `prepareCoordination`, `importCoordination`, `grantShare`, `revokeShare`,
`listShares`, `isGrantEffective`, `setNervesEmitter`, `emitNervesEvent`, `resolveAgentIdentity`,
`withMigratedIdentity`, `findFriendByDid`, `MemoryAuditSink`, `FileAuditSink`, `auditPathFor`,
`FileRosterStore`, `rostersDirFor`, `MemoryRosterStore`, `identityRosterVerifier`,
`DEFAULT_ROSTER_VERIFIER`, `evaluateAccountMembership`, `connectAgents`, `authorizeConnect`,
`prepareMissionResult`, `importMissionResult`.

**From `@ouro.bot/friends/mcp`:** `createFriendsMcpServer`, `getToolSchemas`, `runMain` (plus the
`McpToolSchema`, `FriendsMcpServer`, and `RunMainIo` types).

**From `@ouro.bot/friends/mailbox`:** `buildOutgoing`, `readIncoming`, `markSeen`, `isSeen`,
`compareReady`, `MAILBOX_VERSION` (plus the `MailboxMessage`, `BuildOutgoingInput`,
`BuildOutgoingResult`, `IncomingFile`, `IncomingMessage`, `ReadIncomingInput`, `ReadIncomingResult`,
`RejectedMessage`, `SeenLedger` types).

**From `@ouro.bot/friends/a2a-client`** (the real-A2A adapter + the E2E overlay): `sendShare`,
`receiveShare`, `resolveReachability`; `sealEnvelope` / `openSealedEnvelope`; `wrapInDataPart` /
`unwrapDataPart`; `buildFriendsAgentCard`; `DidVerifier`, `evaluateRotation`, `signSuccessor`,
`verifyCardDidBinding`, `pinOnFirstContact` / `isPinned` / `getPinned`, `MemoryPinStore`; the
identity helpers `parseDidKey` / `keyAgreementFromDidKey` / `didKeyIdentityFromEd25519` /
`ed25519PubToDidKey` and `didWebToUrl` / `resolveDidWeb` / `parseDidDocument`; the primitives
`sealTo` / `openSealed`, `signEnvelope` / `verifyEnvelopeSignature`, `jcsString` / `jcsBytes`, and
the `ready` init seam; and the account-roster Ed25519 verify `ed25519RosterVerifier` / `signRoster`
(the crypto implementation of the core `RosterVerifier` seam — host-injected, so the core stays
transport-free) (plus the `A2ATransport`, `DidResolution`, `SealedEnvelope`, `StructuredProof`,
`ReachabilityPlan`, `FriendsAgentCard`, `DidKeyIdentity`, `DidDocument` types). The transports
(direct A2A / relay / git op) are injected by the host — this module does no network or git itself.

## License

[Apache-2.0](./LICENSE)
