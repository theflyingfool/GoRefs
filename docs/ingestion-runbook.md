# Reference-data ingestion runbook

The operational order for regenerating `src/data/reference.json` for a real
game update (new season, new species, corrected data). For *what each script
does*, see [architecture.md](architecture.md)'s "Scripts" table — this doc is
*order*, not description. For the source formats these scripts read, see
[data-model.md](data-model.md)'s "Reference data ingestion" section.

## Order

```sh
npm run ingest   # fetch, build, slug-check, sprites, manifest -- runs everything in order, in one shot
```

`scripts/ingest/ingest.ts` is the only ingestion entry point — there is no
step-by-step equivalent of the old per-script npm commands any more. Its
internal steps, in order:

1. **fetch** — pulls fresh GAME_MASTER (`alexelgt/game_masters`),
   `pokemon-go-api.github.io`'s pokedex/types/mega files, and the
   pokemongo-shiny community sheet into `scripts/ingest/.cache-v2/`
   (`raidboss.json` is deliberately not fetched — raid-boss ingestion was
   dropped and nothing consumes it, so fetching/hashing it would only feed
   `ingest:check` false positives on raid-rotation churn). Always
   re-fetches (no live pogoapi.net dependency any more — the one thing it
   used to supply that GAME_MASTER doesn't, medal display names, comes from
   the committed `vendor/pogoapi-snapshot/badges.json` snapshot instead).
2. **build** — runs the `scripts/ingest/transform/*.ts` modules over that
   cache and writes `src/data/reference.json`, `src/data/reference-gaps.json`,
   `src/data/reference-version.ts`, and the sprite manifest
   (`scripts/ingest/write/*.ts`).
3. **slug-check** — inline port of the old `check-slug-stability.ts`: fails
   loudly if a species/form/mega-variant/medal slug the last *committed*
   `reference.json` had has vanished, unaccounted for.
4. **sprites** — `fetch-sprites.ts` downloads sprite art referenced by the
   cache (skip-if-cached), then `build-sprites.ts` converts it to WebP into
   `public/sprites/`. Skip with `npm run ingest -- --skip-sprites` (the extra
   `--` is required for npm to forward the flag instead of swallowing it).
5. **manifest** — writes `scripts/ingest/.cache-v2/ingestion-manifest.json`
   (per-source fetch fingerprints: GAME_MASTER's latest commit SHA, content
   hashes for the pokemon-go-api files and the shiny sheet). This one file is
   committed (see `.gitignore`), unlike the rest of `.cache-v2/`.

```sh
npm run ingest:check   # fetch + write manifest + diff against the last committed
                        # manifest only -- skips build/sprites/slug-check entirely,
                        # exits non-zero if any upstream source changed
```

Use `ingest:check` to answer "has anything upstream changed since the
reference data currently shipped was built" without paying for a full build.

There is no manual-CSV-correction workflow any more — `ingest:csv:export/
template/import` (`scripts/ingest/csv-authoring.ts`) was removed along with
the rest of the old per-script pipeline. `src/data/reference-csv-format.ts`
still exists, but only as the in-app Coverage Report's own export/read
format now — it has no ingestion-side writer.

## Known pitfalls

- **Slug stability**: the inline slug-check step diffs the freshly-built
  `reference.json` slugs against the last committed version and fails if a
  species, form, mega-variant, or **medal** slug vanished without a matching
  `src/db/slug-renames.ts` entry (species/form only — mega variants and
  medals have no rename mechanism, so any disappearance there fails the
  build every time). Medal slugs matter here because they depend on a
  subsequence-alignment join between GAME_MASTER and the vendored
  `badges.json` snapshot (`scripts/ingest/sources/pogoapi-badges.ts`) — if
  that alignment ever degrades, `medal_progress_personal.medal_slug` (a live
  FK with no other automated drift detection) would silently break sync for
  any user with medal progress.
- **Costume-form renames don't auto-generate**: `src/db/slug-renames.ts` is
  only ever auto-populated for non-costume forms (Standard/region/Gigantamax),
  matched by dex number + form name + gender against the previously-committed
  `reference.json` — costume vocabulary differs too much between ingestion
  sources to auto-match confidently. A costume-form slug that disappears
  without a hand-added rename entry quarantines (`personal_data_quarantine`,
  `src/db/schema.ts`) instead of carrying forward automatically; recover it
  by hand from the quarantined row's `payload_json` if needed.

## Checkpoint before committing

Open the in-app **Coverage Report** (or re-run `ingest:build` and check
`src/data/reference-gaps.json`) and confirm the gap count moved the
direction you expect — a correction pass that *increases* gaps somewhere you
didn't touch usually means an ordering mistake above, not new missing data.
`reference-gaps.json` also carries comparative gaps (`missing-species`,
`gigantamax-mismatch`, `family-root-mismatch`) diffed against the last
*committed* `reference.json` — these track known upstream data gaps (see
[v2-data-source-findings.md](v2-data-source-findings.md)), not fresh
regressions from your own change.

For release publishing steps and app deployment workflows, refer to the canonical [docs/release-checklist.md](release-checklist.md).

## `pokemon-go-api` submodule is reference-only

`vendor/reference/pokemon-go-api` is a git submodule vendoring
that project's own source (PHP/Composer, branch `main`). It is **not**
read by any `ingest:*` script, not part of the build, and not a dependency
of anything in this repo — it exists purely as continuity insurance:

- `pokemon-go-api` builds its data from `alexelgt/game_masters`' raw
  `GAME_MASTER.json` via a PHP pipeline (`composer run-script api-build`),
  rebuilt on a schedule (`cron: '7 6,8,9,10,18,20,21,22 * * *'` in its own
  `.github/workflows/page.yml`) and redeployed to GitHub Pages only on
  detected changes.
- If that hosted API ever goes stale or the project stops being
  maintained, this vendored copy is the fallback starting point: either
  run its PHP/Composer build ourselves as a one-off against a fresh pull of
  `alexelgt/game_masters`, or use its source as a spec while writing our
  own TypeScript parser directly against the raw GameMaster file.
- No SPDX license is present on the `pokemon-go-api` repo — only a README
  disclaimer ("educational use only," copyright remains Niantic/The
  Pokémon Company). Fine for a private vendored reference copy inside this
  repo; reconsider before ever redistributing or publicly forking its code.
- `alexelgt/game_masters` itself (the raw upstream data, not the parsing
  logic) is deliberately not vendored the same way — it's large, churns
  almost daily, and isn't the thing at continuity risk here.

Clone/update it with `git submodule update --init --recursive`. It is
never required for a normal `npm install` / build / `ingest:*` run.
