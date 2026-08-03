# `reference.json` as a Lowest-Trust Shim Source, Plus a Standalone Badge Identity Fix — Design

> **For agentic workers:** this spec is the source of truth for what to build. It
> supersedes the paused `docs/superpowers/plans/2026-08-02-data-parity-paranoid-check.md`
> as the project's active direction — see that plan's ledger for why it's paused
> (a critical classification bug, C1, not yet fixed) rather than abandoned.

## Background and motivation

The `--test-paranoid` data-parity effort stalled on a hard problem: comparing
GoRefs' raw *source-side* field paths against *target-side* canonical/claim
names requires reconstructing every template's coordinate transform
(`unwrap_path`, renames) — a real redesign, not a quick fix (see that plan's
ledger, finding C1).

A separate, already-completed investigation
(`.superpowers/sdd/2026-07-30-generic-ingestion-engine/reference-json-coverage-report.md`)
took a different approach: compare GoRefs' **canonical output**
(`GoRefs_Master.duckdb`) against GoBuddy's **canonical output**
(`src/data/reference.json`) — target-vs-target, no coordinate-space problem at
all. That report already produced a real, prioritized gap list via manual
spot-checking.

The project owner's new idea: stop manually diffing, and instead **ingest a
copy of `reference.json` through GoRefs' existing generic engine** as an
actual new source, at the **lowest trust priority** in the system. This
reuses the already-built template/claims/trust-resolution machinery instead
of new one-off comparison tooling, and the "lowest priority" placement gives
the exact safety property the owner asked for: it can only fill gaps in
canonical/claims data, never override a real primary source, and is
automatically superseded the moment any gap it fills gets properly modeled
from primary data later. This is a **shim** — deliberately temporary,
explicitly distrusted (`reference.json` can itself go stale), not a new
permanent primary source.

While investigating the badge domain for this shim (see below), a
**separate, independent, real bug** was found and is not blocked on any of
the above: `src/builder.py`'s badge identity computation was believed (per
`KNOWN_ISSUES.md` #3) to be silently dropping 382 of 597 badge records. A
fresh read of the current code and a live query against
`output/GoRefs_Master.duckdb` (`select count(*) from badges` → 597;
`select count(distinct badge_id) from badges` → 184) shows **no rows are
actually lost** — all 597 raw records are present in the table — but the
`badge_id` column is not a unique key as its name implies, which breaks any
future consumer that treats it as one (e.g. per-trainer badge-completion
tracking, joins). `KNOWN_ISSUES.md`'s own investigation already found the
fix: switching identity to `(name, description)` yields 537 distinct values
from 597 rows (the remaining 60-row gap is exact byte-for-byte duplicate
raw records in `pogoapi_net`'s own data, which should dedupe, not need a
third key). This is fixed as Task 1, independent of and before the shim
work, since it's small, well-understood, and already-scoped.

## Real reference.json structure (verified directly, not assumed)

Read directly from `/home/nick/Repos/GoBuddy/src/data/reference.json`
(25 top-level arrays). Confirmed shapes for every domain this plan touches:

```json
// species (1024 rows) -- dexNumber is a clean, already-used-by-GoRefs key
{"slug": "bulbasaur", "dexNumber": 1, "name": "Bulbasaur", "familySlug": "bulbasaur",
 "gen": 1, "rarity": "standard", "regionSlug": "kanto", "hasMale": true,
 "hasFemale": true, "canMegaEvolve": false, "canGigantamax": false}

// forms (2716 rows) -- one row per form PER GENDER (known GoRefs granularity
// mismatch, not a gap -- see coverage report)
{"slug": "bulbasaur-standard-male", "speciesSlug": "bulbasaur", "formName": "Standard",
 "costumeName": null, "gender": "male", "evolves": true, "shinyAvailable": true,
 "shinyReleasedAt": "2018-03-25", "shadowAvailable": true, "dynamaxAvailable": false,
 "regionalExclusive": false, "imageRef": null}

// medals (583 rows) -- slug is a clean slugify(name), verified 583/583 distinct,
// AND verified GO Fest variants (110 records containing "fest") are NOT bare-name
// duplicates in reference.json -- e.g. "Pokémon GO Fest", "Pokémon GO Fest—Early
// Access", "Pokémon GO Fest—Egg-thusiast", "Pokémon GO Fest: Berlin", "Pokémon GO
// Fest 2022" are genuinely distinct `name` strings. reference.json does not have
// GoRefs' collision -- its upstream badge names are already disambiguated.
{"slug": "triathlete", "name": "Triathlete",
 "description": "Achieve a seven-day Pokémon catch streak or PokéStop spin streak {0} times.",
 "isEventMedal": false}

// medalTiers (799 rows)
{"medalSlug": "triathlete", "rank": 1, "target": 1}

// formMoves (11131 rows) -- TOTAL canonical gap in GoRefs today
{"formSlug": "bulbasaur-standard-male", "moveSlug": "vine-whip-fast", "isElite": false}

// speciesEvolutions (479 rows) -- TOTAL canonical gap in GoRefs today
{"fromSpeciesSlug": "bulbasaur", "toSpeciesSlug": "ivysaur", "candyRequired": 25,
 "itemRequired": null}

// pvpRankRewards (240 rows) -- TOTAL gap, no raw or canonical equivalent found anywhere
{"leagueRank": 10, "track": "free", "sortOrder": 0, "rewardType": "stardust",
 "itemName": null, "amount": 3000}

// pvpRankRequirements (24 rows) -- canonical gap; close raw equivalent exists
// (gm_combatrankingprotosettings, 22 rows) but not investigated as a real match
{"rank": 1, "additionalBattlesRequired": null, "additionalBattleWinsRequired": null}

// playerLevelRewards (364 rows) -- TOTAL canonical gap (raw exists in gm_leveluprewards)
{"level": 2, "sortOrder": 0, "itemName": "Poke Ball", "amount": 10}

// backgrounds (2 rows) -- small, genuinely unrepresented concept in GoRefs
{"slug": "spring-2024", "name": "Spring 2024"}

// friendshipLevels (5 rows) -- GoRefs' raw data is actually AHEAD here (6 tiers vs 5);
// do not let this shim's 5 rows override or shadow GoRefs' 6th, newer tier
{"level": 0, "name": "Friend", "pointsRequired": 0, "xpReward": 1000, "attackBonus": 1,
 "tradingDiscount": 0, "raidBallBonus": 0}
```

GoRefs' current canonical schemas for the domains this shim will cross-check
(verified live against `output/GoRefs_Master.duckdb`):

```
species: dex_number, slug, name, gen, can_mega_evolve, can_gigantamax,
         buddy_distance_km, base_attack, base_defense, base_stamina,
         max_cp_lvl40, localized_names, types (VARCHAR[])
forms:   slug, species_slug, dex_number, form_name, costume_name,
         costume_display_name, gender, shiny_available, shiny_release_date,
         shadow_available, buddy_distance_km, base_attack, base_defense,
         base_stamina, max_cp_lvl40, image_url, shiny_image_url
moves:   move_id, name, type, is_fast, pve_power, pve_duration_ms,
         pve_energy_delta, pvp_power, pvp_energy_cost, pvp_cooldown_turns,
         stat_buffs
badges:  badge_id, name, is_event_badge, description, rank, targets
```

GoRefs' `species.slug` and `forms.slug` already use the same slug convention
as `reference.json` (e.g. `"bulbasaur"`) — this is the key fact that makes
species identity resolution clean. `forms.slug` differs only in the known,
already-documented gender-granularity mismatch (GoRefs collapses
male/female into one row; `reference.json` keeps them separate) — expect
partial, not exact, `forms` alignment, consistent with the coverage report.

## Scope of this plan

1. **Task 1 (standalone, no dependency on the rest):** fix `badge_id`
   identity in `src/builder.py` from `id-or-name` fallback to `(name,
   description)`, deduping the ~60 rows that are exact byte-for-byte
   duplicates. Closes `KNOWN_ISSUES.md` #3 with the fix that document
   already specifies.
2. **Task 2:** add a copy of `reference.json` as a new GoRefs source
   (`reference_json_shim`), reusing the existing local-file fetcher pattern
   (`local_authoring`), at the lowest priority in `TRUST_HIERARCHY` —
   strictly below `unverified_claim` (8), so it can never win a conflict
   against any existing source.
3. **Task 3:** write templates for the domains where GoRefs already has a
   canonical table and a clean shared key: `species` (by `dexNumber`),
   `medals` (by the fixed `(name, description)` identity, once Task 1
   lands), `typeEffectiveness`, `weatherBoosts`. These are cross-checks —
   the shim's claims will almost always lose to GoRefs' existing
   higher-priority claims, and that's the intended, tested behavior, not a
   bug to work around.
4. **Task 4:** model the total-canonical-gap domains as new tables, using
   `reference.json`'s already-validated shapes directly as the schema:
   `form_moves`, `species_evolutions`, `pvp_rank_rewards`,
   `pvp_rank_requirements`, `player_level_rewards`, `backgrounds`. Foreign
   keys resolve via slug matching against `species`/`forms`/`moves` where
   possible (see Task 4 for the exact resolution rule per table).
5. **Task 5:** build + verify. Confirm the shim only fills gaps (spot-check
   that `species.name` still comes from a higher-priority source, not the
   shim), confirm `--test` passes, and confirm `friendship_levels` does
   **not** regress to `reference.json`'s 5-tier data (GoRefs' 6-tier raw
   data is newer and must keep winning).

## Explicitly out of scope

- **`forms` full parity** (the gender-split granularity mismatch) — already
  understood as a modeling difference, not a gap; not touched here.
- **`friendship_levels`'s existing canonical-modeling bug** (NULL milestone,
  duplicate 90.0 rows) — a real, separate, already-documented defect
  (coverage report item 8); not fixed by this plan, only guarded against
  regression in Task 5.
- **Fixing the C1 classification bug in `--test-paranoid`** — that plan
  stays paused; this plan does not touch `src/paranoid_check.py`.
- **`moves` naming-convention cleanup** (`Lock On` vs `Lock-On`, the
  `Wildbold Storm` typo, duplicate move rows) — already catalogued in the
  coverage report as a small, separate follow-up; not addressed here beyond
  whatever the shim's cross-check naturally surfaces as `CLAIMS_ONLY` noise.
- **Any live/automatic sync of `reference.json`** — this is a one-time
  manual copy into GoRefs (`data-authoring/reference_json_shim/reference.json`
  or similar), refreshed by hand if/when the owner wants a newer snapshot.
  Not a cross-repo pipeline.

## Testing

Consistent with every prior cutover task in this project: TDD per task,
`uv run pytest tests/ -q` full-suite-green before each commit, and a real
`uv run go_refs.py --build` + `uv run go_refs.py --test` run (by the
implementer, since — unlike `--test-paranoid` — running the normal build
pipeline against real data has always been standard practice in this repo)
showing 0 unexpected gaps/regressions before Task 5 is considered done.
