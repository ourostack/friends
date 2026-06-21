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

## Public API

**Types:** `FriendRecord`, `FriendConnection`, `ExternalId`, `IdentityProvider`, `Channel`,
`TrustLevel`, `AgentMeta`, `RelationshipOutcome`, `ChannelCapabilities`, `ResolvedContext`,
`SenseType`, `Facing`, `TrustExplanation`, `TrustBasis`, `FriendStore`, `FriendResolverParams`,
`GroupContextParticipant`, `GroupContextUpsertResult`, `UsageData`, `NervesEvent`.

**Values:** `TRUSTED_LEVELS`, `isTrustedLevel`, `isIdentityProvider`, `FileFriendStore`,
`FriendResolver`, `machineOwnerUsername`, `isLocalMachineOwnerIdentity`,
`getChannelCapabilities`, `channelToFacing`, `isRemoteChannel`, `getAlwaysOnSenseNames`,
`describeTrustContext`, `upsertGroupContextParticipants`, `accumulateFriendTokens`,
`setNervesEmitter`.

## License

[Apache-2.0](./LICENSE)
