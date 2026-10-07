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
    files: FORMATTED,
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/brace-style": ["error", "allman", { allowSingleLine: true }],
      // Re-indent after moving braces, and tidy what's left behind.
      "@stylistic/indent": ["error", 4, { SwitchCase: 1 }],
      "@stylistic/no-trailing-spaces": "error",
    },
  },
]);

export default eslintConfig;
