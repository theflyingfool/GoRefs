# reference_json_shim provenance

Copied from `/home/nick/Repos/GoBuddy/src/data/reference.json` on 2026-08-02.
This is a manual, one-time snapshot -- not a live sync. Refresh by re-copying
the file and re-running `uv run go_refs.py --load-reference-shim`.

Loaded via `src/reference_shim.py` into `output/GoRefs_Master.duckdb` as
`refjson_<snake_case_domain>` tables -- a raw, unmodeled dump of every
top-level array in reference.json, prefixed to keep it clearly separate from
GoRefs' own canonical tables. Consumers should keep using the real
unprefixed tables (`species`, `forms`, `moves`, `badges`, etc.) for anything
GoRefs already models; the `refjson_*` tables exist only for domains GoRefs
has no canonical table for yet (movesets, evolutions, PVP rank rewards,
etc.) -- once those get properly modeled, drop the matching `refjson_*`
table and switch consumers to the real one.

This is temporary. No template engineering, no claims-ledger integration,
no trust-tier resolution -- just a wholesale table-per-domain dump. See
`docs/superpowers/plans/2026-08-02-reference-json-shim-source.md` for the
one-time reasoning behind the original, much heavier design this replaced.
