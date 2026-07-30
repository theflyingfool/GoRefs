# Ingestion consolidation — SDD progress ledger

Plan: /home/nick/.claude/plans/linear-rolling-beaver.md
Worktree: .claude/worktrees/ingest-consolidation (branch worktree-ingest-consolidation)

Started at commit: e1491eb7

Pre-flight scan: clean (task ordering 1->7 is a genuine dependency chain,
no contradictions found between tasks or against Global Constraints).

Task 1: complete (commits e1491eb7..53a2db5b, review clean/Approved). Indexed
GAME_MASTER parser: category-first then natural-key-within-category, exactly
as corrected in plan review. Real-data-verified deviations from the brief's
guessed keys: genderSettings/friendshipMilestoneSettings/combatLeague key by
templateId (within-category, not the category key) since real data has no
usable natural key for these three (confirmed via jq against the real
18.7MB GAME_MASTER.json). Added allX() enumeration accessors beyond the
literal brief -- reviewer confirmed not overbuilding, later tasks need full
enumeration not just point lookups.
Minor findings logged, not fixed (candidates for final-review triage):
(1) real-data smoke test doesn't suppress console.warn, so 18 real
levelUpRewards conflicts spam multi-KB JSON dumps during test runs;
(2) warnConflict JSON.stringifies whole records instead of naming specific
diverging fields like build-reference.ts's existing convention does;
(3) pokemonSettingsKey treats form:null as pokemonId-only key -- correct
behavior, just worth a one-line comment for the next reader.

Task 2: complete (commits 53a2db5b..f35dfe5d, review clean/Approved). New
sources/pokemon-go-api.ts + sources/shiny-sheet.ts (parse-only, matching
Task 1's convention) + http-cache.ts fetchToCache(url, path, {skipIfExists})
defaulting to always-refetch, sprites opt into skipIfExists:true, hash-on-
write via existing hashContent (src/db/content-hash.ts), sidecar .hash file
readable as pure read. Shiny sheet URL resolved with high confidence:
https://opensheet.elk.sh/1l1CXHdge8_2F2ifjMY71f23DJ_98Ei2QNZ9rPdBd8jQ/'pm2026'
(literal quotes in path) -- controller independently re-verified via curl
(earlier same-session failure on this exact URL was transient, not a real
problem); workbook.xml tab enumeration proved the old numeric-index-4
fallback was position-dependent/fragile, this named-tab URL is preferred.
fetch-reference-data.ts/build-reference.ts correctly left untouched (later
task deletes them); PGAPI_FILES duplicated between the new source module and
the still-live fetch-reference-data.ts is a known, accepted drift risk until
that deletion lands.
Minor findings logged, not fixed: (1) PGAPI_FILES duplication (see above,
resolves itself when Task 4 deletes fetch-reference-data.ts); (2) a test
helper's partial-cast Response mock could use a clarifying comment.

Task 3: DONE_WITH_CONCERNS (commits ec966176, f94f9d8a) -- implementer
completed all 5 transform modules, real-data parity clean (0 vanished
slugs, 0 type-eff diffs, 0 duplicate PKs), Eternatus shiny false-positive
correctly excluded. BUT flagged a real correctness blocker: GAME_MASTER's
badgeSettings has no medal name/description text at all (confirmed by
controller via direct case-insensitive search of the whole GAME_MASTER.json
for "jogger" -- all 69 hits are avatar-clothing asset names referencing
BADGE_TRAVEL_KM, not the medal's actual display text), so re-sourcing
medals from GAME_MASTER would rename/re-slug ~600 rows and break the live
medal_progress_personal FK (quarantineOrphans doesn't cover it -> sync
would crash at COMMIT for any user with medal progress).

OWNER DECISION (scope pivot, mid-Task-3): don't patch medals narrowly.
Vendor ALL 45(47) pogoapi.net endpoints as a full, version-controlled
snapshot now (pogoapi.net's availability isn't guaranteed to last), commit
it BEFORE any further processing -- done, see commit 2dfdc51
("Vendor a full pogoapi.net snapshot (all 47 endpoints)",
vendor/pogoapi-snapshot/, 4.3MB, README documents purpose/date/non-live-
dependency status). Owner also asked for a brainstorm report (not a plan,
not code) on multi-source data storage / precedence rules / DB-size and
JSON-read-at-boot concerns going forward -- in progress next, written to
docs/drafts/ per this repo's established scratch-doc convention.

PAUSED per explicit owner instruction: "pause the ingestion upgrade until
that's done" -- Task 3's review/fix loop and Tasks 4-8 are on hold pending
the brainstorm report and further owner direction on how vendored-snapshot
data now factors into Task 3's medal handling and the rest of the plan.
Do not resume Task 3's review or dispatch Task 4 without new instruction.

Task 3: complete (commits f35dfe5d..fdaa0443, review clean/Approved by opus
reviewer who independently reproduced the medal-slug-stability claim against
the real 997-entry GAME_MASTER dump, not just accepted the report). Medal
fix: scripts/ingest/sources/pogoapi-badges.ts's alignVendorBadges (subsequence
alignment, not naive positional index -- the naive version was tried first
and found to break ~11% of real badges before being replaced) recovers all
183 production medal names/descriptions/slugs from vendor/pogoapi-snapshot
with zero FK-breaking mismatches; 111/399 medal_tier rows (event-badge tiers)
stay unrecovered, a disclosed non-blocking gap (no FK depends on tier rank).
Owner explicitly scoped this as "do what is easiest" (a future consolidated-
ingestion project will eventually replace this pipeline) -- friendship XP
values, 24 vs 10 PvP ranks, item-name diacritic loss, +13 gender-union form
rows all accepted as-is, not defects.
IMPORTANT HANDOFF TO TASK 4: check-slug-stability.ts's inline port must also
cover medal slugs, not just species/forms/megaVariants -- medal_progress_personal
is the one live FK with zero automated drift detection today (reviewer's
finding, not yet acted on).

Task 4: complete (commits fdaa0443..03164793, review clean/Approved after
1 fix round). ingest.ts orchestrator (PipelineStep list: fetch/build/
slug-check/sprites/manifest, flags --skip-sprites/--skip-sqlite/--check),
write/{reference-json,manifest,sprite-manifest}.ts, medal-slug coverage
added to the inline slug-stability check (symmetric with species/form/
megaVariant, 7 dedicated tests). package.json collapsed to ingest +
ingest:check. Deleted fetch-reference-data.ts, build-reference.ts,
check-slug-stability.ts, csv-authoring.ts (reference-csv-format.ts
untouched, confirmed still used by Coverage Report UI). Sprite wiring
genuinely light-touch (main()->exported functions, process.exit->throw).
End-to-end npm run ingest verified against live sources, same ballpark as
previously-committed reference.json.
Fix round: (1) --check no longer writes ingestion-manifest.json to disk
(was a false-negative machine -- every check run mutated the tracked
manifest file even with no upstream change, since fetchedAt timestamps
were never diff-compared; a routine commit after just checking would
permanently poison future checks) -- split into buildManifest (pure) /
writeManifestToDisk, only the real build path writes; (2) removed
pgapi/raidboss.json fetch+hash entirely, confirmed zero consumers since
Task 3 dropped raid-boss ingestion -- was a false-positive source (raid
rotations churn upstream constantly, unrelated to anything the pipeline
outputs). Implementer's self-review (via advisor) caught and fixed a third
real issue proactively: the already-committed ingestion-manifest.json still
carried the stale raidboss.json hash, which post-fix-1 would have been
permanently unfixable via --check alone -- hand-corrected in the same
commit, re-reviewer verified the JSON edit is surgically correct.
Minor logged, not fixed: ingest.ts's top-of-file header comment still lists
raidboss among consumed files (pre-existing, cosmetic); readCachedHash ??
"" edge case where two missing sidecars compare equal (low likelihood);
slug-check failure message points at no real escape hatch; --skip-sqlite
handled ad-hoc outside the PipelineStep loop (revisit when Task 6 adds a
real sqlite step); parseFlags does exact-string matching, no typo detection.

Task 5: complete (commits 03164793..eaa06483, review clean/Approved after
1 fix round). Added shinyReleasedAt (ISO date, nullable) to Form: DDL in
src/db/schema.ts (REFERENCE_SCHEMA_SQL, the file that actually matters,
correctly distinguished from schema/reference.ts), Drizzle typed schema in
schema/reference.ts, ReferenceData/types.ts, reference-sync.ts insert
mapping with ?? null defending the real current gap (committed reference.json
predates this field entirely -- key absent, not null). shinyAvailable kept
unchanged, purely additive. Migration question verified directly against
drizzle.config.ts: reference tables are deliberately excluded from
drizzle-kit's diff path, so DROP+recreate-from-DDL handles this
automatically, no migration file needed.
Fix round: src/data/reference-csv-format.ts (live Coverage Report UI export
dependency, explicitly self-documented as "extend this file for new Form
fields") was missed in the original pass -- added shiny_released_at
matching the exact sibling-field pattern (order, null-as-empty-string
convention), confirmed no CSV-import/parse path exists anywhere to also
update.
No new data yet: committed reference.json won't carry real shiny debut
dates until a fresh npm run ingest regenerates it -- schema/plumbing is
ready, data will populate on next real ingest run (flagged for whoever
runs that next, not a defect in this task).

Task 6: complete (commits eaa06483..9ce12780, review clean/Approved).
scripts/ingest/write/sqlite.ts builds reference.sqlite (node:sqlite
DatabaseSync + REFERENCE_SCHEMA_SQL, real data only, no fake personal
seed, transaction-wrapped, FK enforcement on) as a real PipelineStep --
the old ad-hoc --skip-sqlite console.log branch (Task 4's deliberately-
deferred gap) is fully removed, replaced with the same skip-predicate
mechanism --skip-sprites already used. drizzle.config.studio.ts +
npm run studio added, scoped to schema/reference.ts only (tested combined
schema/personal.ts too, no error, narrowed anyway for a data-correctness
reason -- disclosed as a values call beyond the brief's literal trigger,
not a hidden deviation). build-dummy-db.ts kept, verified genuinely
non-redundant (personal-schema seeding + a strict subset of reference
tables vs. the new file). New devDependency: better-sqlite3 (+node-addon-api),
required by drizzle-kit studio itself (not used by any of this repo's own
writer code, which stays on node:sqlite) -- verified devDependency-only,
unreachable from the shipped Tauri/Capacitor app bundle.
Minor logged, not fixed: drizzle.config.studio.ts's header comment cites a
"header comment" in drizzle.config.ts that doesn't actually exist there
(factual claim is still correct, just misattributed).

Task 7: complete (commit 9ce12780..217b5935, review clean/Approved). Most
of this task's original scope (rewriting ingestion-runbook.md/architecture.md)
turned out already done incrementally by Tasks 4 and 6's own doc sweeps --
verified accurate, not touched. Real work: appended v2-data-source-findings.md
section 12 (pogoapi.net staleness + GAME_MASTER/pokemongo-shiny replacement
+ medal-data resolution), append-only (0 deletions, confirmed in diff).
Fixed 2 genuinely dead build-reference.ts references in roadmap.md
(file no longer exists) + rewrote roadmap's stale Phase 0 speculative
framing into a shipped-outcome summary, preserving original spike bullets
as labeled history.
CORRECTION to a number stated earlier this session and already baked into
this ledger's Task 3 entry: the shadow-species gap is 222, not 226 -- the
implementer's first pass used a name-based join (matching this session's
original method) but self-corrected to a dex-number join per
v2-data-source-findings.md's own established §10 guidance (names don't
reliably match across sources, numeric dex join does). Independently
re-verified by the reviewer against real data: 467 GAME_MASTER-shadow-
eligible species, 245 in vendored pogoapi shadow_pokemon.json, exactly
222 missing, 0 reverse mismatches. USE 222 GOING FORWARD (Task 9's summary
doc and any future reference to this figure should say 222, not 226).

Final whole-branch review: complete (opus reviewer, commits e1491eb7..217b5935,
13 commits). Verdict: Ready to merge, with fixes -- 2 Important findings,
both fixed and re-reviewed clean:
(1) BLOCKING: shipped reference.json/reference-version.ts predated Task 5's
shinyReleasedAt column (0/2716 forms had it) and the committed
ingestion-manifest.json was inconsistent with the stale reference.json it
described -- fixed via a real, complete npm run ingest run (fetch->build->
slug-check->sprites->sqlite->manifest, no skips), all artifacts committed
together (commit 9fe56c31). Re-reviewer independently reproduced the FNV-1a
hash from raw reference.json content, matched reference-version.ts exactly;
confirmed 2716/2716 forms have the field, 2391 non-null; confirmed
reference-gaps.json's counts match the same build; confirmed manifest hashes
match on-disk cache files with a fresh fetchedAt. ingest:check itself
reported "No upstream changes detected" post-commit as live confirmation.
(2) alignVendorBadges had no consumed-everything assertion -- a shift could
leave medal slugs stable (no FK risk) but silently mis-attach medal_tier/
isEventMedal to the wrong badge. Fixed: assertion + throw + 2 new tests
(commit f339c8a9). Re-review empirically tested all 597 single-removal
scenarios against real data: assertion catches 13% (75/597) -- found the
fix's own new comment overclaimed full coverage, dispatched a comment-only
correction (commit 831c6cd) which the reviewer's suggested replacement text
was used for directly, verified accurate against the same 597-trial data.
Also fixed in the same round: docs/ingestion-runbook.md's 4 stale spots
(missing sqlite step, wrong --check description, dead ingest:build reference,
undocumented --skip-sqlite) -- Task 7's "verify, don't rewrite" pass had
missed these since two LATER tasks (5, 6) touched adjacent behavior after
Task 7 ran; gap-detection.ts's stale CSV-pipeline reference text, which
ships directly into the user-facing Coverage Report via reference-gaps.json.
Minor findings logged, not fixed (owner already reasonably deferred, per
reviewer's own recommendation): gap-detection.ts's new Shadow-availability
note is conservative-direction-but-inaccurate for the 104/624 region-form
cases with a real per-form GAME_MASTER lookup -- correcting requires another
full ingest run to keep the manifest/version-hash/gaps mutually consistent,
not worth doing just for this wording nit right now.
Also from the whole-branch review, disclosed-and-accepted (owner-directed,
not defects): friendship XP values, 24 vs 10 PvP ranks, item-name diacritic
loss, +13 gender-union form rows, 111/399 unrecovered medal_tier rows --
all already logged in Tasks 3/4's entries above, re-confirmed still correctly
excluded from this review's findings.

ALL 7 TASKS + the final whole-branch review + both fix rounds are complete
and independently reviewed clean. READY TO MERGE per the final re-review's
verdict.
