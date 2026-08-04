## Add a `--publish` step: GitHub Release for `output/GoRefs_Master.duckdb`

**Status:** Open

2026-08-03: this repo is now public (`github.com/theflyingfool/GoRefs`), but
`output/GoRefs_Master.duckdb` is gitignored and **not** committed — it already
hit GitHub's 100MB-per-blob hard limit once (grew to 166MB across build
history) and is expected to keep growing well past that as more source
datasets are added beyond the current 7. A full storage-options writeup
(Git LFS quotas/pricing, Parquet-over-HTTP via `httpfs`/DuckDB-WASM, GitHub
Releases, external object storage, DVC/git-annex/HF alternatives) was done
2026-08-03 from the GoBuddy side — see `/tmp/gorefs_storage_strategy_report.md`
if still present on disk (not committed anywhere, so re-derive/re-run if it's
gone).

**Recommended direction from that report:** stop treating the monolithic
`.duckdb` as something to commit at all. Instead:
1. Git-track only the per-table Parquet exports already produced by
   `--build` (`output/parquet/`) as the DuckDB-WASM/`httpfs`-servable
   artifact, served via `raw.githubusercontent.com` — **not** GitHub Pages,
   which has a documented bug mishandling byte-range requests on binary
   files.
2. Add a `--publish` (or similar) step to `go_refs.py` that runs
   `gh release create`/`gh release upload` to publish the full
   `output/GoRefs_Master.duckdb` as a versioned Release asset (2GB/file cap,
   outside Git LFS quota entirely) for consumers who want single-file
   offline access, decoupled from git history size.
3. Hold off on R2/B2/DVC/git-annex/Hugging Face — only worth revisiting if
   the `.duckdb` itself approaches ~2GB.

Not started — no `--publish` flag, no release-upload script, exists yet.
