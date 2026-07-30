### Task 7: Docs

Update, in this order (each is a rewrite of stale content, not an
incremental patch — read each file in full first):
- `docs/ingestion-runbook.md` — rewrite around the single `npm run ingest`
  command and its flags (`--skip-sprites`, `--skip-sqlite`, `--check`),
  naming the real sources (`pokemon-go-api`, GAME_MASTER via
  `alexelgt/game_masters`, the pokemongo-shiny sheet). Drop the stale
  PokeAPI+CSV+wikitext description and all pogoapi.net mentions. Remove the
  CSV-round-trip section (that workflow no longer exists) and the
  slug-stability section (now automatic, not a separate step) — replace
  with a short note that both are handled inline by `npm run ingest`.
- `docs/architecture.md` — in the Scripts table, replace the rows for
  `ingest/fetch-reference-data.ts`, `ingest/build-reference.ts`,
  `ingest/fetch-sprites.ts`, `ingest/build-sprites.ts`,
  `ingest/check-slug-stability.ts`, `ingest/csv-authoring.ts` with rows for
  `ingest/ingest.ts` and the new `sources/`/`transform/`/`write/` modules
  (one row per module is fine, or a slightly condensed table — use
  judgment, this table is meant to be scannable). Add
  `ingest/sources/game-master.ts` explicitly given it's the biggest new
  addition.
- `docs/v2-data-source-findings.md` — append a new dated section (today's
  date — check the system date, don't guess) documenting: pogoapi.net
  confirmed stale (shadow list missing 226 species GAME_MASTER has, no
  acquisition-method breakdown available from the shiny-sheet replacement),
  and the GAME_MASTER + pokemongo-shiny sourcing decision that replaced it.
  Do not edit the existing historical findings in place — append only, per
  this repo's documentation rule (archive obsolete info, don't let it
  silently drift).

No code changes in this task — docs only. Verify every command/flag/file
path you write about actually exists by checking the real repo state after
Tasks 1-6 land, not by copying this plan's prose verbatim (the plan was
written before implementation; names may have shifted slightly during
building).

## Not in this pass

- Reference/personal DB split — see `docs/drafts/db-architecture-options.md`;
  a follow-up decision, not blocking this swap.
- Any new GAME_MASTER-sourced features beyond what this swap needs (real
  player-level-80 curve is a side effect of the player-progression swap
  above, not new scope; candy-to-level tables and other half-built-feature
  data stay untouched).
