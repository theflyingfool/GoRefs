# Ingestion consolidation — summary

2026-07-29. Replaces pogoapi.net as an ingestion data source and
consolidates the 9-script `scripts/ingest/` pipeline into one orchestrator.
Full plan: `/home/nick/.claude/plans/linear-rolling-beaver.md` (outside the
repo — ask if you need it re-surfaced). This doc is the "read this first"
entry point; the [`reports/`](reports/) folder has every task's full,
unabridged report and brief if you want to go deeper on anything.

## The one-paragraph version

pogoapi.net (a community data source this app depended on for several
things beyond species/forms — moves, player XP, badges, PvP rewards,
friendship levels, and more) turned out to be stale and its continued
availability isn't guaranteed. It's now fully replaced: GAME_MASTER (a raw
Niantic game-config mirror, `alexelgt/game_masters`) covers most of what
pogoapi.net provided and is more current; a community shiny-release-date
tracker (the "pokemongo-shiny" sheet) replaces shiny availability with real
per-form release dates instead of an unreliable asset-presence heuristic;
and everything pogoapi.net uniquely had (chiefly medal/badge display names)
was captured in a one-time, version-controlled snapshot (`vendor/pogoapi-snapshot/`)
before cutting the live dependency. The whole `scripts/ingest/` directory
was rebuilt from 9 separate scripts into one command, `npm run ingest`.

## What you should know without reading further

- **pogoapi.net is gone as a live dependency.** Nothing in this app fetches
  it anymore. Its data lives on, where still needed, as the committed
  `vendor/pogoapi-snapshot/` (47 endpoints, README explains why).
- **`npm run ingest` is now the only ingestion command.** Flags:
  `--skip-sprites`, `--skip-sqlite`, `--check` (dry-run: reports whether
  anything upstream changed, never writes). The old
  `ingest:fetch`/`ingest:build`/`ingest:fetch-sprites`/`ingest:build-sprites`/
  `ingest:check-slugs`/`ingest:all`/`ingest:csv:*` scripts are gone.
- **A real, full `npm run ingest` run was already done and committed** as
  the very last step of this work — `src/data/reference.json` and every
  artifact that ships from it are current as of 2026-07-29, not stale.
- **New data**: `form.shinyReleasedAt` — a real release date (or `null`) for
  shiny availability, replacing a boolean that was previously sourced from
  an unreliable signal (confirmed via a real false-positive case, Eternatus
  — see Task 3 below). 2391 of 2716 forms currently have a real date.
- **Medals were the one genuine correctness risk in this whole project.**
  GAME_MASTER has no medal name/description text at all — using it directly
  would have renamed/re-slugged ~600 medals and crashed the sync for any
  user with medal progress (a live foreign key with no safety net). Fixed
  by recovering real names from the vendored pogoapi snapshot via an
  alignment algorithm — all 183 production medal slugs verified stable
  (independently reproduced by a reviewer against real data, twice). One
  known, narrow limitation remains: the alignment only catches ~13% of a
  specific future failure mode (a badge quietly removed from a future
  GAME_MASTER update) — documented in code, not something you need to act
  on now, but worth knowing if a future ingest run ever looks like it's
  produced wrong medal names.
- **A few data values changed on purpose, not by accident** (owner-directed
  trade-off — "do what is easiest," since a future separate project will
  eventually replace this whole pipeline anyway): friendship-level XP now
  reflects GAME_MASTER's real current figures (was a stale uniform 1.5×
  scaling before); PvP rank rewards/requirements now cover 24 ranks (was
  10); some item names lost accent marks ("Poke Ball" not "Poké Ball"); 13
  extra gender-specific form rows appeared across 6 species; and 111 of 399
  medal-tier rows (event-badge tiers only, not regular medals) don't
  currently resolve. None of these are bugs — they're what the fresher
  sources actually say.
- **A correction to a number from partway through this work**: the
  "species GAME_MASTER shows as shadow-eligible that pogoapi.net's list is
  missing" figure is **222**, not 226 as first stated mid-project — a
  later, more rigorous recomputation (dex-number join instead of a
  name-based join) landed on 222 and was independently re-verified against
  real data. If you saw 226 mentioned earlier, 222 is correct.
- **Two follow-up documents exist, not yet acted on**, both written mid-project
  when this session's scope briefly expanded beyond the ingestion swap:
  - [`docs/drafts/db-architecture-options.md`](../drafts/db-architecture-options.md) —
    pros/cons of the on-device SQLite storage architecture (one file vs.
    two, JSON-vs-prebuilt-file). Recommends a hybrid approach; not
    implemented.
  - [`docs/drafts/multi-source-reference-data-storage.md`](../drafts/multi-source-reference-data-storage.md) —
    brainstorm on handling many data sources with a precedence/conflict
    system, prompted directly by the medal problem above. Recommends a
    minimal, grow-as-needed precedence table over a general framework; not
    implemented (the medal fix used an ad hoc version of this idea instead,
    per your "do what is easiest" direction).
- **Unresolved housekeeping**: `docs/drafts/GAME_MASTER.json` (~18MB) is
  still untracked, not gitignored — one `git add -A` away from being
  committed by accident. This was flagged, not decided, during this
  project; still needs your call.
- **New dev tool**: `npm run studio` opens `drizzle-kit studio` against a
  freshly-regenerated `reference.sqlite` (real ingested data, no fake
  personal-table demo data) for browsing the reference tables directly.

## Per-task summaries

Each task was implemented, then independently code-reviewed (spec
compliance + quality), with fix rounds where the reviewer found real
issues — several did. Full detail, including exact file:line findings and
what was verified against real data (not just claimed), is in each task's
linked report.

### Task 1 — [`sources/game-master.ts` indexed parser](reports/task-1-report.md)
Built the parser for the raw GAME_MASTER.json feed (~18,700 entries):
groups records by category first, then by each category's own natural key
— a two-level design corrected during planning after an earlier one-level
design was found to be wrong. Also surfaced that GAME_MASTER's real field
names for gender/friendship/PvP-league data didn't match what was
originally guessed — verified against real data before proceeding, not
assumed. Reviewed clean.

### Task 2 — [Source modules + always-fresh fetching](reports/task-2-report.md)
Added `sources/pokemon-go-api.ts` and `sources/shiny-sheet.ts`, and changed
the shared fetch helper to always re-fetch (needed for change-detection to
work at all — a cache that never refetches can never detect an upstream
change). Resolved the real, working URL for the shiny-tracker sheet
(the one first tried in conversation had transiently failed; independently
re-verified working before use). Reviewed clean.

### Task 3 — [Transform modules, re-sourced](reports/task-3-report.md) + [medal fix](reports/task-3-fix-medals-report.md)
The largest task: ported the actual business logic (moves, evolutions,
player progression, PvP, and all species/form building — including several
non-obvious rules like baby-Pokémon family exclusions and a Nidoran
display-name cleanup) onto the new sources. This is where the medal problem
(see above) was discovered and, after your direction, fixed via the
vendored pogoapi snapshot. Also fixed: shiny availability now correctly
excludes Eternatus (a real false-positive the old asset-presence heuristic
produced — confirmed directly against your own in-game experience).
Reviewed clean after the medal fix, including an independent reproduction
of the "183/183 medal slugs stable" claim against real data.

### Task 4 — [`ingest.ts` orchestrator](reports/task-4-report.md) + [fix round](reports/task-4-fix-report.md)
Consolidated fetch/build/sprites/slug-check into one script with a clean
step-list design (so `--skip-sprites` etc. compose without nested
if-statements), collapsed `package.json` to `npm run ingest` +
`ingest:check`, and deleted the 4 scripts this replaced. Fix round: the
first version of `--check` had a real bug — it wrote the comparison
manifest to disk even during a dry-run check, which would have made future
checks permanently report "no changes" after an innocent `git commit`.
Fixed; also removed a stale, unused raid-boss fetch that would have caused
false-positive "changed" reports on unrelated upstream churn. Reviewed
clean after the fix.

### Task 5 — [Shiny schema extension](reports/task-5-report.md) + [fix round](reports/task-5-fix-report.md)
Added the `shinyReleasedAt` column described above. Confirmed no database
migration file was needed (reference tables are rebuilt wholesale on every
app update, by design). Fix round: the in-app Coverage Report's CSV export
was initially missed and would have silently omitted the new field forever
— fixed to match every sibling field's pattern. Reviewed clean.

### Task 6 — [SQLite-studio output](reports/task-6-report.md)
Added the `npm run studio` dev tool described above. Verified the existing
`build-dummy-db.ts` (used for other demo/testing purposes) is still needed
alongside this, not redundant. Added one new dev-only dependency
(`better-sqlite3`, required by `drizzle-kit studio` itself) — confirmed
it cannot end up in the shipped mobile/desktop app bundle. Reviewed clean.

### Task 7 — [Docs](reports/task-7-report.md)
Turned out most doc updates were already done incrementally by Tasks 4 and
6 while they touched adjacent code — this task mainly verified accuracy and
added the one real gap: a new dated section in
`docs/v2-data-source-findings.md` recording the pogoapi.net-is-stale
finding and what replaced it. (Two small doc staleness spots were missed by
this task's "verify, don't rewrite" pass — caught and fixed in the final
whole-branch review below, not a re-open of this task.)

### Final whole-branch review — two rounds
A full-branch review (reading all 7 tasks together, looking specifically
for cross-task issues no single task's review could see) found the pipeline
architecture itself sound — but caught one real, must-fix problem: the
`reference.json` actually shipped in the repo predated Task 5's schema
change, so the new `shinyReleasedAt` field would have shipped completely
empty despite all the plumbing being correct. Fixed by running the real,
complete pipeline one more time and committing the result — see
[fix report](reports/task-8-fix-report.md). Also added a safety check to the
medal-alignment code that a stress test showed only catches part of one
specific future failure mode; the code comment describing it was initially
too optimistic and was corrected after a reviewer empirically measured its
real coverage (13%, not "fully defended") — see
[comment-fix report](reports/task-8-fix2-report.md).

## Full chronological ledger

[`reports/progress-ledger.md`](reports/progress-ledger.md) has the
complete, unabridged, chronological record of every task, every fix round,
and every finding (including Minor ones deliberately left unfixed) in the
order they actually happened — useful if you want the full story rather
than this summary's condensed version. Note: it also contains an earlier,
unrelated sub-project's history from before this work started (Sub-projects
7b/7c) — scroll to "Ingestion consolidation" for where this project's
record begins.
