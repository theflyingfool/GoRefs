# Sub-project 7c: Compare View — Design (v2, post-7b revision)

**Status:** Revised after Sub-project 7b shipped. Supersedes
`2026-07-26-sub-project-7c-compare-view-design.md` — that draft's §1/§2
(entry points, "one import mechanism") held up unchanged against 7b's real
shipped interfaces; this revision replaces its §3 (comparison models) with
a much narrower, easier-to-build v1, per the owner's explicit steer toward
"the easiest to implement first comparison" over building canned gap
models.

**Depends on:** Sub-project 7b (complete) — `exportTrainer`,
`ExportBundle`/`TrainerExport`, `planTrainerImport`/`applyTrainerImport`,
`pokemon_instance.uuid`. Confirmed these interfaces match this doc's
assumptions exactly; no drift from 7b's actual shipped shape.

## 1. What this is

A **dex/collection comparison** screen — explicitly *not* a stats
comparison (player level, XP, medals; see §6). Pick two local trainer
profiles (or import a new one on the spot) and view their filtered dex
grids side by side, using the exact same filter/search bar the existing
Dex page already has.

There is no bespoke "comparison model" for v1 — the comparison *is* just
"the same filter, applied to two profiles' data, shown side by side."
Registered-count gaps, shiny gaps, etc. are all just different filter
selections a user can already make with the existing chips; nothing new
needs to be computed.

## 2. Entry point and picking the other trainer

- New top-level route, `/compare`, with its own nav entry (mirrors how
  every other major feature — Dex, Collection, Stats, Settings — already
  gets its own route).
- Two dropdowns, "Left" and "Right", both populated from
  `repo.listProfiles()`.
- An "Import a trainer..." button next to the dropdowns opens the exact
  same flow Settings' import already uses: file picker →
  `readExportBundleFile` → `repo.planTrainerImport` → (if any entry is
  `ask-merge-or-separate`, the same confirm-prompt pattern Settings uses)
  → `repo.applyTrainerImport`. No separate import code path. Once
  imported, the new or promoted profile is just another entry in both
  dropdowns.

## 3. Comparison mechanics (v1)

One filter bar (reusing the existing `SpeciesFilter`/toggle-chip UI from
the Dex grid), shared by both sides — not independent per-side filters.
Below it, two grids side by side, each showing
`listSpeciesSummariesForProfile(profileId, filter)`'s result for its own
selected profile.

### New repository method needed

`Repository.listSpeciesSummaries(filter)` implicitly operates on whichever
profile is *current* — there's no way to ask it for an arbitrary other
profile's summaries without switching to it first (which has real side
effects: it writes `is_current` to disk and repoints every other page's
live data). The compare screen needs to read **two** profiles'
data — often neither of which is the current one — without switching
either.

This is the exact same problem `exportTrainer(profileId)` already solved
for Sub-project 7b (reading a specific profile's bucket directly from
`profileBuckets`, not through the live `state`). Add a parallel method:

```ts
listSpeciesSummariesForProfile(profileId: string, filter?: SpeciesFilter): SpeciesSummary[];
```

implemented in `sqlite-repository.ts` by temporarily computing summaries
against `profileBuckets.get(profileId)`'s data — following
`exportTrainer`'s established pattern, not switching `state`. (The
in-memory-store's shared `listSpeciesSummaries` logic can likely be
refactored into a pure function taking a `PersonalState`-shaped bucket, so
both the "current profile" method and this new one call the same
underlying logic against different buckets — avoid duplicating the
filter/search logic itself.)

### Read-only grid rendering

The existing Dex grid (`DexGridPage.vue`) is tightly coupled to editing:
tapping a tile calls `repo.setSpeciesPersonalField` directly (mutating
whichever profile is *live*-current), plus select-mode and bulk-edit
affordances. None of that is meaningful — or safe — for a side-by-side
view of two profiles that usually aren't the current one. Per the owner's
choice to reuse the existing component rather than build a separate
renderer from scratch, add a `readOnly` prop to the grid component (or the
shared tile-rendering piece of it, if it's cleaner to extract just that
much): when true, tapping a tile does nothing, select-mode/bulk-edit UI is
hidden, and rendering otherwise looks identical. The compare screen
renders two instances of the grid in `readOnly` mode, each fed a
`SpeciesSummary[]` from `listSpeciesSummariesForProfile` directly (not
looked up live through the component's own `props.repo` calls) rather than
each pane owning its own repo-backed fetch.

### Layout/interaction details

Left to standard practice, matching this app's existing conventions (the
owner is not looking for design review here) — stacked on narrow
viewports, side-by-side above the existing `≥768px` desktop breakpoint,
consistent with the rest of the app's responsive handling.

## 4. Testing

- `listSpeciesSummariesForProfile` — unit-testable the same way
  `exportTrainer`'s "doesn't switch, reads the right bucket" test already
  proved that pattern works: set data on profile A, switch away, call the
  new method for A by id, confirm it reflects A's real data without
  switching back to it.
- The read-only grid mode — confirm tapping a tile in `readOnly` mode
  doesn't call `setSpeciesPersonalField`/mutate anything, matching however
  this codebase already tests "does this button call this handler"
  interactions elsewhere (this project's `.vue` files aren't covered by
  `tsc`, so this is a manual/compiled-output check, same accepted gap
  precedent as prior Vue-migration sub-projects).

## 5. Explicitly out of scope for this pass

- Independent per-side filters — a real, acknowledged future need
  (comparing e.g. trainer A's shinies against trainer B's uncaught), just
  not v1. Logged to roadmap.
- Any canned "comparison model" beyond "the same filter, both sides" —
  registered-count/shiny/missing-from-each-other gap models are all
  achievable today via the existing filter chips; a dedicated model picker
  can be revisited if the shared-filter approach proves insufficient in
  practice.
- The compare-screen Trade UX (select a specimen from each side, hit
  "trade") — already tracked in `docs/roadmap.md`, unchanged by this
  revision.

## 6. Explicitly NOT this sub-project: stats comparison

The original 7c draft's §2 said "Stats page: add a compare section" —
that idea is **superseded and split off**, per the owner's clarification:
this sub-project builds a dex/collection comparison (`/compare`, per §1-3
above), which is a *different* feature from comparing **stats**
(player level, total XP, medal progress, specimen-state counts, etc.)
between two trainers on the existing Stats page. That stats-comparison
idea is real and still wanted eventually, but is not scoped or designed
here — logged to `docs/roadmap.md` as its own future item, distinct from
this one.
