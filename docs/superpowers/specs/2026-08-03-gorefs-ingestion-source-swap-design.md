# GoRefs Ingestion Source Swap — Design

> Sequencing: this plan → screenshot/OCR-based dex-onboarding plan (next) →
> reference.sqlite bundling switch (flagged high-priority, its own plan
> after that). Not three concurrent efforts.

## Goal

Replace GoBuddy's current reference-data ingestion — direct fetches of
GAME_MASTER (`alexelgt/game_masters`), pokemon-go-api's pokedex/types/mega
files, and the pokemongo-shiny sheet, transformed in
`scripts/ingest/transform/*.ts` — with querying the vendored
[GoRefs](https://github.com/theflyingfool/GoRefs) project
(`vendor/reference/GoRefs` submodule) instead. GoRefs consolidates its own 7
upstream sources into a single queryable database and is meant to
eventually be a real, independently-hosted service; this swap is built
against that target shape from day one — local `--serve` today, a published
URL later — not a one-off export format.

`reference.json`'s shape (`src/db/reference-data.ts`'s `ReferenceData`
interface) and everything downstream of it (`reference-sync.ts`,
`reference.sqlite`, the app itself) are unchanged by this plan. Only how
`ReferenceData` gets assembled changes.

## Background: parity finding

GoRefs' own team ran a coverage analysis one day before this plan
(`.superpowers/sdd/2026-07-30-generic-ingestion-engine/reference-json-coverage-report.md`
in the GoRefs repo) comparing `reference.json` against GoRefs' **canonical**
tables (species, forms, moves, etc. — built from GoRefs' 7 independent
sources, not from `reference.json`). Verdict: not a 100% replacement as-is —
real gaps in `formMoves` (11,131 rows, no canonical equivalent at all),
`speciesEvolutions` (479 rows, same), a badge `badge_id` collision merging
382 badges into 184, missing Mewtwo X/Y in `mega_species`, and total gaps in
`pvpRankRewards`/`backgrounds`.

Separately, GoRefs has a `refjson_*` shim (`src/reference_shim.py`, built
2026-08-03) that wholesale-dumps GoBuddy's own `reference.json` into
`refjson_<table>`-prefixed tables, as a stopgap. Verified directly against
the live `output/GoRefs_Master.duckdb`: **every domain the coverage report
called a gap is fully present in the `refjson_*` shim**, with exact matching
row counts (`refjson_form_moves`: 11,131; `refjson_species_evolutions`: 479;
`refjson_medals`: 583, uncollided; `refjson_pvp_rank_rewards`: 240;
`refjson_backgrounds`: 2). So nothing is actually missing from the vendored
database today — it's split between GoRefs' independent canonical tables
(ahead of `reference.json` on `raidBosses`/`communityDays`/`friendshipLevels`)
and a frozen mirror of GoBuddy's own last `reference.json` snapshot for the
domains GoRefs hasn't modeled natively yet. 100% parity holds functionally,
with the honest caveat that the shim-covered domains aren't independent
GoRefs data yet.

**Full-database size check:** exporting every one of `GoRefs_Master.duckdb`'s
51 tables to JSON totals 22.5MB, against `reference.json`'s current 2.4MB —
but ~17.9MB of that is GoRefs-internal bookkeeping (`game_master_templates`
raw passthrough, `_claims_ledger` provenance, `change_history`/
`discrepancies`) and the `refjson_*` mirror (~2.2MB, a duplicate of
`reference.json` itself) that a real export would never carry. The domains
GoBuddy would actually query total roughly 2.1MB — in line with today's
size. This ~9x-if-taken-naively number was still enough of a signal to flag
the `reference.sqlite`-bundling switch as its own high-priority near-term
plan (see sequencing note above) — but it is **not** in scope for this plan.

## Architecture / data flow

`scripts/ingest/ingest.ts`'s `fetch` and `build` steps are replaced by one
new step:

1. **Verify (don't blindly (re)start) a GoRefs server is reachable.** Probe
   the expected port with a real query (not just "is the TCP port open") —
   if a `go_refs.py --serve` instance is already running (e.g. a developer
   has it up for the web explorer), use it as-is and never touch its
   lifecycle. If nothing answers, spawn `uv run go_refs.py --serve --port
   <port>` as a child process from `vendor/reference/GoRefs`, poll until it
   responds, and remember that *this run* owns it.
2. Connect via a Node DuckDB client's `httpfs` extension: `ATTACH
   'http://localhost:<port>/output/GoRefs_Master.duckdb' AS gorefs
   (READ_ONLY)`.
3. Run one SQL query per `ReferenceData` domain against `gorefs.<table>`,
   per the domain mapping below.
4. If this run spawned the server itself in step 1, terminate it. If it
   found one already running, leave it alone.
5. Everything downstream — slug-check, sprites, sqlite, manifest — runs
   unchanged, consuming the same `ReferenceData` value as today.

Refreshing GoRefs' own upstream data (`uv run go_refs.py --build` inside the
submodule) is **not** triggered automatically by `npm run ingest` — that
stays GoRefs' own deliberate, occasional act (analogous to bumping the
submodule pointer), documented as a manual pre-step, not orchestrated from
GoBuddy. `npm run ingest` only ever re-derives `reference.json` from
whatever GoRefs' database currently contains.

**Sprites stay carved out.** GoRefs doesn't model sprite assets at all.
`fetchSprites()`/`buildSprites()` still need pokemon-go-api's raw
`pokedex.json` for sprite-source URLs — that one raw fetch
(`sources/pokemon-go-api.ts`'s `PGAPI_FILES`) stays, narrowed to sprite-URL
extraction only. Species/forms/moves/etc. no longer come from parsing it.

## Domain mapping

| `ReferenceData` domain | GoRefs source | Why |
|---|---|---|
| `species` | canonical `species` | full parity confirmed (spot-checked) |
| `typeEffectiveness` | canonical `type_effectiveness` | exact count + value match |
| `weatherBoosts` | canonical `weather_boosts` (unnest `boosted_types`) | denormalized differently, not missing data |
| `raidBosses`, `raidBossWeatherBoosts` | canonical `raid_bosses` | GoRefs is ahead — GoBuddy's own copies are empty today by omission (dropped ingestion, not a product decision), not because the data shouldn't exist |
| `communityDays` (+ 3 sub-tables) | canonical `community_days` | same as above — GoRefs has real data, GoBuddy's is empty |
| `forms`, `formTypes` | `refjson_forms` / `refjson_form_types` | canonical `forms` collapses gender (89% `"unknown"`) — real regression vs. today; use the shim until GoRefs fixes it |
| `megaVariants` | `refjson_mega_variants` | canonical `mega_species` is missing Mewtwo X/Y (confirmed real gap) |
| `moves` | `refjson_moves` | canonical `moves` is missing ~9-11 real moves + has naming/duplicate issues |
| `playerLevels`, `playerLevelRewards` | `refjson_player_levels` / `refjson_player_level_rewards` | canonical `progression` lacks `cumulativeXp` entirely; no reward table at all |
| `medals`, `medalTiers` | `refjson_medals` / `refjson_medal_tiers` | canonical `badges` has the confirmed `badge_id` collision (382 → 184) |
| `friendshipLevels` | `refjson_friendship_levels` | canonical has a real newer tier but a modeling bug (NULL/duplicate milestone rows); shim is clean and matches today |
| `formMoves` | `refjson_form_moves` | total gap in canonical schema |
| `speciesEvolutions` | `refjson_species_evolutions` | total gap in canonical schema |
| `pvpRankRewards`, `pvpRankRequirements` | `refjson_pvp_rank_rewards` / `refjson_pvp_rank_requirements` | total/near-total gap in canonical schema |
| `regions`, `types` | unchanged — derived in TS from other domains, as today | trivial static mapping, not real sourced data either way |
| `backgrounds` | unchanged — hardcoded literal in `build()`, as today | 2 static rows, never had a real upstream source |

Every `refjson_*` row above is a documented, revisit-later decision: once
GoRefs' own team promotes a domain into its canonical schema (tracked in
GoRefs' own `TODO.md`/`KNOWN_ISSUES.md`), GoBuddy's query for that domain
switches from the shim table to the canonical one — a one-line change per
domain, no shape change, since `refjson_*` and canonical tables should
converge in row shape once fixed.

## Removed entirely

`sources/game-master.ts`, `sources/shiny-sheet.ts`, `sources/pogoapi-badges.ts`
(its vendored badge-name snapshot is already baked into whatever
`reference.json` GoRefs' shim last mirrored), and the GAME_MASTER-derived
logic in `transform/species.ts`, `transform/moves.ts`, `transform/evolutions.ts`,
`transform/player-progression.ts`, `transform/pvp.ts`. GoBuddy loses its
direct GAME_MASTER dependency entirely — that responsibility moves fully to
GoRefs.

## Manifest / freshness checking

Today's `ingest:check` diffs upstream fetch fingerprints (GAME_MASTER commit
SHA, file hashes) against a committed manifest. There's no longer a single
upstream URL to fingerprint. Short-term: replace those manifest entries with
a content hash of the assembled `ReferenceData` itself (the same mechanism
`reference-version.ts` already computes) — exact wiring left to the
implementation plan. Flagged separately in GoRefs' own `TODO.md`: GoRefs
should expose a last-built/updated timestamp so a freshness check doesn't
need to pull or query the whole database just to know "has this changed."

## Error handling

- GoRefs server unreachable (neither already running nor able to be
  spawned/reached within a timeout) fails the whole `npm run ingest` run
  loudly — same philosophy as today's fetch failures.
- The probe in architecture step 1 must confirm the responder is actually
  GoRefs (a real query succeeds), not merely that some process holds the
  port.

## Testing

- Downstream step tests (`writeReferenceJson`, sqlite, manifest, slug-check)
  are unaffected.
- New: the GoRefs-query layer should be testable against a fixture
  `.duckdb` file via a direct file-path `ATTACH` (no HTTP server needed) for
  fast unit tests, reserving the real `--serve` + HTTP path for actual
  `npm run ingest` runs and a slower integration-style check.

## Closing phase (after implementation + a passing test run)

- Remove now-dead ingestion scripts (the "Removed entirely" list above).
- Update `docs/architecture.md`'s Scripts table, `docs/ingestion-runbook.md`,
  `docs/data-model.md` if it describes source provenance, and
  `docs/roadmap.md`'s Phase 0 entry to describe the GoRefs-sourced pipeline
  instead of the retired direct fetchers.

## Out of scope (logged elsewhere, not this branch)

- **`reference.sqlite` bundling switch** (shipping a prebuilt sqlite file
  with releases instead of `reference.json` + `reference-sync.ts`'s runtime
  load) — flagged high-priority given the size trajectory, but its own plan,
  sequenced *after* the screenshot-onboarding plan below.
- **Screenshot/OCR-based dex onboarding** (parsing screenshots to bulk-populate
  a user's collection instead of manual entry — motivated by accounts with
  thousands of already-caught Pokémon) — the *next* plan after this one,
  before the sqlite-bundling switch.
- **Settings-page "check for database updates"** — TODO only. Cuts against
  the app's local-first principle; owner is not committed to it.
