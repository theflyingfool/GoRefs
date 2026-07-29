# Retired ingestion source archive

Old (V1) ingestion scripts and raw source data, recovered from git history for reference
while planning the ultimate-reference-DB project (see `../ref-db-sources-and-prompt.md`).
None of this runs against the current codebase — it's provenance, not live code.

Old CSVs referenced by these scripts (the three "Blank Pokedex Project" spreadsheets)
were **not** recovered here per instruction — CSVs aren't being recreated, only
`.ts`/`.json`/raw-text sources are. (`data-authoring/event-pokemon.csv` isn't retired —
it's still tracked on `master` today, so there's nothing to recover.)

**No retired generated JSON was found to recover.** Checked the full history of
committed `.json` files (`git log --all --diff-filter=A --name-only`) for a V1 dataset
that a parser here emitted and was later deleted. Every candidate (`src/data/reference.json`,
`form-sprite-slugs.json`, `mega-sprite-slugs.json`, `reference-gaps.json`,
`data-authoring/gigantamax-species.json`) is still live on `master` — the CSV content
these scripts once parsed was folded into `reference.json` through ongoing edits, not
preserved as a separate frozen artifact. `costume-lookup.json` (archived below) is
hand-authored, not derived from a CSV, so it's included on its own merits.

## Contents

- `scripts/ingest/pokeapi-client.ts`, `fetch-pokeapi-data.ts` — original PokeAPI (pokeapi.co)
  client and fetch script, retired at the V2 cutover (commit `87406a92`).
- `scripts/ingest/parse-forms-csv.ts` — parsed the "Blank Pokedex Project ... Forms w/
  Dynamax.csv" spreadsheet (CSV itself not recovered).
- `scripts/ingest/parse-types-csv.ts` — parsed a types CSV input (CSV itself not recovered).
- `scripts/ingest/parse-gigantamax.ts` — parsed the hand-maintained Gigantamax species list.
- `scripts/ingest/parse-event-pokemon.ts` + `scripts/ingest/sources/event-pokemon-go.wikitext` —
  parser and raw wikitext pulled from Bulbapedia's "Event Pokémon (GO)" article; the only V1
  source of costume/event data.
- `scripts/ingest/costume-lookup.json` — hand-resolved lookup table mapping Niantic costume
  codenames (e.g. `GOTOUR_2023_HAT`) to human-readable names, built up across several commits
  by visual confirmation and web search.
- `scripts/ingest/build-sprite-mapping.ts`, `scripts/ingest/pokemon-facts.ts` — V1 sprite/fact
  mapping helpers.
- `scripts/ingest/v2-schema.ts`, `v2-build-reference.ts`, `v2-build-extended.ts`,
  `v2-compare-reference.ts` — the V2-era build/compare scripts that consumed pokemon-go-api
  and pogoapi.net before the pipeline was reworked further.
