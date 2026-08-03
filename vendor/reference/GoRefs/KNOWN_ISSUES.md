# Known issues in `src/builder.py` and `scripts/user_source_coverage_test.py`

Originally written 2026-07-30 after the first GoBuddy evaluation pass;
**revised 2026-07-30 (later same day)** after `0b437dd`/`e3abe82` landed a
round of fixes. Re-verified by re-running `uv run go_refs.py --build` fresh
(no cached shortcuts) and spot-checking the resulting
`output/GoRefs_Master.duckdb` and `output/source_coverage_report.md` against
the raw upstream JSON again — not just re-reading the code. No new automated
tests were written for this pass; this is manual verification only.

**Revised again 2026-08-02** after the `feat/generic-ingestion-engine-v2`
branch's Tasks 1-21 (plan: `docs/superpowers/plans/2026-07-30-generic-ingestion-engine.md`,
ledger: `.superpowers/sdd/2026-07-30-generic-ingestion-engine/progress.md`)
replaced `src/builder.py`'s hardcoded per-source parsing with a generic,
template-driven engine (`src/engine.py`, `src/profiler.py`) and rewrote the
`--test` suite. Re-verified independently: rebuilt with `uv run go_refs.py --build`,
queried `output/GoRefs_Master.duckdb` directly, and ran `uv run go_refs.py --test`
fresh — not just re-read the ledger's own claims.

## At a glance

| # | Issue | Domain | Status | Severity |
|---|---|---|---|---|
| 1 | `discrepancies` scope broadened, two gaps remain | claims ledger | Open | Medium — noise + partial namespace unification |
| 2 | `--test` suite rewritten, checkable scope still partial | test suite | Open | Medium — 80% of claims unverified by suite (not known-wrong) |
| 3 | `badge_id` collisions in legacy badge loop | badges | Open | High — 382 distinct badges silently merged |
| 4 | Cutover to generic engine (Task 22 update) | engine/architecture | Open (tracking note) | Informational |
| 5 | `local_authoring` costume curation incomplete (5/60 tokens) | forms | Open | Low — cosmetic, correctly nulls rather than guesses |
| — | `quests` table empty | quests | Not a bug | — |
| — | Doc generation suspicion (Task 24 audit) | tooling | Resolved/non-issue | — |

Jump to: [Fixed since the last pass](#fixed-since-the-last-pass) · [Still open](#still-open) · [Not a bug](#still-not-a-bug-quests-table-is-empty) · [Resolved/non-issues](#resolvednon-issues)

## Fixed since the last pass

| Item | Before | After | Notes |
|---|---|---|---|
| Costume forms (`forms.costume_name`) | 0 of 1,400 rows had a costume | 272 of 2,205 form rows populated | Confirmed by spot-checking Pikachu (dex 25) and others; fix correctly reads `assetForms` now. |
| `raid_bosses` | 0 rows | 17 rows | Correctly reflects the current raid rotation (`mega`, `lvl5`, `lvl3`, `lvl1`, `shadow_lvl5/3/1` all populated) with real `min_cp`/`max_cp`/`min_boosted_cp`/`max_boosted_cp`/`shiny_available` values. `currentList` unwrap and field remap (`id`→`pokemon_id`, `names.English`→`name`, `cpRange`/`cpRangeBoost`→cp columns, `shiny`→`shiny_available`) landed as suggested. |
| `badges.type` | Stringified `True`/`False`/`""` | Replaced with `is_event_badge BOOLEAN`, plus new `rank` and `targets` columns | Fields previously dropped entirely are now pulled through. Confirmed via spot check. |
| `max_battles` | 0 rows | Still 0 rows | **Correct, not a regression.** Same `currentList`-unwrap fix was applied here too. Checked raw snapshot directly: `raw_dumps/pokemon_go_api/*/maxbattles.json` is `{"currentList": []}` right now — upstream has no active Max Battle rotation. Re-check after a rotation goes live upstream. |
| Gender detection + 21-species duplicate-row bug (former "Still open #1") | `isFemale`-only check, exact-string slug equality for dedup | Fixed by construction in Task 20 (`3e4e808` + fix-round `4fd622e`) | `src/engine.py`'s `resolve_gender()` evaluates every signal in a template's `gender_signals` list (`isFemale`-style boolean, `(?i)female` match on `form`, `(?i)_female$` match on `regionForms` key) and treats any one firing as `"female"` — see `pokemon_go_api_pokedex.yml`. Dedup now happens on a normalized identity tuple (`normalize_form_identity()`: species dex + normalized form token + normalized costume token + gender). Re-verified against live build: Frillish (dex 592) now has exactly 2 form rows (`Standard`, `Frillish Female`), correctly tagged `gender = "female"`. Ledger's own review independently re-verified against a real pre/post baseline rebuild — see progress ledger Task 20. "Male" is still not a distinct value (`"unknown"` covers both "no split exists" and "is male") — explicitly out of scope, not fixed, not expected to change (no upstream signal positively asserts male). |

## Still open

### 1. `discrepancies` scope: no longer "base stats only," but two known gaps remain

The premise of the old "still only ever covers base stats" issue is gone:
`resolve_attribute_claim()` is no longer called from one hardcoded loop.
`GoRefsMasterEngine.resolve_all_claims()` (`src/builder.py`) now calls it
generically for every `(entity_id, attribute)` group in the claims ledger,
and every cut-over source (Tasks 6-21: species, forms, moves, badges, raid
bosses, shiny dates, and more) emits claims through `emit_claim()`. Verified
directly against a fresh build: `discrepancies` now holds **655 rows across
11 distinct attributes** (`base_attack`, `base_defense`, `base_stamina`,
`description`, `form`, `form_name`, `max_cp`, `mega_name`, `name`, `region`,
`xp_reward`) — not 3, and not just base stats.

Two caveats carried over from the ledger, still genuinely open:

| Caveat | Detail |
|---|---|
| **`form_name` noise** (Task 20 FLAG) | Roughly 239 of the 655 rows are `pokemon_go_api` disagreeing with itself (`regionForms`' humanized text vs `assetForms`' bare field for the same collapsed entity, both at equal priority) rather than a real cross-source conflict. The `discrepancies` table doesn't yet distinguish same-source-disagrees-with-itself noise from genuine cross-source disagreement. Suggested, not required, follow-up: tag or suppress same-source/same-priority rows separately. |
| **Partial cutover means partial namespace unification** (Task 18 FLAG, UPDATE from Task 22) | `alexelgt_game_masters` is now cut over (`game_master_pokemon_settings.yml`, entity_id_prefix: `pokemon_dex`), so its species-stat claims land on the same `pokemon_dex_<n>` entities as every other cut-over species source. This did **not** fully resolve the ~53 base-stat/badge-description disagreements this note originally predicted would reappear: `pogoapi_net`'s own species-stats claims (`pogoapi_net_pokemon_stats.yml`) still land under a separate `pogoapi_net_<pokemon_id>` namespace (Task 18's own structural gap, unrelated to `alexelgt_game_masters` and out of Task 22's scope), so the two sources still never collide in the ledger for base_attack/base_defense/base_stamina. What Task 22 **did** make newly visible: alexelgt's combat-move claims (type/pve_power/pve_energy_delta) now genuinely compete with `pogoapi_net`'s at the same `move_<numeric_id>` entities for the first time (they previously landed on a disjoint `move_<string_uniqueId>` entity nothing read back) — 572 new discrepancy rows (304 `pve_power`, 267 `pve_energy_delta`, 1 `type`) surfaced this way, fully accounting for the 655 → 1227 discrepancy-count jump this task produced (revised after a same-day fix round, `b17e064`, corrected a false-positive in the moves join — see the ledger's Task 22 entry). `alexelgt_game_masters` wins all of them per trust-tier precedence; `base_attack`/`base_defense`/`base_stamina`'s existing 61/60/21 discrepancy counts are unchanged pre/post Task 22 (verified) since they're `pogoapi_net` disagreeing with itself, not a cross-source conflict this task touches. |

### 2. `--test` / the source-coverage suite was rewritten, not patched — but its checkable scope is still partial

The tautological suite this section used to describe (the
`exp_table_exists` shortcut in the old `_test_source()`) no longer exists.
Task 9 replaced `scripts/user_source_coverage_test.py` with
`LedgerReplayTester`, a different implementation: it consumes the same
claims ledger the build itself produced, recomputes each `(entity_id,
attribute)` group's expected winner using the same trust-tier logic
`resolve_attribute_claim()` uses, and checks whether the canonical table
actually holds that value — real claim-vs-canonical verification, not "did a
raw exploration table get built." Ran it fresh (`uv run go_refs.py --test`)
against the current build; it now reports per-source `matched` / `overridden`
/ `collision` / `gaps` buckets instead of one flat coverage percentage:

| Source | Matched | Overridden | Collision | Gaps | Unmapped |
|---|---|---|---|---|---|
| alexelgt_game_masters | 5120 | 0 | 0 | 0 | 4418 |
| pogoapi_net           |    0 | 0 | 0 | 0 | 23490 |
| pokeapi               |    0 | 0 | 0 | 0 |  2050 |
| pokemon_go_api        | 5646 | 0 | 0 | 0 | 7353 |
| pvpoke                |    0 | 0 | 0 | 0 |   799 |
| rplus_shiny           |  681 | 0 | 0 | 0 |    0 |

Total gaps: 0 (unmapped/not-yet-checkable claims: 38110)

(Updated post-Task-22: `alexelgt_game_masters`'s matched count rose 3072 →
5120 as its species-stat claims started reaching `pokemon_dex_<n>`
canonical entities for the first time; `pogoapi_net`/`pokeapi`/`pvpoke`
still show 0 matched — unchanged, not a regression, see the note below.
Table and total above are Task 22's own `--test` transcript, the
authoritative record for the post-Task-22, pre-Task-23 state.)

**2026-08-02 doc-currency finding, not yet reconciled with the committed
build artifacts:** the table above doesn't match what's currently committed
in `output/source_coverage_report.md` / `output/GoRefs_Master.duckdb` at
`5ed1d69` — that commit's `_claims_ledger` has **no `pokeapi` rows at all**
(confirmed: `git show 5ed1d69:output/GoRefs_Master.duckdb`, queried
directly), even though `pokeapi` had 2050 claims as of Task 22's own commit
(`732f393`) and still did at `b17e064`. `pokeapi`'s claims disappeared
specifically during `5ed1d69`'s own rebuild — most likely because that
session's `raw_dumps/pokeapi/` snapshot wasn't present/fresh when `--build`
ran there (raw dumps are untracked; each session fetches its own). This
looks like a local-environment gap in that one rebuild, not a cutover
defect — but it means the *committed* database and report are currently
missing an entire source's data, silently. Re-running `--build` in an
environment with a fresh `pokeapi` raw dump present, once no other
in-progress code changes are sitting uncommitted (Task 23 was mid-flight
in this checkout as of this pass — its own rebuild will supersede this
either way), should restore `pokeapi` and should be verified against the
38110 total above before trusting the committed report again.

**One thing to not over-read from this:** the `Unmapped` column (38,110 of
49,557 total claims in this run) is not verified — it's an explicit
"not yet checkable" bucket, not a pass. `_find_canonical_value()`
(`scripts/user_source_coverage_test.py`) currently only knows how to look up
two entity-ID prefixes: `pokemon_dex_*` (species/forms) and `badge_*`
(badges). Every other domain's claims — moves, pvp_leagues, raid_bosses,
max_battles, quests, and any source whose `entity_id_prefix` doesn't map to
one of those two tables — fall into `Unmapped` and are not checked by this
suite at all yet, including `pvpoke`'s claims (0 matched, 799 unmapped) even
though Task 19's ledger entry independently traced a `pvpoke` claim reaching
canonical output end-to-end (`pvpoke_TACKLE` → `move_221`). "0 gaps" is a
real, meaningful result for the domains the suite can currently see; it is
not evidence that the other ~80% of claims in this run are correct, only
that they haven't been checked yet by this particular suite. Extending
`_find_canonical_value()` to cover more prefixes as more domains stabilize
would be a reasonable follow-up, not a defect in what's there today.

### 3. `badge_id` collisions in the legacy badge-building loop

(2026-08-02 pass, newly documented here — flagged twice in the ledger,
Tasks 9 and 18, but not previously written up in this file. Expanded
2026-08-02 with a full investigation so this can be worked without opening
any raw JSON — see "Full data for investigation" below.)

**The bug:** `src/builder.py:1138` derives the canonical `badge_id` as
`str(item.get("id") or item.get("name"))`. `pogoapi_net`'s raw badge
records have **no `id` field at all**, so every badge's identity falls back
to its bare `name` — and many real, distinct badges share a `name`,
differing only in `description` (city/date/tier). Net effect: 597 raw
badge records collapse to only **184 unique `badge_id` values** in the
canonical `badges` table — 382 distinct badges silently absorbed into
shared rows, keeping only whichever record's fields happened to win.

**Scale of the collision, worst offenders:**

| Badge name | Real distinct records | Collapse to |
|---|---|---|
| "Pokémon GO Fest" | 30 (Chicago 2017; Chicago 2018 North/South; Chicago 2019 North/South ×4 days; Yokohama 2019 ×8 days; Dortmund 2019 ×5 days; Global 2020; Global 2021 — all sharing the bare name) | 1 row |
| "Pikachu's Indonesia Journey" | 9 (Bali/Surabaya/Yogyakarta ×3 dates each) | 1 row |
| "Pokémon Air Adventures" | 4 (Jeju Island, 3 specific dates) | 1 row |
| 57 colliding `name` keys total | 470 of 597 raw records absorbed | — |

**The fix that mostly works:** switching the identity key from `name` alone
to `(name, description)` resolves 558 of 597 records cleanly — 537 unique
pairs. The remaining 39 groups (99 records) are **exact byte-for-byte
duplicate raw records** (identical `name`, `description`, `rank`, and
`targets`, e.g. two literally identical `"Pokémon GO Fest—Egg-thusiast" /
"Berlin, July 1–3, 2022"` entries) — i.e. real upstream duplication in
`pogoapi_net`'s own data, which should just dedupe away, not need a third
identity field.

**A possibly-better source exists and is worth checking before patching
`pogoapi_net`'s identity:** `alexelgt_game_masters`'s raw `GAME_MASTER.json`
has **1004 badge templates**, each with a genuinely stable, unique
`templateId` that already distinguishes every real variant pogoapi_net's
`name` collapses — e.g. `BADGE_GOFEST_2019_AMERICAS_DAY_00_NORTH_EARLYACCESS`
vs `BADGE_GOFEST_2019_AMERICAS_DAY_00_NORTH_GENERAL` are two separate,
correctly-distinct templates. GAME_MASTER does *not* carry human-readable
localized name/description text or images, though — those still live in
`pogoapi_net`'s data. A real fix might mean GAME_MASTER's `templateId`
becomes the canonical identity, with `pogoapi_net`'s name/description/image
fields joined on as enrichment — bigger than the `(name, description)`
patch above, but fixes the identity problem at its actual root (missing a
stable id) rather than working around it with a compound string key.

**Full data for investigation (no raw JSON needed):**

Canonical `badges` table schema (`output/GoRefs_Master.duckdb`):

| column_name | column_type | notes |
|---|---|---|
| badge_id | VARCHAR | currently id-or-name fallback, see above |
| name | VARCHAR | |
| is_event_badge | BOOLEAN | always populated, from pogoapi_net's `event_badge` |
| description | VARCHAR | |
| rank | BIGINT | |
| targets | VARCHAR | populated on only ~72 of 597 raw records (sparse) |

`pogoapi_net`'s raw `badges.json` record shape (all 597 records have
exactly these 5 keys — no `id` field exists in this source at all):
```json
{"name": "Triathlete", "description": "Achieve a seven-day Pokémon catch streak or PokéStop spin streak {0} times.", "rank": 5, "targets": [1, 10, 50, 100], "event_badge": false}
```

`alexelgt_game_masters`'s raw badge template shape (1004 templates, each
under `data.badgeSettings`; note the stable `badgeType`/`templateId`):
```json
{"templateId": "BADGE_GOFEST_2019_AMERICAS_DAY_00_NORTH_EARLYACCESS", "data": {"badgeSettings": {"badgeType": "BADGE_GOFEST_2019_AMERICAS_DAY_00_NORTH_EARLYACCESS", "badgeRank": 2, "targets": [100], "eventBadge": true}}}
```

Concrete collision example (before any fix — as currently stored in the
raw dump, all 4 records collapse to 1 canonical row today):

| name | id | description |
|---|---|---|
| Pokémon Air Adventures | None | Jeju Island, 2023 |
| Pokémon Air Adventures | None | Jeju Island, July 28, 2023 |
| Pokémon Air Adventures | None | Jeju Island, July 29, 2023 |
| Pokémon Air Adventures | None | Jeju Island, July 30, 2023 |

Concrete true-duplicate example (still colliding even under `(name,
description)`, both records are identical):

| name | description | rank | targets | event_badge |
|---|---|---|---|---|
| Pokémon GO Fest—Egg-thusiast | Berlin, July 1–3, 2022 | 2 | None | True |
| Pokémon GO Fest—Egg-thusiast | Berlin, July 1–3, 2022 | 2 | None | True |

Both review passes that originally found this treated it as an accepted,
deferred design boundary (out of scope for the tasks that found it), not
something to fix incidentally — but it's a real, confirmed defect. This is
also a prerequisite for any future per-trainer badge-completion tracking
(e.g. distinguishing which specific GO Fest city/day a trainer actually
attended), and for the separate, still-open question of how to classify
"event badges" a trainer shouldn't be penalized for missing (see the
`is_event_badge` discussion in this project's chat history / TODO.md) —
that classification is only meaningful once each real badge has its own
row.

### 4. Cutover to the generic engine (UPDATE from Task 22)

All 6 sources -- `pokeapi`, `pogoapi_net`, `pvpoke`, `pokemon_go_api`,
`rplus_shiny`, and now `alexelgt_game_masters` (Tasks 17-22) -- are cut over
to `engine.run_source()`/`engine.extract_transformed_records()`, driven by
`config/source_templates/*.yml`. `GameMasterFetcher.extract_structured_
claims()`, the last hand-written per-template-type parser, is deleted
entirely (`src/fetchers/game_master.py` now only retains `fetch()`).
`local_authoring` (`config/sources.yml`, `TRUST_HIERARCHY` priority 1 --
the 7th configured source) is the one still not templated; it remains
un-cut-over pending Task 23.

Two domains remain deliberately hand-built rather than templated, both a
considered design choice, not leftover legacy code:

| Domain | Why hand-built |
|---|---|
| `game_master_templates` (`raw_templates`) | A full-fidelity raw JSON passthrough of all ~18,479 GAME_MASTER records. Selective field_mappings templating is the wrong tool for "preserve everything verbatim" — same reasoning Task 18 applied to `badges`. |
| `badges` | Unchanged from Task 18/9's finding (see "Still open #3" above), id-or-name fallback collision, not touched by this pass. |

`progression`'s primary+fallback mechanism (GAME_MASTER's `playerLevel.
cpMultiplier`, falling back to `pogoapi_net`'s raw `cp_multiplier` dump if
empty) is preserved, though verified currently unexercised -- GAME_MASTER's
80-level array has been populated in every real snapshot checked.

### 5. `local_authoring`'s costume display-name curation is incomplete (low priority)

(2026-08-02, Task 23.) `data-authoring/costume-lookup.json` — the
hand-curated lookup mapping raw costume tokens (e.g.
`FASHION_2021_NOEVOLVE`) to human-readable display names (e.g.
`"Fashionable costume"`) — has 62 entries, but only 55 of the 60 real
costume tokens that actually appear in `pokemon_go_api`'s data have a
non-empty curated name. The 5 uncurated tokens (`ANNIVERSARY_2024`,
`COSTUME_1`, `COSTUME_2`, `FALL_2018`, `FALL_2022`) correctly show
`forms.costume_display_name = NULL` rather than a spurious value — this is
not a bug in the pipeline, just an incomplete curation list. Someone needs
to fill in the 5 missing entries in `data-authoring/costume-lookup.json`
by hand whenever there's time; not high priority. See also `TODO.md`'s note
connecting the never-created `community-submissions.json` (same source,
`local_authoring`) to the still-unscoped "flag ambiguous/missing data" idea
— filling in curation gaps like this one is exactly the kind of thing that
idea would eventually help with.

### 6. `pvpRankRewards`/`pvpRankRequirements` are NOT a total gap — the earlier coverage report's search was incomplete

(2026-08-03.) The 2026-08-02 reference.json coverage report
(`.superpowers/sdd/2026-07-30-generic-ingestion-engine/reference-json-coverage-report.md`)
concluded `pvpRankRewards` (240 rows) was a **total gap** — "searched all
`gm_*` tables for reward-shaped columns; found nothing PVP-rank-specific."
That search only checked `gm_combatrankingprotosettings` and missed the
real source entirely: checking GoBuddy's own ingestion pipeline directly
(`scripts/ingest/transform/pvp.ts` in the GoBuddy repo) shows it sources
both `pvpRankRewards` and `pvpRankRequirements` from GAME_MASTER's
**`vsSeekerLoot`** and **`combatRankingProtoSettings`** template categories
— accessed through an untyped escape hatch since GoBuddy never built a
typed getter for either. `alexelgt_game_masters` already ingests every
GAME_MASTER record wholesale into `game_master_templates`, so this data is
already sitting in GoRefs today, just never surfaced via a dedicated
template. Re-check `game_master_templates` for `templateId` values matching
`vsSeekerLoot` and `combatRankingProtoSettings` before writing any new
ingestion for this domain — it needs a template, not a new upstream source.

By contrast, `backgrounds` (2 rows) really is a genuine total gap, verified
directly against GoBuddy's `scripts/ingest/ingest.ts`: it's hardcoded
in-script (`backgrounds: [{ slug: "spring-2024", ... }, { slug:
"anniversary-2016", ... }]`), not derived from any upstream source at all.
Don't assume every remaining `reference.json` gap has a hidden raw source
the way `pvpRankRewards` did — check case by case.

## Still not a bug: `quests` table is empty

Unchanged — `pokemon_go_api/quests.json` is still `[]` in the current fetch.
Correct reflection of an empty upstream, nothing to fix here.

## Resolved/non-issues

### Doc generation was verified at runtime (2026-08-02, Task 24 post-cutover audit)

The design spec for the generic-ingestion-engine cutover carried an open
suspicion that `scripts/generate_docs.py` might not correctly render the
new public functions/classes added across Tasks 1-23 (`engine.py`'s
`run_source`, `apply_transform`, `resolve_gender`, `normalize_form_identity`;
`profiler.py`'s `SourceProfiler`, `detect_shape`, and friends) — e.g. a
docstring format the parser doesn't handle, or a module silently skipped.

Ran `uv run python3 scripts/generate_docs.py` standalone and read the actual
generated output (`docs/api_reference.md`, `docs/api_reference.html`), not
just the module-count summary line. Confirmed: all 19 discovered modules are
documented; every Task 1-23 function/class listed above appears with its
full multi-paragraph docstring (including `Args:`/`Returns:` blocks)
rendered correctly under its signature heading; the generated HTML's
sidebar nav links to every function/class. No discrepancy found — closing
this suspicion rather than leaving it open. (Per the Task 24 brief, no test
was added since there was no bug to reproduce.)
