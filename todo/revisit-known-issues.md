## Revisit `KNOWN_ISSUES.md` once the cutover plan finishes

**Status:** Open

`KNOWN_ISSUES.md` is still an active dependency of the in-progress
generic-ingestion-engine plan (`docs/superpowers/plans/2026-07-30-generic-ingestion-engine.md`
references it ~10 times as the source of truth for expected values in
pending tasks, e.g. Task 22's dex-222 base-stat check, Task 24's planned
"Resolved/non-issues" note) -- do not delete or fold it while that plan is
still running (Tasks 22-26 as of 2026-08-02). Once the plan completes,
revisit whether its remaining "Still open" items should be migrated into
this file as regular TODO entries and the file itself retired, consistent
with `EVALUATION_REPORT_FROM_GOBUDDY.md` and
`IMPLEMENTATION_PLAN_FOR_ANTIGRAVITY.md` having already been folded/removed
on 2026-08-02 once they stopped being load-bearing.
