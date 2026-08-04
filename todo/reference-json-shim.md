## DONE (2026-08-03): reference_json_shim wholesale dump

**Status:** Done

`docs/superpowers/plans/2026-08-02-reference-json-shim-source.md`'s Tasks
2-5 (per-domain templates, entity-identity resolution, trust-tier
integration) were flagged by the project owner as too heavy for a
short-term shim and were **not built as originally planned** — replaced
with `src/reference_shim.py`, which wholesale-dumps all 25 top-level arrays
in `data-authoring/reference_json_shim/reference.json` into
`refjson_<snake_case>`-prefixed tables in `output/GoRefs_Master.duckdb` via
`uv run go_refs.py --load-reference-shim`. No identity resolution, no
templates, no claims-ledger integration. Committed and working (141/141
tests passing as of `6490cf0`). The plan doc itself is marked superseded at
the point Tasks 2-5 begin.

**Still open from that plan: Task 1 (badge_id fix)** — `src/builder.py`'s
badge identity still falls back to `id-or-name`; `KNOWN_ISSUES.md` #3 is
not yet fixed. Not started.

**Known, confirmed exceptions to "reference.json's data all exists
somewhere in GoRefs' own 7 sources already" (per the 2026-08-02 coverage
report, `.superpowers/sdd/2026-07-30-generic-ingestion-engine/reference-json-coverage-report.md`):**
`pvpRankRewards` (240 rows) is a **total** gap — no raw or canonical
equivalent found anywhere across all 7 sources, not just unmodeled.
`backgrounds` (2 rows, AR-photo backgrounds) is a genuinely unrepresented
concept, also not present in any raw source. Both will need new upstream
ingestion eventually, not just promotion of already-ingested raw data —
unlike `form_moves`/`species_evolutions`/`player_level_rewards`, which do
have raw ingredients already sitting in `gm_pokemonsettings`/`gm_leveluprewards`,
just unmodeled.

This supersedes `--test-paranoid` as the active direction (see next
section) because it compares GoRefs' canonical output against GoBuddy's
canonical output — target-vs-target, no coordinate-space problem — rather
than needing the harder source-vs-target reconstruction `--test-paranoid`
got stuck on.
