# GoRefs TODO Tracker

| What | Status | Brief description | Link |
|------|--------|-------------------|------|
| assets source | Open | Expand sprite coverage from 20 base icons to full manifest with forms, costumes, variants, mega, shiny | [details](assets-source.md) |
| Port GoBuddy's transform logic | Open | Decouple from `refjson_*` shim; implement proven processing rules (slug generation, gap detection, forms) natively in Python | [details](port-gobuddy-transform.md) |
| --fetch skip unchanged | Open | Check upstream for changes (HEAD/ETag/hash) before writing new snapshot; reduce network calls and raw_dumps bloat | [details](fetch-skip-unchanged.md) |
| raw_dumps retention policy | Open | Implement pruning strategy (keep last N per source or squash on build) to prevent unbounded growth (currently 53MB across 20 dirs) | [details](raw-dumps-retention.md) |
| Add _meta table | Done | Persist per-source last_pulled_at + database last_built_at to enable cheap change detection for consumers | [details](meta-table.md) |
| Add --publish step | Open | Release full duckdb as GitHub Release asset; track parquet exports in git for DuckDB-WASM/httpfs serving | [details](publish-step.md) |
| Pushed to GitHub | Done | Squashed history (97 → 1 commits), dropped oversized duckdb, made repo public | [details](github-push.md) |
| reference_json_shim wholesale dump | Done | Implemented wholesale dump of reference.json arrays into refjson_* tables; 141 tests passing | [details](reference-json-shim.md) |
| --test-paranoid paused | Open | Core three-tier classification broken; compares raw paths vs canonical names without unwrap_path/renames; plan paused pending GoBuddy focus | [details](test-paranoid-paused.md) |
| --test-paranoid auto-chain idea | Open | Future: auto-chain paranoid check → regular tests → "run everything"; no design yet | [details](test-paranoid-auto-chain.md) |
| pokeapi fetcher enhancement | Open | Add per-resource detail fetching (~1000 HTTP calls) for flavor text, genera, category; deferred pending consumer need | [details](pokeapi-fetcher.md) |
| pokeapi profiler auto-discovery | Open | Fix dynamic endpoint discovery; profiler can't currently auto-detect multi-endpoint sources without static config | [details](pokeapi-profiler.md) |
| GAME_MASTER badge alignment | Open | Document FK-alignment logic for downstream consumers; blocker: fix badge_id collisions (382 → 184) first | [details](badge-alignment.md) |
| Auto re-profiling on drift | Open | Detect upstream schema changes automatically; currently manual-only (`--deep-dive <source>`) | [details](auto-reprofiling.md) |
| --test needs_review surfacing | Open | Report unresolved needs_review entries from templates as --test output summary | [details](test-needs-review.md) |
| Revisit KNOWN_ISSUES.md | Open | After generic-ingestion-engine plan completes; migrate open items to TODO, consider retiring file | [details](revisit-known-issues.md) |
| Web page for ambiguous data | Open | Community submission UI (no form built yet); verify/prevent spam before trusting at priority 1 | [details](web-page-ambiguous.md) |
| Before adding git remote | Open | Decide: track superpowers docs in git or gitignore; audit history for pre-push cleanup | [details](before-git-remote.md) |
