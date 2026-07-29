# Codebase map

This is a map, not a rationale doc — for **why** things are shaped this way,
see [data-model.md](data-model.md) (storage/schema design),
[features.md](features.md) (feature spec and roadmap), and [release-checklist.md](release-checklist.md) (release operations). Keep entries to one line;
if an entry needs a paragraph, that content belongs in one of those docs
instead, linked from here.*

## App shell (`src/app-shell/`)

| File | Purpose |
|---|---|
| `main.ts` (repo root of `src/`) | Wires the repository, router, and page renderers together; the app's entry point. |
| `header.ts` | Top bar: species-filter input, jump-to-species search, or nothing, depending on the current route. |
| `nav-drawer.ts` | Slide-out navigation between routes. |
| `router.ts` | The `Route` union type + path parsing/building (`speciesDetailPath`, etc.) — no framework, just a discriminated union and a switch. |

## Features (`src/features/`)

| Module | Purpose |
|---|---|
| `data-entry/species-grid.ts` | The main dex grid: tiles, filter chips, region/search filtering. |
| `data-entry/species-detail.ts` | Per-species page: toggles every achievement field across all of a species' forms. |
| `data-entry/bulk-form-edit.ts` | "Sweep one field across many forms" page — mark all banked 4★s/shinies at once without opening each species. |
| `data-entry/field-groups.ts` | `SPECIES_FIELDS`/`FORM_FIELD_GROUPS` — the single source of truth for which achievement fields exist and how they're grouped in the UI; drives detail-page rendering, cascades, and stats. |
| `data-entry/indicator-labels.ts` | Badge glyphs + full-text labels for every achievement field, used by grid chips and detail toggles. |
| `coverage-report/coverage-report-page.ts` | Dev-facing view of which species are missing reference-data fields (types, region, availability flags); also drives the CSV export/import authoring round-trip. |
| `settings/settings-page.ts` | App-wide settings: grid indicator picks, gender-collapse toggle, export/import entry points. |
| `settings/personal-data-transfer.ts` | Manual (non-syncing) cross-device personal-data export/import — writes/reads a file the user moves themselves. |
| `stats/stats-page.ts` | The completion-stats feature: scope × lens picker, drill-down to missing species. |
| `stats/lens-labels.ts` | Labels + stable string keys for each `CompletionLens`, used for persisting the user's checkbox selections. |
| `stubs.ts` | Placeholder pages for not-yet-built nav destinations (Search Tools, Achievements, XP Assistant). |

## DB layer (`src/db/`)

| File | Purpose |
|---|---|
| `schema.ts` | Raw SQL DDL for reference tables (`REFERENCE_SCHEMA_SQL`) — personal DDL moved to `schema/personal.ts`'s Drizzle definitions. Also still holds `CURRENT_PERSONAL_SCHEMA_VERSION`/`DEFAULT_PROFILE_ID`/`DEFAULT_PROFILE_USERNAME` (unrelated to Drizzle — used for export/import version stamping, Settings display, and the boot-rescue path). |
| `schema/personal.ts` | Drizzle schema for personal tables — the sole input to `npm run db:generate` (the migration SQL files under `migrations/` are generated from it) and the table defs `completion-stats-sql.ts`'s query rewrite runs against. **Not** unified with `types.ts` below — that stays the separate, hand-written source of truth for the rest of the app (deliberate, not yet reconciled). |
| `schema/reference.ts` | Drizzle schema for reference tables, for typed queries only — deliberately excluded from drizzle-kit's schema path since these tables are wholesale-replaced by `reference-sync.ts`, never migrated. |
| `drizzle-client.ts` | Wraps a given `SQLiteDBConnection` in Drizzle's `sqlite-proxy` driver — `getDrizzleDb(conn)` (synchronous, takes the connection as a parameter, no caching) is what `migrations.ts` and the query layer both call. |
| `types.ts` | Hand-written camelCase TypeScript interfaces for both reference and personal tables — still the type source consumed across the data and UI layers (not an exhaustive list: `in-memory-store.ts`, `sqlite-repository.ts`, `field-groups.ts`, and many Vue pages, among others); drives SQL, UI field groups, cascades, and the export format from one place. Independent of `schema/personal.ts`/`schema/reference.ts` above, not generated from them. |
| `migrations.ts` | Runs `drizzle-orm/sqlite-proxy/migrator`'s `migrate()` against two generated migrations under `src/db/migrations/` (`0000` = the schema v1.0.0 devices actually shipped with; `0001` = a real SQLite table-rebuild converting timestamp columns from TEXT to INTEGER), with a one-time bootstrap for devices that shipped before this system existed — see docs/data-model.md's migration-runner section. |
| `reference-data.ts` | The `ReferenceData` shape of the bundled `src/data/reference.json` asset. |
| `reference-sync.ts` | On every startup, wipes and reloads reference tables from `reference.json` if its content hash changed; applies slug renames first. |
| `slug-renames.ts` | Hand-maintained registry mapping old→new slugs, so a display-name correction in the ingestion pipeline doesn't orphan personal data already keyed to the old slug. |
| `cascades.ts` | Forward-only cascade rules (e.g. checking Shundo auto-checks Shiny/4★/Caught), built programmatically from `field-groups.ts`. |
| `defaults.ts` | Default `app_settings` values seeded on a fresh install. |
| `sqlite-client.ts` | Bootstraps the on-device SQLite connection via `@tauri-apps/plugin-sql` — same connection object on desktop and Android, no platform dispatch. |

## Data/repository layer (`src/data/`)

| File | Purpose |
|---|---|
| `repository.ts` | The `Repository` interface the UI codes against — both backends below implement this same shape. |
| `sqlite-repository.ts` | The real backend: reads served from an in-memory cache loaded once at startup, writes go through to real SQLite via a write queue. |
| `in-memory-store.ts` | Query/filter engine behind `sqlite-repository.ts`; personal-data mutations call a hook that writes through to real SQLite. |
| `personal-demo-seed.ts` | Hand-written demo toggles seeding `scripts/build-dummy-db.ts`'s generated `dummy.sqlite` fixture — never used by the real on-device backend. |
| `completion-stats-sql.ts` | Real parameterized SQL for the completion-stats feature, one query shape per lens kind. |
| `reference-csv-format.ts` | The flat CSV column shape the in-app Coverage Report reads/writes. The ingestion pipeline's own CSV authoring round-trip (`ingest/csv-authoring.ts`) was removed — this file is now solely a Coverage Report dependency. |
| `reference.json` / `reference-gaps.json` | Generated build artifacts — see "Scripts" below, not hand-authored. |

## UI helpers (`src/ui/`) and shared (`src/shared/`)

| File | Purpose |
|---|---|
| `ui/dom.ts` | Minimal DOM-builder helpers (`el`, `clear`) — no framework, by project decision. |
| `ui/sprites.ts` | Sprite path convention (`public/sprites/<dex-number>.webp`); also `formSpritePath()`/`megaSpritePath()` for per-form/costume/Mega art, falling back to the species sprite — see [features.md#4-sprite-asset-pipeline](features.md#4-sprite-asset-pipeline). |
| `shared/file-download.ts` | "Save this file for the user" helper via `@tauri-apps/plugin-dialog`'s save dialog + `@tauri-apps/plugin-fs`'s `writeTextFile` — one mechanism on desktop and Android, used by Settings export and Coverage Report's CSV export. |

## Scripts (`scripts/`)

| File | Purpose |
|---|---|
| `bump-version.ts` (`npm run version:bump`) | Bumps `package.json` semver + `android/app/build.gradle` `versionName`/`versionCode` together, per docs/release-checklist.md's release workflow. |
| `build-dummy-db.ts` (`npm run build:dummy-db`) | Generates a real `dummy.sqlite` file at the repo root for inspecting the schema with an external SQLite tool. |
| `ingest/ingest.ts` (`npm run ingest`, `npm run ingest:check`) | The orchestrator — the only ingestion entry point. Runs fetch → build → slug-check → sprites → manifest as a `PipelineStep[]` list (`npm run ingest -- --skip-sprites`/`--skip-sqlite` skip individual steps — note the `--` npm needs to forward flags; `npm run ingest:check` fetches + writes the manifest and diffs it against the last *committed* manifest only, skipping build/sprites/slug-check, exiting non-zero if any upstream source changed). Consumes only GAME_MASTER (`alexelgt/game_masters`), `pokemon-go-api.github.io`'s pokedex/types/mega/raidboss files, and the pokemongo-shiny community sheet — no live pogoapi.net fetch. |
| `ingest/sources/game-master.ts`, `sources/pokemon-go-api.ts`, `sources/shiny-sheet.ts`, `sources/pogoapi-badges.ts` | Typed, parse-only accessors over each raw source (already-`JSON.parse()`d content in, indexed lookups out) — no file I/O beyond `pogoapi-badges.ts`'s read of the committed `vendor/pogoapi-snapshot/badges.json` (medal display names GAME_MASTER doesn't publish). `ingest.ts` owns fetching the bytes these wrap. |
| `ingest/transform/species.ts`, `transform/moves.ts`, `transform/evolutions.ts`, `transform/player-progression.ts`, `transform/pvp.ts` | Pure functions: typed source data in, typed reference-table rows out. `transform/species.ts` also owns the comparative-gap constants (`buildComparativeGaps`, `FAMILY_ROOT_GAP_NOTES`, `KNOWN_MISSING_SPECIES_DEX`, `KNOWN_GIGANTAMAX_MISMATCH_DEX`) and slug helpers (`slugFor`, `formTokenFromFormId`). Slugs are built from `pokemon-go-api`'s enum ids (`id`/`formId`), not display names — see [v2-schema-design.md](v2-schema-design.md)'s slug-generation section. Raid bosses and Community Days are dropped entirely — no transform builds them; those `ReferenceData` fields stay empty arrays. |
| `ingest/write/reference-json.ts` | Serializes a built `ReferenceData` to `src/data/reference.json` + `src/data/reference-gaps.json` (stateless gaps from `gap-detection.ts` + comparative gaps from `transform/species.ts`) + bakes a content hash into `src/data/reference-version.ts`. |
| `ingest/write/sprite-manifest.ts` | Writes the slug → sprite-source-URL manifest (`scripts/ingest/.cache-v2/sprite-manifest.json`) that `build-sprites.ts` reads. |
| `ingest/write/manifest.ts` | Writes `scripts/ingest/.cache-v2/ingestion-manifest.json` — per-source fetch fingerprints (GAME_MASTER's latest commit SHA touching `GAME_MASTER.json`; content hashes for the pokemon-go-api files and the shiny sheet) plus a fetch timestamp. This one file is deliberately committed (see `.gitignore`'s negation) so `ingest:check` has something to diff a fresh fetch against. |
| `ingest/fetch-sprites.ts`, `build-sprites.ts` | Exported functions `ingest.ts`'s sprites step calls (not standalone scripts). `fetchSprites()` downloads every sprite URL referenced by the cached `pokedex.json`, skip-if-cached. `buildSprites()` converts cached PNGs to WebP into `public/sprites/`, using the sprite manifest above — the only thing that should ever write there. |
| `ingest/http-cache.ts` | Generic fetch-and-cache helper (`fetchToCache`, always-fresh by default; `{ skipIfExists: true }` for sprites) with hash-on-write sidecars (`readCachedHash`) that `write/manifest.ts` reads. |
| `ingest/gap-detection.ts` | Stateless checks over a `ReferenceData` value for missing key fields — no external fetch. |
| `ingest/slug.ts` | Shared slug generator (`slugify(name/form/costume/gender)`) — used to assemble the final form/mega slug string from already-typo-proof tokens. |

For details on scripts and command execution, see
- **[docs/commands.md](docs/commands.md)** — developer command reference for dev/build/test.
- **[docs/ingestion-runbook.md](docs/ingestion-runbook.md)** — the correct
  order to run the reference-data ingestion scripts in, and known pitfalls.
- **[docs/install-guide.md](docs/install-guide.md)** — install/update
  instructions for friends running the app, both Android (sideload) and
  desktop.
- **[docs/release-checklist.md](docs/release-checklist.md)** — step-by-step checklist
  for releasing a new version of the app.
- **[README.md](../README.md)** — running/building the app, ingestion commands.
- **[CHANGELOG.md](../CHANGELOG.md)** — shipped-version history.

## Tests (`test/`)

Unit tests via Node's built-in test runner (`npm run test`, `node:test` +
`node:assert/strict` run through `tsx --test` — no test-framework dependency).
`node-sqlite-connection.ts` is a thin adapter exposing just the
`SQLiteDBConnection` surface `src/db/migrations.ts`/`src/db/reference-sync.ts`
call, backed by `node:sqlite` instead of the real Tauri plugin, so those
two modules run unmodified against disposable in-memory fixture databases.
`migrations.test.ts` and `reference-sync.test.ts` use it;
`export-import-round-trip.test.ts` tests `in-memory-store.ts`'s
export/import directly (no SQLite involved). `.github/workflows/ci.yml` runs
lint + typecheck + this suite on every PR and push to `master`.

## Data-authoring inputs (pre-build sources, not generated)

- Root-level `Blank Pokedex Project (Living Column) - Forms w_ Dynamax.csv` — the species/form skeleton.
- `data-authoring/event-pokemon.csv`, `data-authoring/gigantamax-species.json` — tracked authoring inputs.
- `data-authoring/reference-export.csv` — gitignored. The `ingest:csv:export` writer that regenerated it was removed with the rest of the old ingestion CSV round-trip; this path is now only ever produced by the in-app Coverage Report.

## Key patterns

These show up across many files above; understanding them once here saves
re-deriving them per file.

- **Write-queue (`sqlite-repository.ts`)**: every personal-data edit updates
  the in-memory cache immediately (so the UI shows it "saved" instantly) and
  writes to the real on-device SQLite database asynchronously through a
  queue. The UI never waits on a disk write; a failed write surfaces as a
  persistent in-app banner with retry (`src/app-shell/write-failure-banner.ts`),
  not just `console.error` — see [features.md#5-data-safety-net](features.md#5-data-safety-net).
- **Cascade (`db/cascades.ts`)**: checking a combined achievement
  (e.g. Shundo) auto-checks its logical prerequisites (Shiny, 4★, Caught)
  forward-only — un-checking never cascades, since that would silently erase
  independently-verified facts. Built programmatically from
  `field-groups.ts`'s field list, not hand-maintained separately.
- **Single-backend split (`data/`)**: `sqlite-repository.ts` implements
  `Repository`, backed by the shared query/filter engine in
  `in-memory-store.ts` (reads/mutations) plus real parameterized SQL in
  `completion-stats-sql.ts` (completion stats).
- **Single-source-of-truth field lists (`db/types.ts` +
  `features/data-entry/field-groups.ts`)**: the ~25 personal achievement
  fields are enumerated once and drive the SQL schema, the detail-page UI
  groups, the cascade rules, and the export/import shape — adding a new
  field touches few places by design.
