## `--test-paranoid` (data-parity plan) paused after Task 4 — has a known critical bug, not yet fixed

**Status:** Open

2026-08-02: after Task 4 (DuckDB failure-mode hardening) shipped, the final
whole-branch review found the check's core three-tier classification is
broken (C1 in
`.superpowers/sdd/2026-08-02-data-parity-paranoid-check/final-review.md`):
it compares raw source field paths against target/canonical names directly,
ignoring template `unwrap_path` prefixes and field renames. Result: 5 of 6
sources falsely report ~0 `CANONICAL` fields. `output/paranoid_check_report.md`
(untracked) is marked invalid at its top and must not be trusted or acted on.

**Project owner decision (2026-08-02): pausing this plan here**, not fixing
C1 right now. Priority is shifting back to GoBuddy (the actual product),
using GoBuddy's existing manual/Obsidian-CSV → `reference.json` pipeline as
the live data source in the meantime. Nothing built here is reverted — Tasks
1-4 (dual-method field inventory, three-tier classification scaffolding,
orchestration/CLI, DuckDB hardening) are committed and stay. Full details,
including the fix direction if this is picked back up, are in the ledger:
`.superpowers/sdd/2026-08-02-data-parity-paranoid-check/progress.md`.
