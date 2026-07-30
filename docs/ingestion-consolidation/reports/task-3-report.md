# Task 3 report: transform/*.ts — ported and re-sourced build logic

Commit: `ec966176` on `worktree-ingest-consolidation`.

## What was implemented

Five pure-function transform modules under `scripts/ingest/transform/`
(typed source data in, typed rows out — no file I/O, no module-level mutable
state, no `[]` raid/Community-Day building anywhere):

| Module | Replaces in `build-reference.ts` |
|---|---|
| `species.ts` | the whole inline `main()` species/form/formType/megaVariant block, `spriteManifest`, `cleanSpeciesDisplayName`, `slugFor`, `formTokenFromFormId`, `deriveRarity`, `gendersFor`, `megaVariantKindFromId`, `familySlugFor`/`parentDexOf`, the form dedup pass, `buildComparativeGaps` + `KNOWN_MISSING_SPECIES_DEX` / `KNOWN_GIGANTAMAX_MISMATCH_DEX` / `FAMILY_ROOT_GAP_NOTES` / `GEN_TO_REGION` |
| `moves.ts` | `buildMoves`, `buildFormMoves`, `buildTypeEffectivenessAndWeather` |
| `evolutions.ts` | `buildSpeciesEvolutions` |
| `player-progression.ts` | `buildPlayerProgression`, `MAX_TRAINER_LEVEL` |
| `pvp.ts` | `buildPvp` |
| *(nothing)* | `buildRaidsAndEvents` — dropped entirely, as specified |

`build-reference.ts` was not modified or deleted. No 6th transform module
was created. Type-effectiveness/weather live in `moves.ts` deliberately
(same domain as a move's type and power; the plan's module list has no types
module and inventing one was out of scope) — flagging that placement
explicitly so it doesn't read as an accident.

### Exports Task 4 needs by name

- `species.ts`: `buildSpecies({ pokedex, gameMaster, shinySheet }) -> { species, forms, formTypes, megaVariants, spriteManifest, gigantamaxSpeciesCount, duplicateFormsDropped }`, plus `buildComparativeGaps(candidate, FAMILY_ROOT_GAP_NOTES)`, `FAMILY_ROOT_GAP_NOTES`, `GEN_TO_REGION`, `KNOWN_MISSING_SPECIES_DEX`, `KNOWN_GIGANTAMAX_MISMATCH_DEX`, `createShinyLookup`, `slugFor`, `gendersFor`, `gendersForSpecies`, `deriveRarity`, `cleanSpeciesDisplayName`, `formTokenFromFormId`, type `FormWithShinyDebut`.
  `spriteManifest` is **returned**, not module state — `write/sprite-manifest.ts` consumes it.
- `moves.ts`: `buildMoves(gameMaster, pokedex) -> { moves, slugByMovementId }`, `buildFormMoves(gameMaster, pokedex, forms, slugByMovementId)`, `buildTypeEffectivenessAndWeather(gameMaster)`, `titleCaseEnumToken`.
- `evolutions.ts`: `buildSpeciesEvolutions(pokedex, species)`.
- `player-progression.ts`: `buildPlayerProgression(gameMaster)`.
- `pvp.ts`: `buildPvp(gameMaster)`.

`test/transform-reference-data.test.ts` assembles a complete
`ReferenceData` from these exports exactly the way the orchestrator should —
usable as a template for Task 4. Note that `regions`, `types` and
`backgrounds` are **not** transform outputs: the orchestrator builds
`regions` from `GEN_TO_REGION`, `types` from the union of every type slug
referenced by formTypes/moves/typeEffectiveness/weatherBoosts (or a Tier-1
FK dangles), and `backgrounds` is the two-row literal
(`spring-2024`, `anniversary-2016`) from `build-reference.ts`'s tail — the
template test carries all three verbatim.

## The intermediate shiny type (Task 5 needs this verbatim)

```ts
export interface FormWithShinyDebut extends Form {
  /** ISO date (YYYY-MM-DD) the shiny form was released, or null if never released. */
  shinyReleasedAt: string | null;
}
```

`buildSpecies` returns `forms: FormWithShinyDebut[]`. `shinyAvailable` is
**derived** (`shinyReleasedAt !== null`) at every construction site, never
set independently, so the two can't disagree — a test pins that invariant.
Task 5 should add the `shinyReleasedAt` column and stop dropping the field;
no transform change is needed to populate it.

## Business rules preserved (per module)

**species.ts** — every rule from the original, verbatim in intent:
1. Baby-Pokémon family-root exclusion (16-dex `BABY_PRECURSOR_DEX` set, same
   list, same "skip as a parent" placement).
2. Family grouping matches on `id`, not `formId` (Gloom -> `VILEPLUME_NORMAL`
   case), walks `regionForms` for edges declared only there (Deerling,
   Galarian Zigzagoon -> Obstagoon), and cycle-guards the parent walk.
3. Nidoran♀/♂ display-name cleanup (`(F)`/`(M)`), and the "these are two
   species, not a gender split, so no `formId===id` filter" rule.
4. Hitmontop / Shedinja / Wyrdeer / Kleavor / Archaludon family-root gap
   notes, unchanged text, still emitted through `buildComparativeGaps`.
5. `KNOWN_MISSING_SPECIES_DEX` (Basculegion) and the 17-entry
   `KNOWN_GIGANTAMAX_MISMATCH_DEX`, with the "hardcoded, not diffed against
   HEAD" rationale.
6. Standard forms one per gender, preferring the gender-specific
   `assetForms` art over the species icon.
7. Costume forms from `assetForms[]` only when `costume` is set; gender from
   `isFemale`; genderless -> `"unknown"`, never mislabeled male;
   `evolves: false`.
8. Region forms as Form rows under the parent species, `regionalExclusive:
   true`, with the "strip the base name, else title-case the token"
   display-label fallback (Paldean Wooper).
9. Gigantamax forms synthesized per gender, `dynamaxAvailable: true`,
   gated on `hasGigantamaxEvolution`.
10. Mega variants from `megaEvolutions` keys with X/Y/Primal detection.
11. Duplicate-form-slug dedup keeping first occurrence (Darmanitan
    `DARMANITAN_STANDARD` collision), with the dropped count reported.
12. Form types approximated as "every form shares the species' base types",
    **including** the pre-existing quirk that a region form's types
    overwrite the species' under the same key. Preserved deliberately, not
    "fixed" — see Concerns.
13. `deriveRarity` mapping, `GEN_TO_REGION` mapping and the
    `"unidentified"` fallback.

**moves.ts**
1. Move-slug collision handling: `slugify("<name>-<category>")`, later
   collisions get the move id appended so no record is silently dropped.
   Kept even though GAME_MASTER's `movementId` is unique and it never fires
   today — the invariant it protects (slug is a PK) is unchanged. A test
   forces a collision.
2. `buildFormMoves` stays narrow: base (`_NORMAL`, falling back to the
   no-form record) move pool applied to **Standard forms only**, elite
   moves flagged `isElite: true`. GAME_MASTER *could* now feed region forms
   too (its form tokens map cleanly onto our form slugs, unlike the old
   source — which is what that comment's stated reason was); deliberately
   not widened, noted in-code as a follow-up.
3. Type effectiveness and weather boosts emitted as full cross-products,
   weather stored as the display string ("Partly Cloudy").

**evolutions.ts** — species-level PK dedup by `"from|to"`; item-completeness
preference when candy agrees; `console.warn` (not a silent pick) on a
genuine candy-cost conflict, same message shape; skip edges whose target
isn't in the candidate species set.

**player-progression.ts** — `MAX_TRAINER_LEVEL = 80` kept, its comment
rewritten per the brief to say GAME_MASTER's `playerLevel` template now
backs the owner-confirmed value; levels not covered by the curve still get a
`cumulativeXp: null` row so `player_progress_personal.current_level`'s FK
target exists; rewards past the cap skipped; per-level **running**
`sortOrder` counter (not per-record indices); medals collapsed first-seen
per slug with the same event-badge tier collapse and comment.

**pvp.ts** — genuinely-empty reward slots skipped without shifting the
remaining slot indices; `(rank, track, sortOrder)` PK uniqueness preserved.

## Re-sourcing decisions and their evidence

- **Shiny**: sheet `debut` non-empty = released. A row with a **blank**
  `debut` is a deliberate "tracked, not released" statement and blocks any
  fallback. Lookups are case-normalized (pgapi `May_2023` vs sheet
  `MAY_2023`) and try both the stripped and full form-id spellings
  (`pm19.fALOLA` vs `pm201.fUNOWN_G`). Standard forms use the species-level
  answer (base `pm{dex}` row, else earliest date across that dex's form rows
  — Unown/Burmy have no base row). Region and Gigantamax forms use their own
  row when the sheet tracks one, otherwise inherit the species answer (which
  is exactly what the old species-level shiny list gave every form).
  Costumes get **no** fallback: costume shinies are separate releases, the
  sheet tracks them comprehensively, and the signal being replaced
  (`assets.shinyImage` presence) is the confirmed over-reporter.
- **Shadow**: `pokemonSettings[].shadow` block presence, resolved per form
  (`RATTATA_ALOLA` gets its own answer) with a species-level fallback.
- **Gender**: union of `malePercent > 0` / `femalePercent > 0` across every
  `genderSettings` record for the species. See Concerns for why not
  "prefer the `_NORMAL` record".
- **Move display names**: derived from the move id
  (`WEATHER_BALL_FIRE` -> "Weather Ball Fire"), because the slug derives from
  the name and the old source's names were themselves id-derived.
  pokemon-go-api's English name is used only when it slugifies identically
  — a pure cosmetic upgrade ("X-Scissor" over "X Scissor") that cannot move
  a slug. Using pgapi names as primary was tried first and vanished 24 move
  slugs; this rule cuts that to 11 (all genuine source differences).
- **`VN_BM_*` (62 records) excluded**: no `combatMove` counterpart, no
  display name in either source, and zero `vn-bm-*` slugs in the committed
  `reference.json` — so excluding them is parity-preserving, not a new rule.
- **PvP turns**: `combatMove.durationTurns` is turns-minus-one
  (absent = 1). Verified to reproduce the old `turn_duration` exactly for
  all 77 shared fast moves and for every charged move.
- **Type-effectiveness ordinal order** is hardcoded in `moves.ts` because
  GAME_MASTER never publishes it (`combatType` and the `typeEffective`
  records are both alphabetical, neither is the ordinal order). Verified
  element-by-element against the old table: **0 differences across all 324
  rows** on real data, and pinned by a fixture test using two real rows.
- **PvP rank requirements** come from the highest-numbered
  `COMBAT_RANKING_SETTINGS_S<N>` (parsed numerically — a lexical sort puts
  S9 after S30), not the legacy 10-rank season-less record the old source
  matched; that keeps the requirement ladder the same length (24) as the
  `vsSeekerLoot` reward ladder. `pvp_rank_reward.league_rank` has **no** FK
  to `pvp_rank_requirement.rank` (checked `REFERENCE_SCHEMA_SQL`), so either
  choice was structurally safe.

## Testing

`test/transform-{species,moves,evolutions,player-progression,pvp,reference-data}.test.ts`
plus `test/transform-fixtures.ts` (shared builders; not a `.test.ts`, so
`npm test`'s glob doesn't pick it up as a suite — same pattern as
`test/node-sqlite-connection.ts`). node:test + `assert/strict`, matching
Tasks 1-2. **All fixtures are hand-written** — no test needs `.cache-v2`
(absent in this worktree) or the untracked 18MB `GAME_MASTER.json`.

- **38 new tests, all passing.** Full suite `npm test` -> **182/182 pass**
  (144 before). `npx tsc --noEmit -p tsconfig.json` clean.
  `npx eslint` on all new files clean (and the pre-commit hook re-ran full
  lint successfully).
- **Eternatus check (exact outcome)**: `test/transform-species.test.ts`,
  first test. Eternatus is given an `assets.shinyImage` in the fixture and a
  sheet row with `debut: ""`. Result: `eternatus-standard-unknown` has
  `shinyAvailable: false`, `shinyReleasedAt: null`. Confirmed against real
  data too (parity run below): both Eternatus forms come out
  `false`/`null`. A regression to the old `Boolean(af.shinyImage)` rule is
  caught by two tests — this one and the costume case
  (`pikachu-standard-not-released-shiny-male`, a costume with a shinyImage
  and no sheet row, asserted `shinyAvailable: false`).
- **Raid/Community-Day**: `test/transform-reference-data.test.ts` asserts
  all six fields are **present**, are arrays, and are empty
  (`Object.hasOwn` + `Array.isArray` + `length === 0`), while every other
  table is populated. No transform emits them at all.

### Real-data parity run (throwaway harness, not committed)

Ran all five transforms against the real `GAME_MASTER.json`, the real
`pgapi/pokedex.json` from the main checkout's cache and a live fetch of the
shiny sheet, diffed against the committed `src/data/reference.json`:

| table | new | old | | table | new | old |
|---|---|---|---|---|---|---|
| species | 1024 | 1024 | | playerLevels | 80 | 80 |
| forms | 2716 | 2703 | | playerLevelRewards | 364 | 268 |
| formTypes | 4066 | 4044 | | medals | 997 | 183 |
| megaVariants | 57 | 57 | | medalTiers | 1313 | 399 |
| moves | 328 | 317 | | friendshipLevels | 5 | 5 |
| formMoves | 11131 | 10392 | | pvpRankRewards | 240 | 230 |
| speciesEvolutions | 479 | 479 | | pvpRankRequirements | 24 | 10 |
| typeEffectiveness | 324 | 324 (0 value diffs) | | weatherBoosts | 18 | 18 (0 diffs) |

- **Vanished species slugs: 0. Vanished form slugs: 0. Vanished mega
  variant slugs: 0.** (The inline slug-stability check Task 4 adds will
  pass.) The 13 *added* form slugs are exactly the six gender-union species.
- Vanished move slugs: 11 — the 5 legacy duplicate records the old source
  kept (aeroblast x2, sacred-fire x2, aura-wheel-electric) that GAME_MASTER
  has only once; 5 moves GAME_MASTER no longer carries (myst-fire,
  wildbold-storm, psywave, metal-sound, sand-attack); and
  `water-gun-blastoise`, which GAME_MASTER classifies as a fast move
  (`water-gun-blastoise-fast`). Move slugs are not covered by
  `check-slug-stability.ts` and are not referenced by any personal table.
- Shiny flips: 80 total, of which 22 true->false (21 costume forms with a
  `shinyImage` but no sheet row — the false-positive class this task
  targets — and 1 region form) and 58 false->true (newly released shinies
  the old list was missing).
- Shadow flips: 456, **all** false->true, none lost — the expected
  GAME_MASTER superset. Spot check: Blaziken now `shadowAvailable: true`.
- Player levels: all 80 have a real `cumulativeXp` (level 80 = 203,353,000);
  no nulls remain.
- **Primary-key uniqueness sweep on the real-data output: 0 duplicates** for
  every table with a composite or slug PK — `species`, `form`,
  `form_move` (PK is `(form_slug, move_slug)`, so a move appearing in both a
  species' normal and elite list would have collided; it doesn't),
  `form_type`, `move`, `species_evolution`, `medal`, `medal_tier`,
  `player_level_reward`, `pvp_rank_reward`, `pvp_rank_requirement`.

## Self-review findings

- Initial pgapi-name-first move naming lost 24 move slugs and would have
  collapsed the four Weather Ball / four Techno Blast variants onto one
  name. Caught by the parity diff, fixed with the "only take the published
  name when it slugifies identically" rule.
- Initial per-form-only shiny lookup produced 245 true->false flips: the
  sheet doesn't track most cosmetic/pattern forms (Unown letters, Deoxys,
  Burmy, Vivillon...) and files some tokens species-prefixed
  (`pm201.fUNOWN_G`). Fixed with the known-vs-unknown distinction plus the
  species-level fallback; down to 22, all explainable.
- Also caught by the parity diff: species with no base `pm{dex}` row at all
  (Unown, Burmy) needed `speciesDebut` to fall back to the earliest form-row
  date rather than returning null.
- Confirmed no module-level mutable state survived the port
  (`spriteManifest` is returned; a test asserts two runs produce identical
  manifests).

## Concerns

1. **Medals are a real regression and want an owner decision (the reason
   for DONE_WITH_CONCERNS).** GAME_MASTER's `badgeSettings` carries **no
   display strings** — only the `BADGE_*` id, rank and targets. The plan's
   coverage table ("shape matches") missed this. Consequences, all visible:
   - `medal.name` becomes id-derived ("7 Day Streaks" where the old source
     said **"Triathlete"** — not derivable from the token), `description`
     becomes `""`.
   - `medal.slug` therefore changes, and `medal_progress_personal.medal_slug`
     is a real live FK (`medal_slug text NOT NULL REFERENCES medal(slug)`,
     `src/db/migrations/0004_empty_vapor.sql:144`) with no `SLUG_RENAMES`
     entry. **This is a hard failure, not a quiet degradation**:
     `reference-sync.ts`'s `quarantineOrphans` is called for
     `species_personal`, `form_personal`, `form_background_personal` and
     `mega_personal` — **not** `medal_progress_personal`
     (`src/db/reference-sync.ts:158-166`). Since the sync runs with
     `PRAGMA defer_foreign_keys = true`, a stale medal row would trip the FK
     check at COMMIT and roll back the **entire** `syncReferenceData`
     transaction, so any user with medal progress would fail to sync the new
     reference data at all. Whatever the naming decision, either
     `medal_progress_personal` gets added to the quarantine list or the
     slugs must be preserved.
   - Medals are rendered: `src/features/trainer/TrainerPage.vue` (name +
     editable progress) and `src/features/stats/StatsPage.vue` ("Top medals",
     "Medals started N / M").
   - Row counts jump 183 -> 997 medals / 399 -> 1313 tiers, because
     id-derived names no longer collapse the ~800 same-named event badges.

   **A cheap fix exists if the owner wants parity**: the last cached
   `pogoapi/badges.json` (597 records) is **positionally aligned** with
   GAME_MASTER's `badgeSettings` array (verified: index 1 -> Jeju Day 00 ->
   "Pokémon Air Adventures", index 5 -> Bali Day 00 -> "Pikachu's Indonesia
   Journey", ...), so a one-time vendored `badgeType -> {name, description}`
   constant would preserve every existing slug, name and description, with
   the id-derived value as the fallback for the ~400 newer badges. I did
   **not** do this unilaterally: it means committing a ~600-entry data blob
   derived from the source this pass is deliberately dropping. Whichever way
   this goes, it's a small edit confined to `medalDisplayName` in
   `player-progression.ts`.

2. **Gender union changes six species** (Frillish, Jellicent, Pyroar,
   Meowstic, Oinkologne gain a female; Indeedee gains a male), adding 13
   form rows. Chosen over "prefer the `_NORMAL` record" for two reasons:
   all six genuinely have both genders in game, and the `_NORMAL` rule would
   have flipped Indeedee female->male, **deleting** its existing female form
   slugs (a slug-stability failure and orphaned personal rows). The old
   "prefer Normal" rule was a statement about pogoapi's record structure,
   not a semantic claim.

3. **Friendship levels**: GAME_MASTER publishes a 6th record
   (`FRIENDSHIP_LEVEL_5`) that production has never had and that no source
   names — deliberately **not** emitted. The five names are carried as a
   constant map (preserving existing production data, not inventing
   mechanics). XP values change: GAME_MASTER says 1000/3000/10000/50000/
   100000 where the old source said 1500/4500/15000/75000/150000 (a uniform
   1.5x); GAME_MASTER matches the real in-game figures, but it is a value
   change worth knowing about. `tradingDiscount`/`attackBonus`/
   `raidBallBonus` match the old values exactly.

4. **Item names lose their accent**: `ITEM_POKE_BALL` -> "Poke Ball" where
   the old source said "Poké Ball". Cosmetic, affects
   `player_level_reward.item_name` and PvP item rewards.

5. **`formMoves` grows 10392 -> 11131** — GAME_MASTER lists more elite moves
   than the old endpoint did, plus the 13 new gender forms. Not a rule
   change.

6. **Pre-existing form-type quirk preserved, not fixed**: types are keyed by
   *species* slug, and a species' region form overwrites the base entry's
   types for **all** of that species' forms (so e.g. Alolan Rattata's typing
   lands on plain Rattata's forms too). This is exactly what
   `build-reference.ts` does today; per the brief I preserved it rather than
   changing data semantics. Worth a follow-up ticket.

7. **`pvpRankRewards` reward vocabulary gains one value**: GAME_MASTER's
   `itemRankingLootTableCount` slot (a roll on an item loot table) has no
   old-source equivalent and is emitted as `rewardType:
   "item_loot_table"` rather than being flattened into `"item"` with a
   missing name. `reward_type` is a free-text column; nothing in `src/`
   switches on its value.

## Post-review amendments

Advisor review after the first commit raised three items; all handled:

1. **PK-uniqueness sweep** (potential `form_move` collision if a species
   lists a move in both its normal and elite pool — the old source's lists
   were disjoint by construction, GAME_MASTER's are populated
   independently). Ran the sweep against real data: **0 duplicates across
   all 11 slug/composite-key tables** (results folded into the parity
   section above). No code change needed.
2. **`backgrounds` was `[]` in the template test**, which would have led
   Task 4 to silently drop the two hardcoded background rows. Fixed: the
   test now carries both literals and asserts them, and the report's
   "Exports Task 4 needs" section spells out that regions/types/backgrounds
   are orchestrator-assembled, not transform outputs.
   `npx tsx --test test/transform-reference-data.test.ts` -> 3/3 pass;
   full `npm test` re-run -> **182/182 pass**.
3. **Verified what actually happens to orphaned medal progress** rather than
   assuming: `medal_progress_personal` is *not* in `quarantineOrphans`'s
   list, so the outcome is a rolled-back sync transaction, not a quiet
   quarantine. Concern #1 updated with the file/line evidence and the
   remediation options.
