### Task 1: `sources/game-master.ts` — indexed GAME_MASTER parser

Build `scripts/ingest/sources/game-master.ts`, replacing GAME_MASTER access
for every later task. Raw shape: a flat JSON array of
`{ templateId: string, data?: Record<string, unknown> }` (~18.7k entries;
most entries have a single key in `data`, e.g. `{ "pokemonSettings": {...} }`
— that key is the category, NOT `templateId`, which is a unique per-record
string and must never be used as a grouping key — this was a real bug
caught in plan review, see the "Waste found" section above for the full
explanation of why).

Export `createGameMasterIndex(raw: unknown[])` that:
1. Builds one `Map<string, unknown[]>` keyed by each entry's `data` object's
   own key (the category — `"pokemonSettings"`, `"formSettings"`,
   `"genderSettings"`, `"moveSettings"`, `"combatMove"`, `"typeEffective"`,
   `"weatherAffinities"`, `"playerLevel"`, `"levelUpRewards"`,
   `"badgeSettings"`, `"friendshipMilestoneSettings"`, `"combatLeague"` —
   confirm the exact category strings against
   `docs/drafts/GAME_MASTER.json` directly, don't guess from this list).
2. Within each category, builds a secondary `Map` keyed by that category's
   natural id field (`pokemonId`+`form` for `pokemonSettings`/
   `genderSettings`/`pokemonExtendedSettings`, `movementId` for
   `moveSettings`, `uniqueId` for `combatMove`, etc. — inspect real records
   to confirm each category's actual key field, they're not uniform).
3. Exposes typed getters, one per category this pipeline needs (exact list
   above) — each an O(1) lookup against the secondary map, never a re-scan.
   If a category turns out to have more than one row per natural key
   (shouldn't happen per this session's exploration, but don't assume),
   keep first-seen and `console.warn` the conflict — same convention
   `build-reference.ts`'s existing `species_evolution` conflict handling
   uses (read that function for the exact pattern to match).
4. For `playerLevel` and `levelUpRewards` specifically — these were
   confirmed this session to carry the real level-80 XP curve
   (`requiredExperience[]`/`cpMultiplier[]`) and per-level item rewards;
   expose them in a shape a later task can map directly to
   `PlayerLevel`/`PlayerLevelReward` (see `src/db/types.ts` for those
   target shapes).

Write unit tests (this repo's existing test setup — check `package.json`'s
test script and an existing `scripts/`-adjacent or `src/db/`-adjacent test
file for the pattern) covering: correct category bucketing, correct
per-category natural-key lookup, and the first-seen-wins-with-warning
behavior on a synthetic duplicate-key fixture (don't rely only on real
GAME_MASTER data for this last case — construct a minimal fixture).

Do not wire this into anything else yet — this task only produces the
module + its tests.

