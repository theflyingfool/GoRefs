### Task 2: `sources/pokemon-go-api.ts`, `sources/shiny-sheet.ts`, and `http-cache.ts` always-fresh + hash-on-write

Two new thin parse-only source modules, plus a behavior change to the
shared fetch helper:

- `scripts/ingest/sources/pokemon-go-api.ts` — typed accessors over the
  cached `pgapi/pokedex.json`/`raidboss.json`/`types.json`/`mega.json`
  (same 4 files `fetch-reference-data.ts` fetches today from
  `https://pokemon-go-api.github.io/pokemon-go-api/api/...` — read that
  file for the exact URLs/paths). This replaces direct
  `loadJson<T>("pgapi/pokedex.json")`-style calls in the current
  `build-reference.ts` with named, typed functions.
- `scripts/ingest/sources/shiny-sheet.ts` — typed accessor over the fetched
  pokemongo-shiny sheet JSON. **Pre-implementation step, do this first**:
  determine the real tab name for
  `https://opensheet.elk.sh/1l1CXHdge8_2F2ifjMY71f23DJ_98Ei2QNZ9rPdBd8jQ/`
  — tab index `4` is confirmed working
  (`.../1l1CXHdge8_2F2ifjMY71f23DJ_98Ei2QNZ9rPdBd8jQ/4`) but fragile against
  reordering; try fetching the sheet's tab list (e.g. via
  `https://docs.google.com/spreadsheets/d/1l1CXHdge8_2F2ifjMY71f23DJ_98Ei2QNZ9rPdBd8jQ/gviz/tq?tqx=out:json&gid=0`
  variants, or ask in your report if you can't resolve it) to find the real
  name; fall back to the index-4 URL with a prominent code comment
  explaining the fragility if no name can be found. Record shape:
  `{ family_dex, debut, pid, group, tag?, order?, suffix? }` — expose a
  getter keyed by `pid` (matches `pokemon-go-api/assets`' `pm{id}.f{FORM}`/
  `.c{COSTUME}` filename convention) returning at least `debut`.
- `scripts/ingest/http-cache.ts` — change `fetchToCache` (or add a
  sibling/flag) so the main ingestion pipeline always re-fetches fresh
  rather than skipping when a cached file already exists on disk (current
  behavior, `http-cache.ts:27-28`) — this is required for the
  `ingestion-manifest.json` change-detection to work at all (a skip-if-
  exists cache means repeated runs re-hash stale bytes and can never see a
  real upstream change). Also add hash-on-write: after a successful fetch,
  compute and store a content hash for what was just written (reuse
  `hashContent` from `src/db/content-hash.ts`), so a later manifest-writing
  step is a pure read, not a re-hash pass. Decide whether sprite downloads
  (large binaries, separately gated by `--skip-sprites`) should keep the
  old skip-if-exists behavior — they plausibly should, since re-fetching
  ~7000 sprite files every run is wasteful in a way the small JSON sources
  aren't; make this a parameter/flag on the fetch function, not two
  separate implementations.

Write/update tests for `http-cache.ts`'s new behavior (force-fresh path,
hash-on-write path) and basic parse-correctness tests for both new source
modules against small fixture JSON (don't require live network access in
tests).

