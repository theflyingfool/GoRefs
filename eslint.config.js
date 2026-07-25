import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import json from "@eslint/json";
import markdown from "@eslint/markdown";
import css from "@eslint/css";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: [
      "build/**",
      "dist/**",
      "android/**",
      "node_modules/**",
      ".claude/**",
      // Rust build artifacts (Cargo target dir + Tauri's generated mobile
      // project) — not project source, not meant to be linted. Mirrors
      // src-tauri/.gitignore and the root .gitignore's src-tauri/ entries.
      "src-tauri/target/**",
      "src-tauri/gen/**",
      // Vendored local fork of tauri-plugin-sql (see
      // src-tauri/vendor/tauri-plugin-sql/GOBUDDY_PATCH.md) — third-party
      // crate source, including its shipped JS artifact/guest-js, not ours to
      // lint. Only its one-line Rust change is ours.
      "src-tauri/vendor/**",
      // Scratch working state for the subagent-driven-development skill
      // (task briefs, implementer reports, review packages) — not project
      // source, not meant to be linted.
      ".superpowers/**",
      // Playwright's own generated test-run artifacts (traces, screenshots,
      // error-context.md) — not project source, not meant to be linted.
      "test-results/**",
      ".obsidian/**",
      "scripts/ingest/.cache/**",
      "data-authoring/**",
      "*.sqlite",
      "package-lock.json",
      // Vendored reference-only submodule (see docs/ingestion-runbook.md) —
      // third-party source we don't own or build, not ours to lint.
      "vendor/**",
    ],
  },

  // JavaScript / TypeScript — scoped to these extensions so js/recommended
  // doesn't also run against the JSON/Markdown/CSS blocks below. Unscoped,
  // it ran on every file including .obsidian/app.json and crashed
  // no-irregular-whitespace, which doesn't support the JSON language's
  // SourceCode object (no getAllComments()).
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    plugins: {
      js,
    },
    extends: ["js/recommended"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },

  // TypeScript — non-type-checked rules only (no parserOptions.project),
  // deliberately: recommendedTypeChecked also tries to type-check embedded
  // code fences inside every Markdown doc (CLAUDE.md, docs/*.md) once
  // markdown/recommended is on, and those fences aren't part of the tsconfig
  // project, so it can't resolve them. Type-aware linting would need a
  // deliberate adoption pass (e.g. scoping it to src/**), not a drive-by here.
  ...tseslint.configs.recommended,

  {
    rules: {
      // Let TypeScript handle these
      "@typescript-eslint/no-unused-vars": "off",
      "prefer-const": "error",
    },
  },

  // JSON
  {
    files: ["**/*.json"],
    plugins: {
      json,
    },
    language: "json/json",
    extends: ["json/recommended"],
  },

  // JSONC
  {
    files: ["**/*.jsonc"],
    plugins: {
      json,
    },
    language: "json/jsonc",
    extends: ["json/recommended"],
  },

  // Markdown — gfm, not commonmark: this repo's docs use GitHub task-list
  // checkboxes (`- [ ]` / `- [x]`) throughout (docs/roadmap.md,
  // docs/pre_launch_checklist.md, CHANGELOG.md); the commonmark parser
  // doesn't know that syntax and reads each `[ ]`/`[x]` as a broken markdown
  // link reference.
  {
    files: ["**/*.md"],
    plugins: {
      markdown,
    },
    language: "markdown/gfm",
    extends: ["markdown/recommended"],
    rules: {
      // CHANGELOG.md's `## [0.11.0] — date` headers (Keep a Changelog
      // convention) use literal brackets around the version with no actual
      // link-reference definitions — not broken links, just the format.
      "markdown/no-missing-label-refs": "off",
    },
  },

  // CSS
  {
    files: ["**/*.css"],
    plugins: {
      css,
    },
    language: "css/css",
    extends: ["css/recommended"],
    rules: {
      // This app ships as a single bundled Capacitor/Android webview, not a
      // cross-browser site — "baseline" (cross-browser-support) checks don't
      // apply to a fixed, known runtime.
      "css/use-baseline": "off",
    },
  },
]);
