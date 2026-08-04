## `raw_dumps/` needs a retention policy before it grows unbounded

**Status:** Open

2026-08-03: `raw_dumps/` was just un-gitignored and committed (previously
excluded) so this repo actually preserves upstream snapshots for continuity
(GoBuddy's `pokemon-go-api` submodule vendoring served the same purpose
elsewhere; removing that made GoRefs itself the source of truth for this).
Currently 53MB across ~20 timestamped snapshot directories accumulated over
a few days of dev activity (e.g. 5 separate `pokeapi/<timestamp>/` dumps).
**Every `--fetch` run adds a new timestamped snapshot dir with no pruning** —
left as-is, this reproduces the exact unbounded-growth problem
`output/GoRefs_Master.duckdb` just hit (166MB, forced a history squash),
just spread across many smaller files instead of one. Needs a policy before
it becomes a real problem: e.g. keep only the last N snapshots per source,
or squash/prune older ones on each `--build`. Not started.
