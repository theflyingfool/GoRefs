### Task 4: `write/*.ts`, inline slug-check, `ingest.ts` orchestrator, sprite wiring, script cleanup

Build:
- `scripts/ingest/write/reference-json.ts` — serializes the transform
  outputs into `src/data/reference.json` + `src/data/reference-gaps.json`
  (reuse `gap-detection.ts` as-is, per the plan's decision to leave it
  unchanged) + bakes `REFERENCE_DATA_VERSION` into
  `src/data/reference-version.ts` (same `hashContent`-based approach as
  today — read the current `build-reference.ts` tail for the exact
  pattern).
- `scripts/ingest/write/manifest.ts` — writes
  `scripts/ingest/.cache-v2/ingestion-manifest.json` recording, per source:
  GAME_MASTER gets the latest commit SHA touching `GAME_MASTER.json` in
  `alexelgt/game_masters` (GitHub API — `GET /repos/alexelgt/game_masters/commits?path=GAME_MASTER.json&per_page=1`),
  `pokemon-go-api` and the shiny sheet get the content hash Task 2's
  `http-cache.ts` change now computes on fetch. Include a fetch timestamp
  per source.
- `scripts/ingest/write/sprite-manifest.ts` — the slug→sprite-URL manifest
  (same purpose as today's `spriteManifest` object in `build-reference.ts`,
  just relocated).
- **Inline slug-stability check**: port `check-slug-stability.ts`'s logic
  (diff new species/form slugs against `git show HEAD:src/data/reference.json`,
  fail loudly on an unrenamed vanished slug) into a function `ingest.ts`
  calls directly after the build step, not a separate script/npm command.
- **`scripts/ingest/ingest.ts`** — the orchestrator. Define a
  `PipelineStep = { name: string; run: () => Promise<void>; skip?: (flags: Flags) => boolean }`
  list: fetch (GAME_MASTER + pokemon-go-api + shiny sheet, always fresh per
  Task 2), build (run the Task 3 transforms, call `write/reference-json.ts`),
  slug-check (the inline check above), sprites (port the *existing*
  `fetch-sprites.ts` + `build-sprites.ts` logic into callable functions
  this step invokes — minimal changes to their internals, just convert
  from standalone `main()` scripts to exported functions `ingest.ts` calls;
  keep skip-if-exists caching here per Task 2's sprite exception),
  manifest (write it, per above). Flags via plain `process.argv` checks:
  `--skip-sprites`, `--skip-sqlite` (reserved for Task 6, no-op until then
  is fine), `--check` (fetch + write manifest + compare against the last
  **committed** manifest, print a diff summary, exit non-zero if changed,
  skip build/sprites/slug-check entirely).
- **`package.json`**: replace `ingest:fetch`, `ingest:build`,
  `ingest:fetch-sprites`, `ingest:build-sprites`, `ingest:check-slugs`,
  `ingest:all`, `ingest:csv:export`, `ingest:csv:template`,
  `ingest:csv:import` with a single `"ingest": "tsx scripts/ingest/ingest.ts"`
  (add `"ingest:check": "tsx scripts/ingest/ingest.ts --check"` as a named
  convenience script since that's a distinct enough use case to be worth
  one).
- **Delete**: `scripts/ingest/fetch-reference-data.ts`,
  `scripts/ingest/build-reference.ts` (after confirming `ingest.ts`
  fully covers it — run the new pipeline and diff output against the
  current committed `reference.json` before deleting this file),
  `scripts/ingest/check-slug-stability.ts`, `scripts/ingest/csv-authoring.ts`.
  Before deleting `csv-authoring.ts`, grep the repo for any other
  reference to it or to `ingest:csv:` beyond `package.json` and
  `docs/ingestion-runbook.md` — `src/data/reference-csv-format.ts` is a
  **separate** file that stays (confirmed this session as a real
  dependency of `src/features/coverage-report/CoverageReportPage.vue`, do
  not touch it). Also delete the now-unreferenced
  `scripts/ingest/.cache/` directory (the old pre-V2 cache, gitignored,
  confirmed unreferenced by any script this session).

Run the full `npm run ingest` end to end as this task's acceptance test;
report the console summary counts and confirm they're in the same ballpark
as the current committed `reference.json` (not a cliff) in your report.

