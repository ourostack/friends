// Public-API barrel guard (p11 inc2 surface). Asserts the new connect_to + result-return
// symbols are reachable from the package root export, so a future refactor can't silently
// drop them. Mirrors a2a-client-index.test.ts's export-completeness style.
import { describe, it, expect } from "vitest"

import * as friends from "../index"
import type {
  // connect_to surface
  ConnectPeer,
  ConnectAgentsInput,
  ConnectAgentsDeps,
  ConnectResult,
  ConnectStatus,
  AuthorizeConnectInput,
  ConnectAuthorization,
  // gap-1 task-spec
  MissionTaskSpec,
  // gap-2 result-return
  MissionResult,
  MissionResultEnvelope,
  PrepareMissionResultInput,
  PrepareMissionResultResult,
  PrepareMissionResultStatus,
  ImportMissionResultInput,
  ImportMissionResultOptions,
  ImportMissionResultResult,
  ImportMissionResultStatus,
} from "../index"

describe("public API barrel — p11 inc2 surface", () => {
  it("exports the connect_to library fn + the authority predicate", () => {
    expect(typeof friends.connectAgents).toBe("function")
    expect(typeof friends.authorizeConnect).toBe("function")
  })

  it("exports the result-return producer + consumer", () => {
    expect(typeof friends.prepareMissionResult).toBe("function")
    expect(typeof friends.importMissionResult).toBe("function")
  })

  it("the new types are reachable from the barrel (compile-time)", () => {
    // A representative value typed against each new exported type — fails to compile if
    // the type is not exported from the barrel.
    const peer: ConnectPeer = { agentId: "a" }
    const connectIn: ConnectAgentsInput = { peer, senseType: "local" }
    const connectDeps: ConnectAgentsDeps = { actor: "owner:stdio", originSense: "stdio" }
    const connectRes: ConnectResult = { ok: false, status: "needs_handle_or_introduction" }
    const connectStatus: ConnectStatus = "connected"
    const authIn: AuthorizeConnectInput = { senseType: "local" }
    const auth: ConnectAuthorization = { decision: "commit" }
    const task: MissionTaskSpec = { requestId: "r", summary: "s" }
    const result: MissionResult = { requestId: "r", summary: "s" }
    const env: MissionResultEnvelope = { subject: { missionKey: "k", title: "t" }, fromAgentId: "b", requestId: "r", result, issuedAt: "now" }
    const prepIn: PrepareMissionResultInput = { missionId: "m", toAgentId: "a", requestId: "r", result: { summary: "s" }, selfAgentId: "b" }
    const prepRes: PrepareMissionResultResult = { ok: true, envelope: env }
    const prepStatus: PrepareMissionResultStatus = "no_consent"
    const impIn: ImportMissionResultInput = { envelope: env, fromAgentId: "b", trustOfSource: "family" }
    const impOpts: ImportMissionResultOptions = {}
    const impRes: ImportMissionResultResult = { ok: false, status: "no_delegation" }
    const impStatus: ImportMissionResultStatus = "imported"
    expect([peer, connectIn, connectDeps, connectRes, connectStatus, authIn, auth, task, result, env, prepIn, prepRes, prepStatus, impIn, impOpts, impRes, impStatus].length).toBe(17)
  })
})
