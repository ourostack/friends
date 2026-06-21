// @ouro.bot/friends/a2a-client — host-side A2A adapter + the friends E2E
// security overlay (sign-then-seal + DID identity). Placeholder barrel; the
// public surface is filled in across the build (see U9).
//
// This is the ONLY directory permitted to import libsodium / A2A / DID. The
// dependency-direction lint enforces: core ⊥ a2a-client, a2a-client ⊥ mcp.
export {}
