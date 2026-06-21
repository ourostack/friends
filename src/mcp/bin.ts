#!/usr/bin/env node
// friends-mcp — stdio entrypoint for the friends MCP server.
//
// Thin wrapper: all arg-parsing and store construction live in `runMain` (which
// is covered by tests). This file is the only module excluded from coverage —
// its sole uncovered lines are the process wiring below.
import { runMain } from "./run-main"

runMain(process.argv, process.env, {
  stdin: process.stdin,
  stdout: process.stdout,
  onError: () => {
    process.exitCode = 1
  },
})
