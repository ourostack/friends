// whoami — "who am I?" self-resolution over a friend store.
//
// D5 heuristic: the machine owner is the OS user running the process. The self
// friend is the record whose externalIds include a `local` entry matching the
// owner username (bare or `user@host`); if none matches by local id, the first
// `family` friend is used as a fallback. When the owner is undetectable, or no
// friend matches, only `machineOwner` is returned (no self fields).
import { machineOwnerUsername, isLocalMachineOwnerIdentity } from "./resolver"
import { emitNervesEvent } from "./observability"
import type { FriendStore } from "./store"
import type { FriendRecord } from "./types"

export interface WhoamiResult {
  machineOwner: string | null
  selfAgentName?: string
  selfFriendId?: string
}

export async function whoami(store: FriendStore): Promise<WhoamiResult> {
  const machineOwner = machineOwnerUsername()

  if (typeof store.listAll !== "function") {
    emitNervesEvent({
      component: "friends",
      event: "friends.whoami",
      message: "resolved machine owner self",
      meta: { hasSelf: false },
    })
    return { machineOwner }
  }

  const all = await store.listAll()
  let self: FriendRecord | undefined
  if (machineOwner) {
    self = all.find((f) =>
      f.externalIds.some((e) => isLocalMachineOwnerIdentity(e.provider, e.externalId, machineOwner)),
    )
    self ??= all.find((f) => f.trustLevel === "family")
  }

  emitNervesEvent({
    component: "friends",
    event: "friends.whoami",
    message: "resolved machine owner self",
    meta: { hasSelf: Boolean(self) },
  })

  return self
    ? { machineOwner, selfFriendId: self.id, selfAgentName: self.name }
    : { machineOwner }
}
