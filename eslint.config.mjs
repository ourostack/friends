import tseslint from "typescript-eslint"

export default [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/__tests__/**"],
    languageOptions: {
      parser: tseslint.parser,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-console": "error",
    },
  },
  {
    // Transport-agnostic dependency direction (see p4 design A1 + p8): the moat
    // core must NEVER import from src/mailbox/ (the git-mailbox fallback) OR
    // src/a2a-client/ (the host-side A2A + crypto overlay). Both transports may
    // import core (share/types/verifier) — the reverse is forbidden so the core
    // stays transport-free and zero-runtime-dep.
    files: ["src/**/*.ts"],
    ignores: ["src/mailbox/**", "src/a2a-client/**", "src/__tests__/**"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/mailbox", "**/mailbox/**", "**/a2a-client", "**/a2a-client/**"],
          message: "core must not import from src/mailbox/ or src/a2a-client/ (transport-agnostic split — see p4 design A1 + p8)",
        }],
      }],
    },
  },
  {
    // src/mailbox/ is a pure transport library — it must NEVER import from src/mcp/
    // (the server surface). The wire/dispatch direction is mailbox ← mcp, never
    // mailbox → mcp.
    files: ["src/mailbox/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/mcp", "**/mcp/**"],
          message: "src/mailbox/ must not import from src/mcp/ (the pure transport library stays server-free)",
        }],
      }],
    },
  },
  {
    // src/a2a-client/ is the host-side A2A + E2E crypto overlay — it must NEVER
    // import from src/mcp/ (the server surface). The host adapter stays
    // server-surface-free; a2a-client MAY import core.
    files: ["src/a2a-client/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/mcp", "**/mcp/**"],
          message: "src/a2a-client/ must not import from src/mcp/ (the host adapter stays server-free)",
        }],
      }],
    },
  },
]
