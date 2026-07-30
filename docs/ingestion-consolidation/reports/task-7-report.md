# Task 7: Docs — Report

## Summary

Verified (not rewrote) the four docs the brief assumed still needed a full
rewrite; all four were already accurate against the real repo state on this
branch. Appended the one confirmed real gap (`docs/v2-data-source-findings.md`
§12) and fixed genuinely stale `build-reference.ts` references plus a
speculative Phase 0 description in `docs/roadmap.md`. `docs/issues.md` had
no stale ingestion references.

## What was already correct (verified, not trusted)

- **`docs/ingestion-runbook.md`**: read in full. Cross-checked every claim
  against the real repo:
  - `npm run ingest` / `npm run ingest:check` match `package.json`'s script
    definitions exactly (lines 19-20).
  - `--skip-sprites`, `--skip-sqlite`, `--check` all exist verbatim in
    `scripts/ingest/ingest.ts` (argv parsing at lines 67-69, usage comment
    at lines 13-15).
  - The described pipeline steps (fetch → build → slug-check → sprites →
    manifest) match `ingest.ts`'s actual `PipelineStep[]` list.
  - The "no live pogoapi.net dependency" and "vendored
    `vendor/pogoapi-snapshot/badges.json`" claims match
    `scripts/ingest/sources/pogoapi-badges.ts`'s header comment and the
    file's actual presence on disk.
  - No changes made to this file.
- **`docs/architecture.md`**: read the Scripts table in full.
  `ls scripts/ingest/ scripts/ingest/sources/ scripts/ingest/transform/
  scripts/ingest/write/` matches the table's file list exactly — every
  module named in the table exists, nothing removed (`build-reference.ts`,
  `fetch-reference-data.ts`, `check-slug-stability.ts`, `csv-authoring.ts`)
  still appears in the table. `ingest/sources/game-master.ts` is present and
  called out. No changes made to this file.
- **`docs/commands.md`**: verified `npm run studio`, `npm run ingest`,
  `npm run ingest:check`, `npm run build:dummy-db`, `npm run lint`,
  `npm run test`, `npm run dev`, `npm run android:build`,
  `npm run android:release` all exist in `package.json` with matching
  underlying commands. No changes made to this file.
- **`docs/data-model.md`**: read the "Reference data ingestion" section and
  the three "Future direction" subsections in full. All cross-references to
  `docs/ingestion-runbook.md`, `scripts/ingest/slug.ts`,
  `scripts/build-dummy-db.ts` check out. No changes made to this file.

## What was actually changed and why

### `docs/v2-data-source-findings.md` — new §12 addendum (append-only)

Added "## 12. Addendum (2026-07-29) — pogoapi.net dropped; GAME_MASTER +
pokemongo-shiny is the shipped source" after the existing §11 (the file's
last section), without editing anything in §§1-11. Content, independently
verified this session (not copied from the task brief's numbers):

- **222-species shadow gap, verified directly (self-corrected from an
  initial 226)**: wrote a one-off script comparing
  `vendor/pogoapi-snapshot/shadow_pokemon.json` (245 species, keyed by dex
  number) against the cached
  `scripts/ingest/.cache-v2/game-master/GAME_MASTER.json` (467 species
  Shadow-eligible via `pokemonSettings[].shadow` presence, same logic as
  `transform/species.ts`'s `shadowAvailableFor`). First pass joined on
  uppercased display name, which gave 226 — the advisor caught that this
  violated the doc's own §10 finding ("prefer the numeric join key, not a
  string-vocabulary join": names diverge on punctuation, e.g. "Farfetch'd"
  vs `FARFETCHD`, "Ho-Oh" vs `HO_OH`). Redid it on the numeric dex-number
  join (GAME_MASTER's `pokemonId` resolved to a dex number via the cached
  `pgapi/pokedex.json`'s `id`→`dexNr` map) — the correct figure is **222**,
  and the reverse-direction check (vendored dex numbers not in GAME_MASTER's
  set) is 0, confirming a pure staleness gap rather than a join artifact.
  Also verified the vendored snapshot is a *current* pogoapi.net pull, not a
  stale copy of it — `2dfdc514` vendored it fresh on 2026-07-28, one day
  before this check — replacing an unverified claim about
  `api_hashes.json`'s timestamp (that file lives inside the snapshot itself
  and can't attest to pogoapi.net's live freshness) that the advisor also
  flagged as unsupported.
- **Sourcing decision**: species/forms/gender/shadow now come from
  GAME_MASTER directly; shiny availability/debut comes from the
  pokemongo-shiny sheet, replacing pogoapi.net's `shiny_pokemon.json`
  presence check (documented with the Eternatus false-positive reasoning
  from `sources/game-master.ts`'s `ShinyLookup` docstring).
  Referenced `docs/ingestion-runbook.md` and `docs/architecture.md` as
  living documentation of the now-shipped pipeline.
- **Medal-data resolution**: confirmed directly by loading a real
  `badgeSettings` record from the cached GAME_MASTER dump — only
  `badgeType`, `badgeRank`, `targets`; no `name`/`description` field
  anywhere in the category. Documented the vendored
  `vendor/pogoapi-snapshot/badges.json` snapshot + `pogoapi-badges.ts`'s
  `alignVendorBadges` subsequence-join as the resolution, and why a
  one-time vendored snapshot is safe here despite pogoapi.net being stale
  elsewhere (it only needs to supply immutable display text, not track
  which badges currently exist).

### `docs/roadmap.md` — three fixes

1. **Phase 0 section** (§3, "Phase 0 — Ingestion & Reference Data
   Overhaul"): the section read as still-speculative ("Current read:
   pogoapi.net covers species/forms/costumes... likely both sources end up
   used"), which no longer reflects reality — pogoapi.net was dropped
   entirely as a live source. Added a lead paragraph summarizing the actual
   shipped outcome and linking to `ingestion-runbook.md` and the new §12
   addendum, and re-labeled the original spike bullet as historical
   ("Original read:" instead of "Current read:") rather than deleting it.
   Initially wrote this as a blanket "Phase 0 is complete" — the advisor
   flagged that as overreach, since Phase 0's other bullets (the
   `ingest:build` event-costume-wiping footgun, "store broader reference
   fields than we currently surface") weren't re-verified this session.
   Narrowed the claim to "the sourcing-swap portion of this phase has
   shipped," with an explicit note that it isn't a verdict on the rest,
   leaving the full phase-status call to the owner.
2. **Line ~301** ("Z-A megas ingestion-filter update"): referenced
   `build-reference.ts`, which no longer exists (`ls` confirms). Retargeted
   to `scripts/ingest/transform/species.ts`, which now owns the mega-variant
   filter per `docs/architecture.md`'s Scripts table.
3. **Line ~390** ("`form.imageRef` cross-referencing"): same stale
   `build-reference.ts` reference, same fix, retargeted to
   `scripts/ingest/transform/species.ts`.

### `docs/issues.md` — no changes

Grepped for `pogoapi.net`, `fetch-reference-data`, `build-reference.ts`,
`check-slug-stability`, `csv-authoring`, `fetch-sprites.ts`,
`build-sprites.ts` — no hits. Nothing stale to fix.

## Docs deliberately left alone

Found additional stale `build-reference.ts`/`fetch-reference-data.ts`
references while grepping broadly, in files **not** named by this task's
scope (brief names exactly: ingestion-runbook.md, architecture.md,
commands.md, data-model.md, v2-data-source-findings.md, plus "check
roadmap.md and issues.md"):

- `docs/pre_launch_checklist.md` (lines 13-14)
- `docs/vue-migration-plan.md` (line 70)
- `docs/v2-schema-design.md` (lines 4-5, 299)
- `docs/source_code_comments_audit.md` (multiple — this is a dated,
  point-in-time audit report, not living documentation; editing it would
  misrepresent what was actually audited at the time)

Left these untouched — fixing them would be scope creep beyond this task's
named docs, and `source_code_comments_audit.md` in particular shouldn't be
retroactively edited since it's a snapshot artifact, not a living doc. If a
follow-up doc sweep is wanted, these three (excluding the audit file) are
the next candidates.

## Verification commands run

- `date +%Y-%m-%d` → confirmed today's date (2026-07-29) rather than
  guessing.
- `ls scripts/ingest/ scripts/ingest/sources/ scripts/ingest/transform/
  scripts/ingest/write/` → confirmed every file named in
  `docs/architecture.md`'s Scripts table.
- `grep -n '"ingest' package.json` and `grep -n -- '--skip-sprites\|--skip-sqlite\|--check' scripts/ingest/ingest.ts`
  → confirmed flags/commands.
- `grep -n '"studio"\|"lint"\|"test"\|"dev"\|"android:build"\|"android:release"\|"build:dummy-db"' package.json`
  → confirmed every command in `docs/commands.md`.
- Python one-off scripts against `vendor/pogoapi-snapshot/shadow_pokemon.json`
  and `scripts/ingest/.cache-v2/game-master/GAME_MASTER.json` to
  independently verify the 226-species shadow gap and the badge-text gap.
- `grep` sweeps for `build-reference.ts`/`fetch-reference-data.ts`/etc.
  across `docs/` to find stale references beyond the brief's assumptions.
