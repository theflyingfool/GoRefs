# Task 1 report: sources/game-master.ts indexed parser

## What was implemented

`scripts/ingest/sources/game-master.ts` exports `createGameMasterIndex(raw: unknown[]): GameMasterIndex`.

- Builds a primary `Map<string, unknown[]>` keyed by each entry's `data`
  object's own key (excluding `data.templateId`) — never by the entry's
  outer `templateId`.
- For each of the 12 required categories, builds a secondary
  `Map<string, Record>` keyed by that category's actual natural id field
  (see table below), via a shared `indexByKey` helper.
- First-seen wins on a duplicate natural key. If the discarded record is
  content-identical to the kept one (compared with `templateId` excluded,
  since every record's `templateId` is unique by construction) it's dropped
  silently; otherwise `console.warn` logs the conflict — mirrors
  `build-reference.ts`'s `species_evolution` conflict-handling pattern
  (keep first, warn only on genuine divergence).
- Every typed getter is an O(1) `Map.get`, never a re-scan.
- Each category also exposes an `allX()` accessor returning the full
  bucketed array. This wasn't explicitly requested by the brief, but later
  tasks need to *enumerate* e.g. all 2466 pokemonSettings records to build
  the species/form list — a point-lookup getter alone can't do that.
  Flagged here rather than silently added, per the task's "ask when
  unsure" guidance; the advisor concurred this is a genuine gap the brief
  left underspecified, not overbuilding.
- `getPlayerLevelSettings()` is a no-op-key singleton getter (GAME_MASTER
  carries exactly one `playerLevel` record) returning the raw settings
  object (`requiredExperience[]`, `cpMultiplier[]`, etc.) unexploded —
  turning the parallel arrays into per-level `PlayerLevel` rows is
  explicitly left to a later transform task.
- `categoryEntries(category: string): unknown[]` is an untyped escape
  hatch for any category not in the required list.

### Deviations from the brief's guessed key fields (confirmed against real data, not assumed)

1. **genderSettings**: the brief guessed `pokemonId`+`form`. Real records
   only carry a `pokemon` field (no `form` field at all), and it is **not**
   unique — e.g. Frillish has a male-only base record
   (`SPAWN_V0592_POKEMON_FRILLISH`, `malePercent: 1`) and a separately
   declared 100%-female record (`SPAWN_V0592_POKEMON_FRILLISH_FEMALE`,
   `femalePercent: 1`), both with `pokemon: "FRILLISH"`. Keying by
   `pokemon` alone collapses 2469 records down to 1025 and silently drops
   the female Frillish record (and 7 other species' costume-specific
   ratios: Pikachu, Jellicent, Pyroar, Meowstic, plus Pikachu's many
   single-gender costume variants). Deciding which ratio represents "the
   species" for the `hasMale`/`hasFemale` columns is a transform-layer
   call, not this index's — so `genderSettings` is keyed by `templateId`
   (verified unique across all 2469 real records), `allGenderSettings()`
   preserves every record, and `genderSettingsFor(pokemon: string)` is a
   convenience lookup returning an **array**, plural, on purpose.
2. **friendshipMilestoneSettings**: no numeric level/tier field exists in
   the data payload itself (`FRIENDSHIP_LEVEL_2`'s data has no `level: 2`
   field) — keyed by `templateId`.
3. **combatLeague**: `title` looks like a natural key but isn't one — it's
   a shared display string (74 unique titles across 110 records; e.g.
   `combat_great_league` is reused by both the live Great League and its
   NPC-only variant `COMBAT_LEAGUE_DEFAULT_MASTER_NPC`). Keyed by
   `templateId`.

All other categories' guessed key fields were confirmed correct
(`pokemonId`+`form` for pokemonSettings, `pokemon` for formSettings,
`movementId` for moveSettings, `uniqueId` for combatMove, `attackType` for
typeEffective, `weatherCondition` for weatherAffinities, `level` for
levelUpRewards, `badgeType` for badgeSettings).

## What was tested and results

`test/game-master-index.test.ts` (node:test, matching `test/reference-sync.test.ts`'s
style and this repo's `npm test` runner):

1. Category bucketing keys by the `data` object's own key, not `templateId`
   — including a same-value-different-category case (`WRAP` as both a
   `moveSettings.movementId` and a `combatMove.uniqueId`, with different
   `power`) proving the two never merge.
2. Entries with no `data` object are ignored, not thrown on.
3. Per-category natural-key lookups for all 12 required categories
   (`getPokemonSettings` with and without `form`, `getFormSettings`,
   `getMoveSettings`, `getCombatMove`, `getTypeEffective`,
   `getWeatherAffinity`, `getPlayerLevelSettings`, `getLevelUpRewards`,
   `getBadgeSettings`, `getFriendshipMilestoneSettings`,
   `getCombatLeague`).
4. genderSettings keys by `templateId`, not `pokemon`, using a synthetic
   Frillish-modeled fixture — both records survive, both are individually
   reachable, `genderSettingsFor` returns both.
5. Synthetic duplicate-key conflict (modeled on the real
   `AWARDS_LEVEL_10`/`BACKFILL_AWARDS_LEVEL_10` pair): first-seen wins,
   exactly one `console.warn` fires, message matches expected format.
6. Synthetic duplicate-key with **identical** content: silently deduped,
   zero warnings.
7. Real-data smoke test against `docs/drafts/GAME_MASTER.json`, guarded
   by `existsSync` (skipped if the file isn't present — it's an untracked
   scratch file, not something every checkout has). Asserts category
   sizes are in the right ballpark and spot-checks two known real records.

Result: `npx tsx --test test/game-master-index.test.ts` → **7/7 pass**.
Full suite `npm test` → **127/127 pass** (all pre-existing tests still
green). `npx tsc -b` → clean. `npx eslint scripts/ingest/sources/game-master.ts
test/game-master-index.test.ts` → clean (and `git commit`'s pre-commit
hook re-ran full lint successfully).

## Files changed

- `scripts/ingest/sources/game-master.ts` (new)
- `test/game-master-index.test.ts` (new)

Not committed: `docs/drafts/GAME_MASTER.json` — this worktree didn't have
it (untracked files aren't shared across git worktrees), so it was copied
in locally from the main checkout purely for exploration/local test runs.
Left untracked deliberately, per the brief's characterization of it as
scratch data and the advisor's explicit flag not to commit an 18.8MB file
into source control. The real-data test skips gracefully if it's absent.

## Self-review findings

- Initial version of the "identical duplicate → silent dedup" check
  compared full records including `templateId`, which is unique per
  record by construction — so it never actually matched and the "silent"
  branch was unreachable. Fixed by excluding `templateId` from the
  equality comparison. Caught by the dedicated test for that case (test 6
  above), not just by inspection.
- Advisor review (before writing code) flagged that keying genderSettings
  by `pokemon` (the brief's implied approach, extrapolating from
  pokemonSettings) would silently destroy real data — verified against
  actual GAME_MASTER records and changed to key by `templateId` as
  described above, before any code was written against the wrong key.
- Advisor also flagged not committing the 18.7MB `GAME_MASTER.json` copy
  and keeping the required synthetic-fixture test cases independent of
  it — both applied.

## Exact category-name strings and natural-key fields (for later tasks)

Confirmed against `docs/drafts/GAME_MASTER.json` (18,672 entries):

| Category (exact string) | Count | Natural key field(s) | Notes |
|---|---|---|---|
| `pokemonSettings` | 2466 | `pokemonId` + `form` (form optional) | `form` absent on single-form species; key is `pokemonId` alone in that case. |
| `formSettings` | 1025 | `pokemon` | One row per species listing its `forms[]`. |
| `genderSettings` | 2469 | `templateId` (NOT `pokemon`) | `pokemon` is not unique — see deviation #1 above. `genderSettingsFor(pokemon)` returns all matching records. |
| `moveSettings` | 390 | `movementId` | |
| `combatMove` | 324 | `uniqueId` | Note: `uniqueId` values overlap with `moveSettings.movementId` values (e.g. `WRAP`) but are separate categories/maps — never merge. |
| `typeEffective` | 18 | `attackType` | |
| `weatherAffinities` | 7 | `weatherCondition` | |
| `playerLevel` | 1 | n/a (singleton) | `requiredExperience.length === cpMultiplier.length === 80` — the real dump publishes the **full level-1-80 curve**, not a truncated one. `PlayerLevel.cumulativeXp`'s doc comment ("null for levels beyond what any ingestion source publishes (currently 51-80)") is stale relative to this source; Task 2 should confirm whether to update it. Array index 0 = level 1. |
| `levelUpRewards` | 97 (79 unique levels) | `level` | 18 levels have a real `AWARDS_LEVEL_N` vs `BACKFILL_AWARDS_LEVEL_N` conflict (backfill record has a strict subset of items/lower counts) — first-seen (`AWARDS_LEVEL_N`, which appears earlier in the raw array) wins, warns logged. |
| `badgeSettings` | 997 | `badgeType` | |
| `friendshipMilestoneSettings` | 6 | `templateId` (NOT a numeric field — none exists in the data payload) | |
| `combatLeague` | 110 (74 unique titles) | `templateId` (NOT `title`) | `title` is a shared display string, not unique — see deviation #3 above. |

Every entry's `data` object has exactly one key besides `data.templateId`
(verified: 0 of 18,672 entries have zero or multiple non-templateId keys),
so the "category = the one other key" assumption in the brief holds for
the whole real dataset, not just the required categories.
