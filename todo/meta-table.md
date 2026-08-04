## Add a `_meta` table: last-pulled-per-source + last-built-at

**Status:** Done

2026-08-03: flagged from the GoBuddy side while designing its ingestion swap
to pull from this project (`vendor/reference/GoRefs`, vendored as a git
subtree + `--serve` — see GoBuddy's
`docs/superpowers/specs/2026-08-03-gorefs-ingestion-source-swap-design.md`).
Consumers hitting `--serve`'s HTTP endpoint have no cheap way to check "has
this database actually changed since I last read it" without
downloading/querying the whole `GoRefs_Master.duckdb` file — GoBuddy's own
`ingest:check` needs exactly this signal to replace the upstream
fingerprinting it loses once its direct GAME_MASTER/pokemon-go-api fetchers
are retired.

**Confirmed small** — the raw ingredients already exist, this is mostly
persisting data that's already computed:
- Every `raw_dumps/<source>/<timestamp>/.meta.json` already records
  `{source, etag, timestamp}` per fetch.
- `builder.py` already computes a build timestamp (`src/builder.py:1380`).

Added a `_meta` table to `output/GoRefs_Master.duckdb`: one row per source
with its most recent `last_pulled_at` (sourced from the `.meta.json` files
above), plus a `__build__` row for `last_built_at`. Written by
`write_master_duckdb()` on every `--build`. See `tests/test_meta_table.py`.
