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
    // Transport-agnostic dependency direction (see p4 design A1): the moat core
    // must NEVER import from src/a2a/. a2a may import core (share/types/verifier)
    // — the reverse is forbidden so the core stays transport-free.
    files: ["src/**/*.ts"],
    ignores: ["src/a2a/**", "src/__tests__/**"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/a2a", "**/a2a/**"],
          message: "core must not import from src/a2a/ (transport-agnostic split — see p4 design A1)",
        }],
      }],
    },
  },
  {
    // src/a2a/ is a pure transport library — it must NEVER import from src/mcp/
    // (the server surface). The wire/dispatch direction is a2a ← mcp, never a2a → mcp.
    files: ["src/a2a/**/*.ts"],
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
          message: "src/a2a/ must not import from src/mcp/ (the pure transport library stays server-free)",
        }],
      }],
    },
  },
]
