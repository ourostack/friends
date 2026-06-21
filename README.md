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

14 tools, a thin 1:1 mapping over the library (no domain logic in the server):

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
| `share_profile` | **Reserved (P1)** — returns `{ supported: false }` until federation lands. |

The server module is consumed in code from the `@ouro.bot/friends/mcp` subpath, exporting
`createFriendsMcpServer`, `getToolSchemas`, and `runMain` (plus the `McpToolSchema`,
`FriendsMcpServer`, and `RunMainIo` types).

## Public API

**Types:** `FriendRecord`, `FriendConnection`, `ExternalId`, `IdentityProvider`, `Channel`,
`TrustLevel`, `AgentMeta`, `RelationshipOutcome`, `NoteProvenance`, `ChannelCapabilities`,
`ResolvedContext`, `SenseType`, `Facing`, `TrustExplanation`, `TrustBasis`, `FriendStore`,
`FriendResolverParams`, `GroupContextParticipant`, `GroupContextUpsertResult`, `UsageData`,
`FriendOpResult`, `FriendOpStatus`, `ApplyFriendNoteInput`, `WhoamiResult`, `NervesEvent`.

**Values:** `TRUSTED_LEVELS`, `isTrustedLevel`, `isIdentityProvider`, `FileFriendStore`,
`FriendResolver`, `machineOwnerUsername`, `isLocalMachineOwnerIdentity`,
`getChannelCapabilities`, `channelToFacing`, `isRemoteChannel`, `getAlwaysOnSenseNames`,
`describeTrustContext`, `upsertGroupContextParticipants`, `accumulateFriendTokens`,
`applyFriendNote`, `setFriendTrust`, `linkExternalId`, `unlinkExternalId`, `upsertAgentPeer`,
`recordRelationshipOutcome`, `whoami`, `setNervesEmitter`.

**From `@ouro.bot/friends/mcp`:** `createFriendsMcpServer`, `getToolSchemas`, `runMain`.

## License

[Apache-2.0](./LICENSE)
