// runMain — the covered core of the `friends-mcp` bin.
//
// Resolves the friends directory from `--dir <path>` (flag wins) or the
// `FRIENDS_DIR` environment variable, constructs a FileFriendStore over it, and
// starts an MCP server on the given streams. If neither source supplies a
// directory, it reports via `onError` and constructs nothing (returns null).
import { emitNervesEvent } from "../observability"
import { openFileBundle } from "../file-bundle"
import { createFriendsMcpServer } from "./server"
import type { FriendsMcpServer } from "./server"

export interface RunMainIo {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  onError: (message: string) => void
}

/** Parse `--dir <value>` from argv. Returns the value, or undefined if the flag
 * is absent or has no following value. */
function parseDirFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf("--dir")
  if (idx === -1) return undefined
  const value = argv[idx + 1]
  if (value === undefined) return undefined
  return value
}

export function runMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: RunMainIo,
): FriendsMcpServer | null {
  const flagDir = parseDirFlag(argv)
  const dir = flagDir ?? env.FRIENDS_DIR
  const source = flagDir !== undefined ? "flag" : "env"

  if (!dir) {
    io.onError("friends-mcp requires --dir <path> or FRIENDS_DIR")
    return null
  }

  emitNervesEvent({
    component: "clients",
    event: "clients.mcp_run_main",
    message: "friends mcp run-main",
    meta: { source },
  })

  // The consent-grant collection is a sibling `_grants/` dir under the friends
  // dir, so the single `--dir` wires the whole substrate (friends + consent).
  // `openFileBundle` encapsulates that sibling-dir convention.
  const { store, grants } = openFileBundle(dir)
  const server = createFriendsMcpServer({ store, grants, stdin: io.stdin, stdout: io.stdout })
  server.start()
  return server
}
