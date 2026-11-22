// runMain — the covered core of the `friends-mcp` bin.
//
// Resolves the friends directory from `--dir <path>` (flag wins) or the
// `FRIENDS_DIR` environment variable, constructs a FileFriendStore over it, and
// starts an MCP server on the given streams. If neither source supplies a
// directory (missing-dir), or argv holds anything but `--dir <path>`
// (unknown-door), it reports via `onError` and constructs nothing (returns null).
import { emitNervesEvent } from "../observability"
import { openFileBundle } from "../file-bundle"
import { createFriendsMcpServer } from "./server"
import type { FriendsMcpServer } from "./server"

export interface RunMainIo {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  onError: (message: string) => void
}

/** The codes an error message leads with, so an agent can match the failure without parsing its words. */
const MISSING_DIR = "missing-dir"
const UNKNOWN_DOOR = "unknown-door"

/** Parse `--dir <value>` from argv, the only argument the bin takes. Returns the
 * value (undefined if the flag is absent or has no following value), or the
 * first argument that isn't `--dir <value>`. */
function parseArgs(argv: string[]): { dir: string | undefined; unknown?: string } {
  const args = argv.slice(2)
  let dir: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--dir") return { dir, unknown: args[i] }
    dir = args[i + 1]
    i += 1
  }
  return { dir }
}

export function runMain(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: RunMainIo,
): FriendsMcpServer | null {
  const { dir: flagDir, unknown } = parseArgs(argv)
  if (unknown !== undefined) {
    io.onError(`${UNKNOWN_DOOR}: friends-mcp takes only --dir <path>, not '${unknown}'`)
    return null
  }
  const dir = flagDir ?? env.FRIENDS_DIR
  const source = flagDir !== undefined ? "flag" : "env"

  if (!dir) {
    io.onError(`${MISSING_DIR}: friends-mcp requires --dir <path> or FRIENDS_DIR`)
    return null
  }

  emitNervesEvent({
    component: "clients",
    event: "clients.mcp_run_main",
    message: "friends mcp run-main",
    meta: { source },
  })

  // The consent-grant + mission + audit collections are sibling `_grants/`,
  // `_missions/`, `_audit/` dirs under the friends dir, so the single `--dir` wires the
  // whole substrate. `openFileBundle` encapsulates that convention.
  const { store, grants, missions, audit } = openFileBundle(dir)
  // SECURITY (finding 3 / 3-A): thread the FileAuditSink into the live server so trust
  // mutations are audited. The `friends-mcp` bin speaks owner-only stdio, so the
  // default actor/originSense (the stdio owner boundary) is the correct attribution.
  const server = createFriendsMcpServer({ store, grants, missions, audit, stdin: io.stdin, stdout: io.stdout })
  server.start()
  return server
}
