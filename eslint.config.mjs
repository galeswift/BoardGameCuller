import { defineConfig, globalIgnores } from "eslint/config";
import stylistic from "@stylistic/eslint-plugin";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { FORMATTED } from "./formatted-files.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["components/ui/**/*.{ts,tsx}", "hooks/use-mobile.ts"],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // House style: opening braces on their own line. Prettier handles the rest
    // (see `pnpm format`); only files already converted are checked.
    // ESLint flat config takes positive globs here; exclusions go in `ignores`.
    files: FORMATTED.filter((p) => !p.startsWith("!")),
    ignores: FORMATTED.filter((p) => p.startsWith("!")).map((p) => p.slice(1)),
    plugins: { "@stylistic": stylistic },
    rules: {
      // Every if/else/for/while body in braces, each brace on its own line.
      curly: ["error", "all"],
      // One declaration per statement, never `const a = 1, b = 2`.
      "one-var": ["error", "never"],
      "@stylistic/brace-style": ["error", "allman"],
      // Blank lines between logical steps: around blocks, after declarations,
      // before returns, and between top-level definitions.
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        { blankLine: "any", prev: ["const", "let", "var"], next: ["const", "let", "var"] },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "*", next: ["function", "export", "interface", "type"] },
        { blankLine: "any", prev: "import", next: "import" },
      ],
      // Re-indent after moving braces, and tidy what's left behind.
      "@stylistic/indent": ["error", 4, { SwitchCase: 1 }],
      "@stylistic/no-trailing-spaces": "error",
    },
  },
]);

export default eslintConfig;
