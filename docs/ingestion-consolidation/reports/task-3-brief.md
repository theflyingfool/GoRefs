### Task 3: `transform/*.ts` — port and re-source the build logic

The largest task. Build `scripts/ingest/transform/species.ts`,
`transform/moves.ts`, `transform/evolutions.ts`,
`transform/player-progression.ts`, `transform/pvp.ts` by porting the
private `buildX()`-style functions out of the current
`scripts/ingest/build-reference.ts` (read it in full first — it's ~1000
lines and is the actual spec for almost every transform rule, including
non-obvious ones like the baby-Pokémon family-root exclusion, the
Nidoran♀/♂ display-name cleanup, the Hitmontop family-root note, and the
per-species move-slug collision handling — preserve all of this logic,
this task is a restructuring + re-sourcing, not a rewrite of business
rules) with these changes:

1. **Re-source, don't re-derive**: species/forms/moves/type-effectiveness/
   weather/player-progression/badges/friendship data that currently comes
   from `loadPogoapi<T>(...)` calls now comes from Task 1's
   `game-master.ts` getters. Gender and shadow availability specifically:
   gender from `genderSettings`, shadow from `pokemonSettings[].shadow`
   block *presence* (confirmed this session as a reliable per-species/form
   signal — sanity-checked against Mew, which correctly has none). Species/
   forms/stats/sprites keep coming from `pokemon-go-api`'s pokedex (now via
   Task 2's `sources/pokemon-go-api.ts`). Shiny availability comes from
   Task 2's `sources/shiny-sheet.ts` (`debut` field present = released) —
   **not** from `pokemon-go-api`'s `assets.shinyImage` presence, which this
   session confirmed produces false positives (Eternatus has a
   `shinyImage` but is not actually shiny-released; verify your
   implementation against this exact case). Story the shiny `debut` date
   too, not just a boolean — see the schema task (Task 5) for where it
   lands; this task should pass it through even before that column exists
   (e.g. as a field on an intermediate type), rather than dropping it now
   and re-deriving later.
2. **Drop raid bosses and Community Days entirely** — no
   `transform/raids-events.ts`, no raid-boss or Community-Day building
   logic at all. The final `ReferenceData` object's `raidBosses`/
   `raidBossWeatherBoosts`/`communityDays`/`communityDayBonuses`/
   `communityDaySpecies`/`communityDayEventMoves` fields (required arrays
   in `src/db/reference-data.ts` — do not change that type) get `[]`.
3. **Fix the two duplicate-scan waste findings**, since this code is being
   touched anyway: build one `const byId = new Map(pokedex.map(e => [e.id, e]))`
   once and pass it to both the family-grouping pass and
   `buildSpeciesEvolutions`'s equivalent (today two separate
   `pokedex.find((e) => e.id === evo.id)` calls); merge the two full passes
   over `pokedex` (species/form building, and the separate
   `typesByFormSlug`-building pass) into one, since the first pass already
   computes each entry's slug.
4. Leave the `MAX_TRAINER_LEVEL` constant/comment logic largely as-is in
   spirit but note in a comment that GAME_MASTER's `playerLevel` template
   (via Task 1) now provides the real XP/CP curve backing the existing
   owner-confirmed value of 80, replacing the previous no-source-available
   situation described in the current comment.

Each transform module should be independently testable (pure functions:
typed source data in, typed rows out) — write tests per module covering at
minimum: the shiny/shadow/gender re-sourcing behaves as described above
(including the Eternatus false-positive check), and that raid/Community-Day
outputs are empty. Reuse existing fixtures/patterns from any current tests
covering `build-reference.ts` if they exist (check first) rather than
inventing a new test style.

Do not build `ingest.ts` yet — this task only produces the transform
modules + their tests. `build-reference.ts` itself is not deleted until
Task 4 confirms the new orchestrator fully replaces it.

