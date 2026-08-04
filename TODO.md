# TODO

## `assets` source is defined but barely populated (20 sprites, no manifest)

2026-08-03: noticed while implementation-planning GoBuddy's ingestion swap.
`config/sources.yml` already defines `assets_base_url`
(`raw.githubusercontent.com/pokemon-go-api/assets`) and `asset_dump_dir`
(`raw_dumps/assets`) — the same underlying sprite source GoBuddy's own
sprite pipeline downloads from (indirectly, via pokemon-go-api's pokedex.json
image URLs). But `raw_dumps/assets/` currently has only 20 files
(`pm1.icon.png`-`pm20.icon.png`, base species icons only — no forms,
costumes, region variants, mega, or shiny art), no `.meta.json` tracking it
like every other source has, and no slug/species manifest mapping files to
species. Not usable as a real sprite source today. If this gets built out to
full coverage + a manifest, GoRefs could eventually become the sprite source
for consumers too (not just reference data), removing the need for a
downstream app to fetch sprites separately. Not started; flagged only as a
possibility worth not losing.

## Port GoBuddy's transform logic into GoRefs' own canonical processing

2026-08-03: flagged from the GoBuddy side while implementation-planning its
ingestion swap to pull from this project. Right now, five-plus domains
(`forms`, `megaVariants`, `moves`, `formMoves`, `speciesEvolutions`, `medals`/
`medalTiers`, `playerLevels`/`playerLevelRewards`, `pvpRankRewards`/
`pvpRankRequirements`, and for this first cut `species`/`typeEffectiveness`/
`weatherBoosts` too) only reach real parity with GoBuddy's `reference.json`
via the `refjson_*` shim — a wholesale dump of GoBuddy's own already-processed
output, not independent GoRefs processing. That's fine as a stopgap, but it's
circular: GoBuddy currently processes all its sources itself (slug
generation, gap detection, comparative-gap rules, gender-split forms, etc.
in `scripts/ingest/transform/*.ts`), and GoRefs is just re-serving that
processed result back.

The real target: port that processing *logic* (not just consume its output)
into GoRefs' own Python pipeline (`src/builder.py` and friends), so GoRefs'
canonical tables converge on correctness using the same proven rules GoBuddy
already worked out, applied to GoRefs' own 7 independently-ingested sources
— not by copying GoBuddy's output forever. Each domain currently on the
`refjson_*` shim is a candidate for this, one at a time (matches the
existing "one-line swap once canonical catches up" pattern already used for
the shim-fallback domains). Big, not scoped, not started — logged so it
isn't lost.

## `--fetch` should skip sources with no upstream change

2026-08-03: flagged from the GoBuddy side alongside the "expose a
last-updated timestamp" item below, while designing its ingestion swap to
pull from this project. `--fetch` currently always re-fetches every source
fresh, unconditionally. It should check whether a source's upstream has
actually changed (e.g. via a cheap HEAD/ETag/hash check, source-dependent)
and skip writing a new `raw_dumps/<source>/<timestamp>/` snapshot when
nothing changed. Two motivations: (1) avoids redundant network calls on
every fetch, (2) directly reduces the `raw_dumps/` unbounded-growth problem
in the item just below — most of its ~20 accumulated snapshot dirs likely
represent runs where nothing upstream actually changed. Not started.

## `raw_dumps/` needs a retention policy before it grows unbounded

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

## DONE (2026-08-03): `_meta` table: last-pulled-per-source + last-built-at

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

## Add a `--publish` step: GitHub Release for `output/GoRefs_Master.duckdb`

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

## DONE (2026-08-03): pushed to GitHub — see "Before adding a git remote origin" below

Repo is now public at `github.com/theflyingfool/GoRefs`. History was squashed
(97 local commits → 1) before the first push; `output/GoRefs_Master.duckdb`
was dropped from tracking in the same pass (see the `--publish` item above
for why). The two open questions in "Before adding a git remote origin"
were resolved as part of this: `docs/superpowers/*` planning docs were left
tracked as-is (no separate decision made either way in this pass), and
history was in fact rewritten (squashed) specifically to drop the oversized
duckdb blobs.

## DONE (2026-08-03): reference_json_shim wholesale dump

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

## `--test-paranoid` (data-parity plan) paused after Task 4 — has a known critical bug, not yet fixed

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

## Idea (not pressing, may never happen): `--test-paranoid` auto-chains into `--test`, eventually "run everything"

Spitballed 2026-08-02 while designing the rebuilt `--test-paranoid`
(`docs/superpowers/specs/2026-08-02-data-parity-paranoid-check-design.md`).
Once the paranoid check produces its report, `--test-paranoid` could
automatically kick off the regular `--test` run that consumes it, instead
of that being a separate manual step. Further out, and much less certain:
`--test-paranoid` is explicitly meant to be over-the-top thorough, so it
could eventually grow into running essentially every database check this
project has (ledger replay, the paranoid field-coverage scan, whatever
else accumulates) as one single "throw everything at it" command. No
design work has gone into this, no task exists for it, and it may never
get built -- just don't want the idea lost.

## `pokeapi` fetcher enhancement

Its current fetcher (`src/fetchers/pokeapi.py`) only pulls list endpoints
(`{name, url}` pairs) -- genuinely mappable data (flavor text, genera/category)
requires per-resource detail fetching (~1000+ additional HTTP calls across
species/moves). Deferred until there's a concrete consumer need; the generic
engine (this plan) is now in place to receive the mapped output whenever this
is picked up.

## `pokeapi` profiler auto-discovery gap

`pokeapi` is a multi-endpoint source (`pokemon`, `pokemon_species`, `type`,
`move`), but unlike `pokemon_go_api` and `pogoapi_net`, its endpoints are
discovered dynamically at fetch time rather than declared statically in
`config/sources.yml`. The profiler (`src.profiler.SourceProfiler`) only knows
about endpoints listed in `config/sources.yml`, so neither
`uv run go_refs.py --deep-dive pokeapi` (assumes endpoint name == source key)
nor `--deep-dive all` (reads `sources.yml`'s `endpoints:` list) can currently
discover `pokeapi`'s per-endpoint raw dumps automatically. The `pokemon`
endpoint's template (`config/source_templates/pokeapi_pokemon.yml`, used by
this cutover) was generated with a direct `profiler.profile_source("pokeapi",
"pokemon")` call as a one-off workaround. Do not add a static `endpoints:`
list to `config/sources.yml` for `pokeapi` to fix this -- the fetcher's
`if not endpoints:` branch treats a non-empty `endpoints` config as
authoritative and would disable its dynamic index-discovery behavior
entirely. A real fix needs the profiler (or `--deep-dive`) taught to read a
multi-endpoint source's *actual* raw-dump directory contents when
`sources.yml` doesn't enumerate `endpoints`, rather than assuming a single
`{source_key}.json` file.

## GAME_MASTER badge alignment (from GoBuddy's evaluation, 2026-07-30)

GoBuddy's own ingestion does a two-pointer subsequence alignment against
GAME_MASTER specifically to keep a live FK
(`medal_progress_personal.medal_slug`) in sync with badge definitions.
GoRefs' `badges` table has no equivalent alignment step -- not a bug in
GoRefs itself (this repo has no such FK to maintain), but relevant if
GoRefs' badges table is ever consumed by GoBuddy or a similar downstream
project: that consumer would need to rebuild this alignment logic, not
reuse anything from here. Also relevant to `KNOWN_ISSUES.md`'s existing
"`badge_id` collisions" entry (382 badges collapsing onto 184 keys) --
fixing that collision is a prerequisite for any consumer-side alignment
being reliable.

## Automatic re-profiling on source fingerprint drift

`SourceProfiler` computes and stores `source_fingerprint` per template, but
nothing currently diffs a fresh fetch's fingerprint against the stored one
to detect upstream schema drift automatically. Re-profiling today is manual
only (`--deep-dive <source>`). This was part of the original design intent
(see git history / `docs/superpowers/specs/2026-07-30-generic-ingestion-engine-design.md`
if still present) but was never scheduled as its own task. Worth doing once
the generic engine has been live long enough to have hit a real upstream
schema change.

## `--test`'s `needs_review` entries aren't surfaced

Templates can carry a `needs_review` list (low-confidence profiler guesses,
e.g. a fallback field that might produce a placeholder-looking value) but
`scripts/user_source_coverage_test.py`'s `LedgerReplayTester` doesn't
currently read or report on them as a distinct category -- a human has to
know to open `config/source_templates/*.yml` and grep for `needs_review`
manually. Would be a reasonable `--test` output addition: a summary list of
every unresolved `needs_review` entry across all templates.

## Revisit `KNOWN_ISSUES.md` once the cutover plan finishes

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

## Idea (not scoped, not now): web page for flagging known-ambiguous data

Spitballed 2026-08-02, explicitly deferred -- needs real design work before
any implementation, not a task to pick up as-is. The idea: a section of the
web explorer where users could see/select fields GoRefs already knows are
ambiguous or unresolved (e.g. the `badge_id` collision above, or entity-ID
namespace gaps in `KNOWN_ISSUES.md`) and submit a correction or a vote.

Open questions, none answered yet:
- Don't want to force GitHub sign-in as the auth gate (excludes casual
  players who'd actually know the answer, e.g. "yes I have this exact GO
  Fest badge and here's what game_master calls mine").
- Also don't want fully anonymous/unverified submissions -- no spam-quality
  gate at all invites garbage data.
- One spitballed (unvalidated) idea: a Google Form requiring a Pokémon GO
  in-game username + friend code as a lightweight identity/anti-spam gate,
  not because it proves anything cryptographically, but because it raises
  the cost of drive-by garbage submissions and gives a way to follow up.
  Not committed to this approach.
- Whatever the mechanism, submissions should land somewhere reviewed before
  affecting canonical data -- this is not meant to auto-apply user input to
  `output/GoRefs_Master.duckdb`.

Needs a proper brainstorming/design pass (see `superpowers:brainstorming`)
before it becomes a real task -- flagging the idea here so it isn't lost,
not asking for it to be built.

**Update 2026-08-02 (Task 24 prep): this is further along than "spitballed" --
most of the plumbing already exists, unused.** `config/sources.yml`'s
`local_authoring` entry is explicitly named `"Confirmed Owner Submissions &
Overrides"` (`trust_tier: "confirmed_owner_submission"`, mapped to priority 1
in `builder.py`'s `TRUST_HIERARCHY` -- the highest trust level in the whole
system) and lists `data-authoring/community-submissions.json` as one of its
two source files (the other, `costume-lookup.json`, is live -- Task 23).
`src/ingest_community_submissions.py` already exists and is a real, if
minimal, CLI tool: `python src/ingest_community_submissions.py --csv <path>`
parses a CSV (its own docstring says "from Google Forms / GitHub Issue
Forms"), maps `pokemon_name`/`attribute`/`value`/`Timestamp` columns (with
fallback column-name aliases suggesting it was written against a specific
real form's export headers), and writes each row into
`community-submissions.json` tagged `trust_tier: "confirmed_owner_submission"`
-- the exact string that already resolves to priority 1. So the intended
design is: Google Form (or GitHub Issue Form) → CSV export → this script →
`community-submissions.json` → picked up automatically by the
`local_authoring` fetcher on its next snapshot → (needs a
`local_authoring_community-submissions.yml` template once real data exists,
not written yet since there's nothing to profile) → claims at priority 1,
same tier as `costume-lookup.json`.

**What's actually still missing, now more precisely scoped:**
1. No collection front-end exists yet -- no Google Form, no GitHub Issue Form
   template, nothing a real user would fill out.
2. **No verification/anti-spam gate at all.** The script hardcodes
   `trust_tier: "confirmed_owner_submission"` on every row unconditionally --
   it trusts the entire CSV blindly. Anyone who can get a row into that CSV
   (however that ends up working) gets treated as maximum-trust, higher than
   every upstream game-data source. This is the real design gap the
   "ambiguous data" idea above was circling -- not "should we let users
   submit data" (the pipe already exists) but "what stops garbage from
   riding in at the highest trust tier once it does."
3. No template for `community-submissions.json` yet (correctly deferred by
   Task 23, since there's no data to profile against).

Given priority-1 blind trust is a real correctness risk once any submission
path exists, don't wire up a Google Form or similar collection mechanism
without first deciding on real verification -- this is exactly why the
ambiguous-data-flagging idea above needs a proper design pass before
becoming a task, not a reason to rush the missing 20%.

## Before adding a git remote origin

- Decide whether `docs/superpowers/plans/*.md` and `docs/superpowers/specs/*.md`
  (the AI-tool planning/spec documents, currently tracked in git) should stay
  tracked as project history or be untracked/gitignored as local-only working
  files. Left tracked for now (2026-08-02 decision) -- revisit before this repo
  is pushed anywhere public.
- Consider whether git history needs rewriting (e.g. squashing/dropping any
  commits that shouldn't be visible externally) before the first push to a
  remote. Nothing specific flagged yet -- this is a reminder to check, not a
  known issue.
