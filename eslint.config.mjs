// @ts-check

import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";
import autoImports from "./.wxt/eslint-auto-imports.mjs";

export default defineConfig([
  autoImports,
  globalIgnores([
    ".output/",
    ".wxt/",
    ".scratch/",
    ".agents/",
    ".idea/",
    "coverage/",
    "dist/",
    "**/dist/",
    "logs/",
    "playwright-report/",
    "test-results/",
    "blob-report/",
    "web-ext-artifacts/",
    "**/stats.html",
    "**/stats-*.json",
    "**/*.min.js",
    "**/*.min.css",
  ]),
  {
    files: ["**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      tseslint.configs.stylistic,
      reactHooks.configs.flat.recommended,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  {
    files: ["{components,entrypoints,lib,shared,tests,e2e}/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?:\\.\\./|\\./[^/]+/)",
              message:
                "Use @/ across directories; keep ./ for same-directory imports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["e2e/**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}"],
    rules: {
      // Playwright fixtures use `use` and `async ({}, use)` — not React Hooks.
      "react-hooks/rules-of-hooks": "off",
      "no-empty-pattern": "off",
    },
  },
  {
    files: ["scripts/**/*.{js,mjs,ts,mts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  eslintConfigPrettier,
]);
