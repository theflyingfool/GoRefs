# Sub-project 5: Collection/Dex/Tags Gaps — Design

> Part of the [V2 consolidation roadmap](2026-07-23-v2-consolidation-roadmap.md).
> This is the design for that roadmap's Sub-project 5 only. Sequenced
> ahead of Sub-project 6 (Tauri) per the roadmap's Sequence section.

## Goal

Fix three gaps found during real-device use: (5a) no way to open an
individual Pokémon from Collection and edit its details, (5b) logging a
catch doesn't update the Dex grid's achievement flags, (5c) no browsable
list of tags. Along the way, add two specimen-level flags that surfaced
during 5a's scoping (Dynamax catch-source, received-via-trade) since the
edit form's plumbing is already being built.

## Schema changes

Two new nullable-boolean columns on `pokemon_instance`, following the
exact pattern of the existing `shiny`/`lucky`/`shadow`/`purified` columns
(plain `boolChecks`-constrained booleans, no new reference data):

- `dynamax` — catch-source flag: this specimen came from a Max Battle.
  Independent of `form_personal.dynamax` (the "have I ever caught a
  Dynamaxed one of this form" achievement) — same relationship `shiny`
  (instance) already has to `form_personal.shiny` (achievement).
- `received_via_trade` — plain boolean, this specimen's origin.

Both are plain `ALTER TABLE ADD COLUMN` additions (no table rebuild
needed, unlike Sub-project 4's IV-column migration which required one).
Bumps `CURRENT_PERSONAL_SCHEMA_VERSION` to 9.

Added to:
- `PokemonInstance` (`src/db/types.ts`)
- `NewPokemonInstanceBatch` (`src/data/repository.ts`) — settable at
  catch time via Log-a-catch's Full details mode, not just after the fact
- The new `UpdatePokemonInstanceFields` interface (below)

## 5a: Edit-instance page

**Route:** new `edit-instance` route, parameterized by instance id
(`src/app-shell/router.ts`), mirroring `data-entry-detail`'s slug-param
pattern.

**Entry point:** Collection's existing tap-to-expand action menu
(`CollectionPage.vue`'s `toggleActions`) gains a fifth button, "Edit
details," alongside the four existing status buttons (Mark kept/traded/
released/evolved). Those four stay exactly as they are — this page does
not duplicate or replace them.

**New page: `EditInstancePage.vue`**, loads `repo.getPokemonInstance(id)`
on mount. Fields:

- Nickname (text)
- CP (number)
- IV Attack / Defense / Stamina — reuses `IvComponentInput.vue` (already
  built for Log-a-catch), including its live-computed IV% preview via
  `computeIvPercent`
- Six checkboxes in one row: Shiny, Lucky, Shadow, Purified, Dynamax,
  Received via trade
- Hearts earned (number)
- Current Mega Level (number)
- Background — a `<select>` populated from a new `repo.listBackgrounds()`
  method (returns `{ slug, name }[]` from the `backgrounds` reference
  table). No existing background-picker UI exists anywhere in the app
  today (Log-a-catch doesn't expose `backgroundSlug` either) — this is
  net-new, minimal UI, not a port of an existing pattern.
- Tags — multi-select checkboxes over `repo.listTags()`, pre-checked
  against this instance's current tags, plus the "+ Add new tag" inline
  creator already used by `LogCatchPage.vue`

**Repository additions:**

```ts
listBackgrounds(): { slug: string; name: string }[];

updatePokemonInstance(id: number, fields: UpdatePokemonInstanceFields): Promise<void>;
```

```ts
export interface UpdatePokemonInstanceFields {
  nickname?: string | null;
  cp?: number | null;
  ivAttack?: number | null;
  ivDefense?: number | null;
  ivStamina?: number | null;
  shiny?: boolean;
  lucky?: boolean;
  shadow?: boolean;
  purified?: boolean;
  dynamax?: boolean;
  receivedViaTrade?: boolean;
  heartsEarned?: number | null;
  currentMegaLevel?: number | null;
  backgroundSlug?: string | null;
  /** Full replacement of this instance's tag set — diffed against current
   * pokemon_instance_tag rows (insert new links, delete removed ones),
   * same INSERT OR IGNORE pattern already used at creation time. */
  tagIds?: number[];
}
```

Saving calls `updatePokemonInstance`, then navigates back to Collection
(which reloads its list on mount, showing the updated row).

## 5b: Dex-sync cascade fix + backfill

**Root cause:** `createPokemonInstances` only ever inserted
`pokemon_instance` rows — it never wrote `form_personal`/
`species_personal` achievement flags, which is what `DexGridPage.vue`
actually reads (`caught: personal.registered`, etc.).

**Fix:** after inserting new instance row(s), derive and write the
applicable `form_personal`/`species_personal` flags using the same
`setSpeciesPersonalField`/`setFormPersonalField` write path the Dex
grid's manual checkboxes already use — one write path, not two, so the
two ways of setting these flags can never drift apart. Extract the
derivation itself into a pure function, `deriveFormPersonalFlags(instance:
{ shiny, lucky, shadow, dynamax, ivAttack, ivDefense, ivStamina })
=> Partial<FormPersonal>`, callable from both the live create path and
the backfill script below.

**Derivation table** (only unambiguous facts — no IV-floor thresholds,
see Deferred below):

| Instance attribute | Sets |
|---|---|
| (always, on any catch) | `caught` |
| `shiny` | `shiny` |
| `lucky` | `lucky` |
| `shadow` | `shadow` |
| `dynamax` | `dynamax` |
| `ivPercent === 100` (15/15/15) | `fourStar` |
| `shiny && ivPercent === 100` | `shundo` |
| `lucky && shiny` | `luckyShiny` |
| `shadow && shiny` | `shadowShiny` |
| `dynamax && shiny` | `dynamaxShiny` |
| `lucky && dynamax` | `luckyDynamax` |
| `lucky && dynamax && shiny` | `luckyDynamaxShiny` |
| `lucky && ivPercent === 100` | `luckyFourStar` |
| `shadow && ivPercent === 100` | `shadowFourStar` |
| `dynamax && ivPercent === 100` | `dynamaxFourStar` |
| `lucky && dynamax && ivPercent === 100` | `luckyDynamaxFourStar` |

Also sets `species_personal.registered = true`, matching what checking a
form's `caught` box on the Dex grid already cascades to today.

**Backfill:** a one-time step run on load for devices upgrading past
schema version 9 — scans every existing `pokemon_instance` row and
applies `deriveFormPersonalFlags` to each one's form/species, via the
same `setSpeciesPersonalField`/`setFormPersonalField` calls. Idempotent
(only ever sets flags `true`, never unsets one that's already true),
since it reuses the live-path's own derivation function rather than a
parallel implementation.

## 5c: Tags management page

**New route:** `tags`, added as a new top-level nav entry (`router.ts`
and the main nav component) alongside Collection/Trainer/Stats/etc.

**Page contents:** list of every tag (`repo.listTags()`), each row
showing:
- Tag name
- Usage count — new `repo.getTagUsageCounts(): TagCount[]` (or extend the
  existing `getTopTagCounts` if its shape already fits without a limit)
- Rename — inline text input, same in-place-edit pattern
  `TrainerPage.vue` already uses for trainer name/friend code, saves via
  `repo.renameTag(id, name)`
- Delete — confirmation prompt, then `repo.deleteTag(id)`, which removes
  the tag row and cascades to delete its `pokemon_instance_tag` links

**Repository additions:**

```ts
getTagUsageCounts(): TagCount[]; // { tag: Tag; count: number }[]
renameTag(id: number, name: string): Promise<void>;
deleteTag(id: number): Promise<void>;
```

**Forward-looking note for Sub-project 7 (multi-account), not acted on
here:** tags are currently scoped by `profile_id` (unique on
`(profile_id, name)`). The owner noted tags could plausibly be useful to
share *across* accounts (importing a friend's data might surface a tag
name worth reusing) — but with only one profile existing today, this is
moot for this sub-project. Flag it as an open question for Sub-project
7's brainstorm, not a decision to make now.

## Out of scope / deferred

- **IV-floor auto-derivation** (`floor`, `luckyFloor`, `shadowFloor`,
  `dynamaxFloor`, `luckyDynamaxFloor`). Requires a new per-catch-type
  minimum-IV reference table the owner hasn't designed yet ("I'll figure
  out what the floors are and we can add a floor table"). These fields
  stay manual Dex-grid toggles, unchanged from today. Log as a follow-up
  roadmap item once the floor table's values are worked out.
- Background-achievement linking (`form_background_personal`) — the edit
  page's Background field only sets `pokemon_instance.backgroundSlug`
  (which background this specimen has), not the achievement-tracking
  join table; that table has "no per-row setter yet" per its own code
  comment and stays that way here.
- Any multi-account/profile-scoping changes — Sub-project 7's territory.

## Testing approach

- `deriveFormPersonalFlags`: pure-function unit tests covering every row
  of the derivation table above, plus the "no flags true" base case.
- Backfill script: a migration test seeding pre-fix `pokemon_instance`
  rows with no corresponding `form_personal`/`species_personal` flags,
  asserting the backfill sets exactly the expected flags per the
  derivation table and never unsets an already-true flag.
- `updatePokemonInstance`: unit tests for each field, plus the tag-diff
  logic (add one, remove one, replace the full set).
- `renameTag`/`deleteTag`: unit tests, including delete's cascade to
  `pokemon_instance_tag`.
- New CHECK constraints (`dynamax`, `received_via_trade`): same
  SQL-generated-column-style test pattern as Sub-project 4's
  `iv-generated-column.test.ts` (insert valid values, assert invalid
  values rejected).
- e2e: a Playwright spec covering the edit-instance page's full round
  trip (open from Collection, change fields, save, verify Collection
  reflects the change), and one covering the Dex-grid-updates-after-catch
  fix (log a catch, navigate to Dex grid, verify it shows caught/shiny as
  applicable without a manual toggle).
