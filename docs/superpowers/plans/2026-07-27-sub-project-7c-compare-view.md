# Sub-project 7c: Compare View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/compare` page that shows two local trainers' filtered dex grids side by side, using one shared filter bar and the exact same tile-rendering code the real Dex page uses.

**Architecture:** One new `Repository` method (`listSpeciesSummariesForProfile`) reads an arbitrary profile's data without switching to it, mirroring `exportTrainer`'s already-proven `profileBuckets`-direct-read pattern. The Dex grid's tile-rendering markup is extracted into a shared, `readOnly`-capable component so the compare page and the real Dex page render identically without duplicating markup. A new, small Vue-native filter control (NOT the existing vanilla-TS filter sheet — see Task 3's note on why) drives one shared `SpeciesFilter` applied to both sides. Importing a second trainer reuses the exact bundle-import logic already built for Settings, extracted into a shared helper so it isn't duplicated.

**Tech Stack:** TypeScript, Vue 3 `<script setup>`, `node:test` + `node:assert/strict`, the existing hash-based router in `src/app-shell/router.ts`.

## Global Constraints

- This is a **dex/collection comparison**, not a stats comparison — nothing in this plan touches the Stats page. (See design spec §6 — comparing player level/XP/medals is a separate, not-yet-scoped future item.)
- One shared filter bar controls both sides — no independent per-side filtering in this pass (design spec §3/§5).
- Reuse the existing Dex-grid tile-rendering code for both the real Dex page and the compare page (design spec §3) — extract it into a shared component rather than duplicating markup.
- `.vue` files are not covered by `tsc -b` in this project — verify Vue changes by reading the compiled Vite output and/or a dev-server fetch, per the accepted-gap precedent from prior Vue-migration sub-projects (see `.superpowers/sdd/progress.md`'s Sub-project 7a Task 10 entry for the established verification method in this headless environment).
- Design spec: `docs/superpowers/specs/2026-07-26-sub-project-7c-compare-view-design.md`. Read it before starting.

**Deviation from the design spec's exact wording, discovered while planning — read before Task 3:** §3 says to reuse "the existing `SpeciesFilter`/toggle-chip UI from the Dex grid." In the real codebase, that UI is a vanilla-TS "filter sheet" (`renderFilterSheetContent` in `src/features/data-entry/grid-types.ts`, driven by a `GridState` object `main.ts` owns) — not a portable Vue component, and not something a new Vue page can cleanly reuse without reaching into `main.ts`'s DOM/state machinery. Task 3 below builds a new, small Vue-native filter control instead, following the exact same pattern `BulkFormEditPanel.vue` already established (its own local field-filter-chip cycling, `.filter-chip`/`.filter-chip-active` styling) — genuinely reusing the same `SpeciesFilter`/`GridFilterField` **types** and the same **visual language**, just not the literal vanilla-TS DOM code, which isn't feasible to share cleanly across the Vue/vanilla boundary.

---

## File Structure

- `src/data/repository.ts` — add `Repository.listSpeciesSummariesForProfile(profileId, filter?)`.
- `src/data/in-memory-store.ts` — refactor `listSpeciesSummaries`'s body into a bucket-parameterized helper, exposed alongside the returned `Repository` object so `sqlite-repository.ts` can call it against an arbitrary profile bucket.
- `src/data/sqlite-repository.ts` — implement `listSpeciesSummariesForProfile`.
- `src/features/data-entry/SpeciesTileGrid.vue` (new) — extracted, `readOnly`-capable tile-grid renderer.
- `src/features/data-entry/DexGridPage.vue` — refactored to use the new shared component (no behavior change).
- `src/features/settings/personal-data-transfer.ts` — extract `importTrainerBundleFile(repo, file)` (the read → reconcile-prompts → apply flow), so both Settings and Compare call the same function.
- `src/features/settings/SettingsPage.vue` — refactored to call the extracted helper (no behavior change).
- `src/features/compare/CompareFilterBar.vue` (new) — the compact Vue-native filter control.
- `src/features/compare/ComparePage.vue` (new) — the compare page itself.
- `src/app-shell/router.ts` — add the `"compare"` route.
- `src/app-shell/nav-drawer.ts` — add the nav entry.
- `src/main.ts` — mount `ComparePage`.
- Tests: `test/sqlite-repository-trainer-export-import.test.ts` (extend for the new method).

---

### Task 1: `Repository.listSpeciesSummariesForProfile`

**Files:**
- Modify: `src/data/repository.ts`
- Modify: `src/data/in-memory-store.ts`
- Modify: `src/data/sqlite-repository.ts`
- Test: `test/sqlite-repository-trainer-export-import.test.ts`

**Interfaces:**
- Produces: `Repository.listSpeciesSummariesForProfile(profileId: string, filter?: SpeciesFilter): SpeciesSummary[]`, throws `Unknown profile: ${profileId}` for an unknown id (same convention as `exportTrainer`).

- [ ] **Step 1: Add the method to the `Repository` interface**

In `src/data/repository.ts`, add to the `Repository` interface, in the "Trainer/Profile page" section right after `exportTrainer`:

```ts
  /** Same as listSpeciesSummaries, but for an ARBITRARY local profile, not just the current one -- doesn't switch to it. Used by the compare view (Sub-project 7c) to show two profiles' dex grids without disturbing which profile is actually current. Throws for an unknown profileId. */
  listSpeciesSummariesForProfile(profileId: string, filter?: SpeciesFilter): SpeciesSummary[];
```

- [ ] **Step 2: Refactor `listSpeciesSummaries`'s body into a bucket-parameterized helper**

Open `src/data/in-memory-store.ts` and find `listSpeciesSummaries(filter: SpeciesFilter = {}): SpeciesSummary[] { ... }` (currently reads `state.speciesPersonal`/`state.formPersonal` directly). Above the `return { ...repo, ... }`-shaped returned object inside `createInMemoryRepository` (find where the function defines its returned object literal — the one containing `listSpeciesSummaries` as a method), add a new function, defined in the SAME closure scope (so it still has access to `speciesByDexOrder`/`formsBySpecies`/`matchesSearch`/`matchesFieldFilters`, all already defined earlier in `createInMemoryRepository`):

```ts
  function computeSpeciesSummariesForBucket(
    bucket: Pick<PersonalState, "speciesPersonal" | "formPersonal">,
    filter: SpeciesFilter = {},
  ): SpeciesSummary[] {
    return speciesByDexOrder
      .filter((s) => (filter.region ? s.regionSlug === filter.region : true))
      .filter((s) => (filter.search ? matchesSearch(s, filter.search) : true))
      .map((species) => {
        const personal = bucket.speciesPersonal[species.slug] ?? emptySpeciesPersonal(species.slug);
        const forms = formsBySpecies.get(species.slug) ?? [];
        const formPersonals = forms.map((f) => bucket.formPersonal[f.slug] ?? emptyFormPersonal(f.slug));
        const indicators = {} as Record<FormPersonalBooleanField, boolean>;
        for (const field of FORM_PERSONAL_BOOLEAN_FIELDS) {
          indicators[field] = formPersonals.some((fp) => fp[field]);
        }
        return { species, personal, caught: personal.registered, indicators };
      })
      .filter((s) => {
        if (!filter.caught || filter.caught === "all") return true;
        return filter.caught === "caught" ? s.caught : !s.caught;
      })
      .filter((s) => matchesFieldFilters(s.species, s.personal, s.indicators, filter.fieldFilters))
      .map(({ personal: _personal, ...summary }) => summary);
  }
```

Then replace `listSpeciesSummaries`'s existing body with a one-line delegation:

```ts
    listSpeciesSummaries(filter: SpeciesFilter = {}): SpeciesSummary[] {
      return computeSpeciesSummariesForBucket(state, filter);
    },
```

Finally, expose `computeSpeciesSummariesForBucket` so `sqlite-repository.ts` can call it against an arbitrary bucket. Find where `createInMemoryRepository` returns its object (the `return { ...methods... }` at the end of the function) and add the new function as an EXTRA property alongside the methods already there (it is intentionally not part of the public `Repository` type — `sqlite-repository.ts` accesses it directly off the object `createInMemoryRepository` returns, the same way it already accesses `repo.importPersonalData`/`repo.setSpeciesPersonalField`/etc.):

```ts
  return {
    // ... existing methods unchanged ...
    computeSpeciesSummariesForBucket,
  };
```

- [ ] **Step 3: Implement the new method in `sqlite-repository.ts`**

In `src/data/sqlite-repository.ts`, add to the returned repository object (alongside `exportTrainer`, which you can use as a direct template — same "look up in `profileBuckets`, throw if missing" shape):

```ts
    listSpeciesSummariesForProfile(profileId: string, filter?: SpeciesFilter): SpeciesSummary[] {
      const bucket = profileBuckets.get(profileId);
      if (!bucket) throw new Error(`Unknown profile: ${profileId}`);
      return repo.computeSpeciesSummariesForBucket(bucket, filter);
    },
```

(`repo` here is the same `const repo = createInMemoryRepository(...)` object already in scope in this file, used by every other delegating override — e.g. `importPersonalData`'s override calls `repo.importPersonalData(data)`.)

- [ ] **Step 4: Test it**

Add to `test/sqlite-repository-trainer-export-import.test.ts` (open the file first — it already has the `DatabaseSync`/`REFERENCE_SCHEMA_SQL`/`nodeSqliteConnection`/`createSqliteRepository` boilerplate pattern to follow, and a `bulbasaur`/`bulbasaur-standard-male` fixture is already seeded by an earlier test in this file, or seed it the same way if this is a fresh block):

```ts
test("listSpeciesSummariesForProfile reads a non-current profile's data without switching to it", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const original = repo.getCurrentProfile();
  const second = await repo.createProfile("Second", null);
  repo.switchProfile(second.id);
  repo.setSpeciesPersonalField("bulbasaur", "registered", true);
  repo.switchProfile(original.id);

  const summaries = repo.listSpeciesSummariesForProfile(second.id, { search: "bulbasaur" });
  const bulbasaur = summaries.find((s) => s.species.slug === "bulbasaur");
  assert.equal(bulbasaur?.caught, true, "must reflect the SECOND profile's data");
  assert.equal(repo.getCurrentProfile().id, original.id, "must not switch the current profile");
});

test("listSpeciesSummariesForProfile throws for an unknown profileId", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);
  assert.throws(() => repo.listSpeciesSummariesForProfile("not-a-real-id"), /Unknown profile/);
});
```

Run: `npx tsc -b && npm test`. Expected: passes, no regressions (baseline is 118/118 before this task).

- [ ] **Step 5: Commit**

```bash
git add src/data/repository.ts src/data/in-memory-store.ts src/data/sqlite-repository.ts test/sqlite-repository-trainer-export-import.test.ts
git commit -m "Add listSpeciesSummariesForProfile for reading a non-current profile's dex data"
```

---

### Task 2: Extract a shared, read-only-capable tile-grid component

**Files:**
- Create: `src/features/data-entry/SpeciesTileGrid.vue`
- Modify: `src/features/data-entry/DexGridPage.vue`

**Interfaces:**
- Produces: `SpeciesTileGrid.vue` — props `{ sections: RegionSection[]; indicatorSelection: FormPersonalBooleanField[]; readOnly: boolean; selectMode?: boolean; isSelected?: (summary: SpeciesSummary) => boolean; onToggleRegion: (slug: string) => void; onTileClick?: (summary: SpeciesSummary) => void; effectiveCaught?: (summary: SpeciesSummary) => boolean; onToggleRegistered?: (summary: SpeciesSummary) => void }`. `RegionSection` moves from being a private interface inside `DexGridPage.vue` to being exported from the new file so both files can reference the same shape.

- [ ] **Step 1: Create `SpeciesTileGrid.vue`**

This extracts the region/tile-rendering block from `DexGridPage.vue`'s template (the `<template v-for="section in sections">...</template>` block, currently lines ~166-200) into its own component, with a `readOnly` mode that hides the registered-toggle button and select-check overlay and makes tile clicks a no-op.

```vue
<!--
  Shared species-tile-grid renderer, extracted from DexGridPage.vue so the
  same tile markup/styling is used by both the real Dex page (interactive)
  and the compare view (Sub-project 7c, read-only) -- see
  docs/superpowers/specs/2026-07-26-sub-project-7c-compare-view-design.md
  section 3. Any future visual change to a tile applies to both automatically.
-->
<script setup lang="ts">
import type { SpeciesSummary } from "../../data/repository";
import type { FormPersonalBooleanField } from "../../db/types";
import { speciesSpritePath } from "../../ui/sprites";
import { INDICATOR_LABELS } from "./indicator-labels";

export interface RegionSection {
  slug: string;
  name: string;
  collapsed: boolean;
  summaries: SpeciesSummary[];
}

const props = withDefaults(
  defineProps<{
    sections: RegionSection[];
    indicatorSelection: FormPersonalBooleanField[];
    readOnly: boolean;
    selectMode?: boolean;
    isSelected?: (summary: SpeciesSummary) => boolean;
    onToggleRegion: (slug: string) => void;
    onTileClick?: (summary: SpeciesSummary) => void;
    effectiveCaught?: (summary: SpeciesSummary) => boolean;
    onToggleRegistered?: (summary: SpeciesSummary) => void;
  }>(),
  { selectMode: false, isSelected: () => false, onTileClick: undefined, effectiveCaught: undefined, onToggleRegistered: undefined },
);

function badgesFor(summary: SpeciesSummary) {
  return props.indicatorSelection.filter((field) => summary.indicators[field]);
}

function caughtFor(summary: SpeciesSummary): boolean {
  return props.effectiveCaught ? props.effectiveCaught(summary) : summary.caught;
}

function handleTileClick(summary: SpeciesSummary) {
  if (props.readOnly) return;
  props.onTileClick?.(summary);
}

const anyResults = props.sections.length > 0;
</script>

<template>
  <template v-for="section in sections" :key="section.slug">
    <button type="button" class="region-header" @click="onToggleRegion(section.slug)">
      <span class="region-collapse-caret">{{ section.collapsed ? "▶" : "▼" }}</span>
      <span>{{ section.name }} ({{ section.summaries.length }})</span>
    </button>

    <div v-if="!section.collapsed" class="species-grid">
      <div v-for="summary in section.summaries" :key="summary.species.slug" class="species-tile-wrap">
        <button
          type="button"
          :class="['species-tile', { uncaught: !caughtFor(summary), selected: !readOnly && isSelected(summary) }]"
          @click="handleTileClick(summary)"
        >
          <div class="badge-row">
            <span v-for="field in badgesFor(summary)" :key="field" class="badge" :title="INDICATOR_LABELS[field].full">
              {{ INDICATOR_LABELS[field].badge }}
            </span>
          </div>
          <span v-if="!readOnly && selectMode" :class="['select-check', { on: isSelected(summary) }]">{{ isSelected(summary) ? "✓" : "" }}</span>
          <img class="species-sprite" :src="speciesSpritePath(summary.species.dexNumber)" alt="" loading="lazy" />
        </button>
        <button
          v-if="!readOnly && !selectMode"
          type="button"
          :class="['registered-toggle', { on: caughtFor(summary) }]"
          :aria-pressed="String(caughtFor(summary))"
          :aria-label="`Registered: ${caughtFor(summary) ? 'on' : 'off'}`"
          @click.stop="onToggleRegistered?.(summary)"
        >
          {{ caughtFor(summary) ? "✓" : "" }}
        </button>
        <div class="tile-label"><span class="dex-num">#{{ summary.species.dexNumber }}</span> {{ summary.species.name }}</div>
      </div>
    </div>
  </template>

  <p v-if="!anyResults" class="empty-state">No Pokémon match that search/filter.</p>
</template>
```

- [ ] **Step 2: Refactor `DexGridPage.vue` to use the new component**

In `src/features/data-entry/DexGridPage.vue`, remove the local `RegionSection` interface (now imported from `SpeciesTileGrid.vue` instead), import the new component, and replace the extracted template block. Change:

```ts
import type { Repository, SpeciesSummary } from "../../data/repository";
```

to also import the new component and its exported type:

```ts
import type { Repository, SpeciesSummary } from "../../data/repository";
import SpeciesTileGrid, { type RegionSection } from "./SpeciesTileGrid.vue";
```

Remove the local `interface RegionSection { ... }` block entirely (now imported).

In the template, replace this entire block:

```html
    <template v-for="section in sections" :key="section.slug">
      <button type="button" class="region-header" @click="props.callbacks.onToggleRegion(section.slug)">
        <span class="region-collapse-caret">{{ section.collapsed ? "▶" : "▼" }}</span>
        <span>{{ section.name }} ({{ section.summaries.length }})</span>
      </button>

      <div v-if="!section.collapsed" class="species-grid">
        <div v-for="summary in section.summaries" :key="summary.species.slug" class="species-tile-wrap">
          <button
            type="button"
            :class="['species-tile', { uncaught: !effectiveCaught(summary), selected: isSelected(summary) }]"
            @click="onTileClick(summary)"
          >
            <div class="badge-row">
              <span v-for="field in badgesFor(summary)" :key="field" class="badge" :title="INDICATOR_LABELS[field].full">
                {{ INDICATOR_LABELS[field].badge }}
              </span>
            </div>
            <span v-if="state.selectMode" :class="['select-check', { on: isSelected(summary) }]">{{ isSelected(summary) ? "✓" : "" }}</span>
            <img class="species-sprite" :src="speciesSpritePath(summary.species.dexNumber)" alt="" loading="lazy" />
          </button>
          <button
            v-if="!state.selectMode"
            type="button"
            :class="['registered-toggle', { on: effectiveCaught(summary) }]"
            :aria-pressed="String(effectiveCaught(summary))"
            :aria-label="`Registered: ${effectiveCaught(summary) ? 'on' : 'off'}`"
            @click.stop="toggleRegistered(summary)"
          >
            {{ effectiveCaught(summary) ? "✓" : "" }}
          </button>
          <div class="tile-label"><span class="dex-num">#{{ summary.species.dexNumber }}</span> {{ summary.species.name }}</div>
        </div>
      </div>
    </template>

    <p v-if="!anyResults" class="empty-state">No Pokémon match that search/filter.</p>
```

with:

```html
    <SpeciesTileGrid
      :sections="sections"
      :indicator-selection="indicatorSelection"
      :read-only="false"
      :select-mode="state.selectMode"
      :is-selected="isSelected"
      :on-toggle-region="props.callbacks.onToggleRegion"
      :on-tile-click="onTileClick"
      :effective-caught="effectiveCaught"
      :on-toggle-registered="toggleRegistered"
    />
```

Now `badgesFor`, `INDICATOR_LABELS` import, and `speciesSpritePath` import are unused inside `DexGridPage.vue`'s own `<script setup>` (they moved into `SpeciesTileGrid.vue`) — remove the now-dead `badgesFor` function and the now-unused `INDICATOR_LABELS`/`speciesSpritePath` imports from `DexGridPage.vue`'s script block. `anyResults` also moves into `SpeciesTileGrid.vue` (it now computes its own `anyResults` from `sections.length`) — remove `DexGridPage.vue`'s own `anyResults` computed AND its one other usage (the `<p v-if="!anyResults">` line, already removed above as part of the block replacement) — check there's no other reference to `anyResults` left in `DexGridPage.vue` before removing the computed.

- [ ] **Step 3: Verify the Dex page still works identically**

Since `.vue` files aren't covered by `tsc -b`, verify via the dev-server-fetch method already established in this codebase (see `.superpowers/sdd/progress.md`'s Sub-project 7a Task 10 entry for the exact technique): start `npm run dev:vite`, fetch `/features/data-entry/DexGridPage.vue` and `/features/data-entry/SpeciesTileGrid.vue` via curl, and confirm the compiled SFC output resolves every template binding to a real script symbol with no compile errors. Also run:

```bash
npx tsc -b && npm test && npm run lint
```

Expected: all clean (this is a pure extraction, no `.ts` file logic changed — `tsc`/tests should show zero difference from before this task).

- [ ] **Step 4: Commit**

```bash
git add src/features/data-entry/SpeciesTileGrid.vue src/features/data-entry/DexGridPage.vue
git commit -m "Extract SpeciesTileGrid.vue from DexGridPage.vue for reuse by the compare view"
```

---

### Task 3: Extract the shared bundle-import flow + build the compare filter bar

**Files:**
- Modify: `src/features/settings/personal-data-transfer.ts`
- Modify: `src/features/settings/SettingsPage.vue`
- Create: `src/features/compare/CompareFilterBar.vue`

**Interfaces:**
- Produces: `importTrainerBundleFile(repo: Repository, file: File): Promise<TrainerImportSummary>` (throws on read/parse errors or a schema mismatch the user declines). `CompareFilterBar.vue` — props `{ modelValue: SpeciesFilter }`, emits `update:modelValue`.

- [ ] **Step 1: Extract `importTrainerBundleFile` in `personal-data-transfer.ts`**

Open `src/features/settings/SettingsPage.vue` and find `onImportFileChange` (the function reading a file, checking `schemaMismatch`, calling `planTrainerImport`, prompting per `ask-merge-or-separate` entry, then calling `applyTrainerImport`). Move the read-through-apply portion (everything between reading the file and getting back a `summary`, EXCLUDING the Settings-specific `backupBeforeImport`/`onExportAll()` step, which stays in `SettingsPage.vue` since it's a Settings-only persistent preference) into `src/features/settings/personal-data-transfer.ts`:

```ts
import type { Repository, TrainerImportSummary } from "../../data/repository";

/**
 * Reads a picked file, runs 7b's reconciliation flow (prompting the user via
 * window.confirm for any trainer that matched an existing local profile by
 * name only -- see planTrainerImport/applyTrainerImport), and applies the
 * import. Shared by Settings' "Import personal data" and the compare view's
 * "Import a trainer" button (Sub-project 7c) -- one import code path
 * regardless of caller, per design spec section 2.
 */
export async function importTrainerBundleFile(repo: Repository, file: File): Promise<TrainerImportSummary> {
  const { bundle, schemaMismatch } = await readExportBundleFile(file, repo);
  if (schemaMismatch) {
    const proceed = window.confirm(
      `This export is from schema version ${bundle.schemaVersion}, but this app is on version ${CURRENT_PERSONAL_SCHEMA_VERSION}. Some fields may not match. Import anyway?`,
    );
    if (!proceed) throw new Error("Import cancelled.");
  }

  const plan = await repo.planTrainerImport(bundle);
  const resolutions: Record<string, "merge" | "separate"> = {};
  for (const entry of plan.entries) {
    if (entry.decision.kind !== "ask-merge-or-separate") continue;
    const merge = window.confirm(
      `"${entry.trainerName}" matches an existing local trainer with the same name. Merge them as one trainer? (Cancel treats them as two separate trainers.)`,
    );
    resolutions[entry.trainerUuid] = merge ? "merge" : "separate";
  }

  return repo.applyTrainerImport(bundle, resolutions);
}
```

(Check the exact current imports at the top of `personal-data-transfer.ts` — `CURRENT_PERSONAL_SCHEMA_VERSION` and `readExportBundleFile` are almost certainly already imported/defined in this file per Sub-project 7b; add `TrainerImportSummary` to the existing `import type { ExportBundle, PersonalDataExport, Repository } from "../../data/repository";` line rather than a new import statement.)

- [ ] **Step 2: Update `SettingsPage.vue` to call the extracted helper**

Replace `onImportFileChange`'s body (everything from `readExportBundleFile` through `applyTrainerImport`) with a call to the new helper, keeping the file-picking, schema-mismatch handling that's now INSIDE the helper (so remove that duplicated logic here), backup-before-import, and status-message logic in place:

```ts
async function onImportFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    if (backupBeforeImport.value) {
      status.value = "Saving a backup of your current data first…";
      await onExportAll();
    }
    status.value = "Importing…";
    const summary = await importTrainerBundleFile(props.repo, file);
    status.value = `Imported: ${summary.merged} merged, ${summary.promoted} promoted, ${summary.created} created as new, ${summary.separate} kept separate.`;
  } catch (err) {
    status.value = `Import failed: ${(err as Error).message}`;
  }
}
```

Add `importTrainerBundleFile` to the existing `import { buildExportBundle, downloadTextFile, readExportBundleFile } from "./personal-data-transfer";` line. Remove the now-unused `readExportBundleFile`/`CURRENT_PERSONAL_SCHEMA_VERSION`-in-this-function references if `CURRENT_PERSONAL_SCHEMA_VERSION` is still used elsewhere in this file (check — it's also displayed in the "About" fieldset per the file's existing template, so the import itself likely stays, just this one usage site changes).

- [ ] **Step 3: Verify Settings' import flow is unchanged**

```bash
npx tsc -b && npm test && npm run lint
```

Expected: all clean, no behavior change (this is a pure extraction — same prompts, same order, same status messages).

- [ ] **Step 4: Build `CompareFilterBar.vue`**

Create `src/features/compare/CompareFilterBar.vue`, following `BulkFormEditPanel.vue`'s established pattern for a Vue-native field-filter-chip control (3-state cycle: unset → include → exclude → unset) with `.filter-chip`/`.filter-chip-active` styling already used throughout this codebase:

```vue
<!--
  Compact, Vue-native filter control for the compare view (Sub-project 7c) --
  NOT a reuse of the vanilla-TS filter sheet (grid-types.ts), which is tied to
  main.ts's own GridState/DOM machinery and isn't portable into a Vue
  component. Reuses the same SpeciesFilter/GridFilterField TYPES and the same
  .filter-chip visual language BulkFormEditPanel.vue already established for
  an equivalent field-filter-chip control.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { GridFilterField, SpeciesFilter } from "../../data/repository";
import { MORE_FILTER_FIELDS, gridFilterFieldLabel } from "../data-entry/indicator-labels";

const props = defineProps<{ modelValue: SpeciesFilter }>();
const emit = defineEmits<{ "update:modelValue": [SpeciesFilter] }>();

function update(patch: Partial<SpeciesFilter>) {
  emit("update:modelValue", { ...props.modelValue, ...patch });
}

const searchText = computed({
  get: () => props.modelValue.search ?? "",
  set: (value: string) => update({ search: value }),
});

const CAUGHT_OPTIONS: { value: NonNullable<SpeciesFilter["caught"]>; label: string }[] = [
  { value: "all", label: "All" },
  { value: "caught", label: "Caught" },
  { value: "uncaught", label: "Uncaught" },
];

function fieldChipClass(field: GridFilterField): string {
  const current = props.modelValue.fieldFilters?.[field];
  return current === "include" ? "filter-chip-include" : current === "exclude" ? "filter-chip-exclude" : "";
}

function cycleFieldFilter(field: GridFilterField) {
  const current = props.modelValue.fieldFilters?.[field];
  const fieldFilters = { ...props.modelValue.fieldFilters };
  if (current === undefined) fieldFilters[field] = "include";
  else if (current === "include") fieldFilters[field] = "exclude";
  else delete fieldFilters[field];
  update({ fieldFilters });
}
</script>

<template>
  <div class="compare-filter-bar">
    <input class="search-input" type="search" placeholder="Search species…" v-model="searchText" />
    <div class="theme-options">
      <button
        v-for="opt in CAUGHT_OPTIONS"
        :key="opt.value"
        type="button"
        :class="['filter-chip', { 'filter-chip-active': (modelValue.caught ?? 'all') === opt.value }]"
        @click="update({ caught: opt.value })"
      >
        {{ opt.label }}
      </button>
    </div>
    <div class="theme-options">
      <button
        v-for="field in MORE_FILTER_FIELDS"
        :key="field"
        type="button"
        :class="['filter-chip', fieldChipClass(field)]"
        :title="gridFilterFieldLabel(field).full"
        @click="cycleFieldFilter(field)"
      >
        {{ gridFilterFieldLabel(field).badge }}
      </button>
    </div>
  </div>
</template>
```

(Check `src/style.css` for the real `.filter-chip-include`/`.filter-chip-exclude` class names — `BulkFormEditPanel.vue`'s `fieldChipState`/`stateClass` logic you already read uses exactly these two class names; confirm they exist in `style.css` and are styled, no new CSS needed if so. `.search-input`/`.theme-options` classes are also already used elsewhere in this codebase, per `CollectionPage.vue`/`SettingsPage.vue` — reused here, no new CSS.)

- [ ] **Step 5: Commit**

```bash
git add src/features/settings/personal-data-transfer.ts src/features/settings/SettingsPage.vue src/features/compare/CompareFilterBar.vue
git commit -m "Extract shared bundle-import helper; add the compare view's filter bar"
```

---

### Task 4: `ComparePage.vue`, route, and nav entry

**Files:**
- Create: `src/features/compare/ComparePage.vue`
- Modify: `src/app-shell/router.ts`
- Modify: `src/app-shell/nav-drawer.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `Repository.listProfiles`, `listSpeciesSummariesForProfile` (Task 1), `SpeciesTileGrid.vue` (Task 2), `CompareFilterBar.vue`/`importTrainerBundleFile` (Task 3).

- [ ] **Step 1: Add the route**

In `src/app-shell/router.ts`, add to the `Route` union:

```ts
  | { name: "compare" }
```

Add to `parseRoute`'s `switch (path)` block (alongside the other simple string-match cases, e.g. right after the `"/trainer"` case):

```ts
    case "/compare":
      return { name: "compare" };
```

- [ ] **Step 2: Add the nav entry**

In `src/app-shell/nav-drawer.ts`, add to `NAV_ITEMS` (not marked `primary`, alongside `Trainer`/`Tags`):

```ts
  { label: "Compare", path: "/compare", routeName: "compare", icon: "⇄" },
```

- [ ] **Step 3: Create `ComparePage.vue`**

```vue
<!--
  Sub-project 7c: dex/collection compare view. Two local profiles' filtered
  dex grids side by side, sharing one filter bar -- see
  docs/superpowers/specs/2026-07-26-sub-project-7c-compare-view-design.md.
  Explicitly NOT a stats comparison (see that doc's section 6).
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { Repository, SpeciesFilter } from "../../data/repository";
import SpeciesTileGrid, { type RegionSection } from "../data-entry/SpeciesTileGrid.vue";
import CompareFilterBar from "./CompareFilterBar.vue";
import { importTrainerBundleFile } from "../settings/personal-data-transfer";

const props = defineProps<{ repo: Repository }>();

const profiles = ref(props.repo.listProfiles());
const leftProfileId = ref(props.repo.getCurrentProfile().id);
const rightProfileId = ref(profiles.value.find((p) => p.id !== leftProfileId.value)?.id ?? leftProfileId.value);

const filter = ref<SpeciesFilter>({ caught: "all" });

const collapsedRegions = ref<Set<string>>(new Set());
function toggleRegion(slug: string) {
  const next = new Set(collapsedRegions.value);
  if (next.has(slug)) next.delete(slug);
  else next.add(slug);
  collapsedRegions.value = next;
}

function sectionsFor(profileId: string): RegionSection[] {
  const out: RegionSection[] = [];
  for (const region of props.repo.listRegions()) {
    const summaries = props.repo.listSpeciesSummariesForProfile(profileId, { ...filter.value, region: region.slug });
    if (summaries.length === 0) continue;
    out.push({ slug: region.slug, name: region.name, collapsed: collapsedRegions.value.has(region.slug), summaries });
  }
  return out;
}

const leftSections = computed(() => sectionsFor(leftProfileId.value));
const rightSections = computed(() => sectionsFor(rightProfileId.value));
const indicatorSelection = computed(() => props.repo.getIndicatorSelection());

const importStatus = ref("");
async function onImportFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    importStatus.value = "Importing…";
    const summary = await importTrainerBundleFile(props.repo, file);
    importStatus.value = `Imported: ${summary.merged} merged, ${summary.promoted} promoted, ${summary.created} created as new, ${summary.separate} kept separate.`;
    profiles.value = props.repo.listProfiles();
  } catch (err) {
    importStatus.value = `Import failed: ${(err as Error).message}`;
  }
}
</script>

<template>
  <h2>Compare</h2>

  <div class="input-grid">
    <label class="field">
      Left
      <select v-model="leftProfileId">
        <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.username }}</option>
      </select>
    </label>
    <label class="field">
      Right
      <select v-model="rightProfileId">
        <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.username }}</option>
      </select>
    </label>
    <label class="toggle-row">
      Import a trainer…
      <input type="file" accept="application/json" @change="onImportFileChange" />
    </label>
  </div>
  <p class="gap-note" aria-live="polite">{{ importStatus }}</p>

  <CompareFilterBar v-model="filter" />

  <div class="compare-columns">
    <div class="compare-column">
      <SpeciesTileGrid :sections="leftSections" :indicator-selection="indicatorSelection" :read-only="true" :on-toggle-region="toggleRegion" />
    </div>
    <div class="compare-column">
      <SpeciesTileGrid :sections="rightSections" :indicator-selection="indicatorSelection" :read-only="true" :on-toggle-region="toggleRegion" />
    </div>
  </div>
</template>
```

- [ ] **Step 4: Add minimal CSS for the two-column layout**

In `src/style.css`, check the existing `≥768px` desktop breakpoint convention (search for an existing `@media (min-width: 768px)` block to match its exact syntax) and add:

```css
.compare-columns {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.compare-column {
  flex: 1;
  min-width: 0;
}
@media (min-width: 768px) {
  .compare-columns {
    flex-direction: row;
  }
}
```

- [ ] **Step 5: Wire the route in `main.ts`**

Open `src/main.ts` and find the `switch`/route-handling block where other simple pages are mounted (e.g. the `"trainer"` case: `mountVueRoute(contentEl, TrainerPage, { repo });`). Add an import at the top:

```ts
import ComparePage from "./features/compare/ComparePage.vue";
```

Add a case alongside the others:

```ts
        case "compare":
          mountVueRoute(contentEl, ComparePage, { repo });
          break;
```

(Match the exact surrounding `switch` structure — check whether each case needs its own `renderHeader(...)` call the way the `"none"`-kind header cases nearby do, per the pattern the `"trainer"`/`"tags"`/`"collection"` cases already follow, and add `"compare"` to `ROUTE_TITLES` at the top of the file the same way those routes are: `ROUTE_TITLES` maps `Route["name"]` to a display title — add `compare: "Compare"`.)

- [ ] **Step 6: Verify end-to-end**

```bash
npx tsc -b && npm test && npm run lint && npx vite build
```

Expected: all clean. Since `.vue` files aren't `tsc`-checked, also do the dev-server-fetch verification (start `npm run dev:vite`, fetch `/features/compare/ComparePage.vue` and `/features/compare/CompareFilterBar.vue`, confirm the compiled SFC output resolves every template binding to a real script symbol with no errors) — same technique as Task 2's Step 3.

- [ ] **Step 7: Commit**

```bash
git add src/features/compare/ComparePage.vue src/app-shell/router.ts src/app-shell/nav-drawer.ts src/main.ts src/style.css
git commit -m "Add the compare view: /compare route, two-profile dex comparison"
```

---

### Task 5: Docs and final verification

**Files:**
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Update the roadmap**

In `docs/roadmap.md`'s Phase 2 section, find the "Sub-project 7c's scope" paragraph and mark it complete, following the same pattern used for 7a/7b's completion notes (a short "is complete" sentence naming what shipped: the `/compare` route, shared filter bar, `listSpeciesSummariesForProfile`, the extracted `SpeciesTileGrid`/`importTrainerBundleFile`). Leave the "split off as its own separate future item" stats-compare paragraph unchanged — that's still a real, separate, unscoped item.

- [ ] **Step 2: Full-suite verification**

```bash
npx tsc -b && npm test && npm run lint && npx vite build
```

Expected: all clean, a real `dist/` build succeeds.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md
git commit -m "Mark Sub-project 7c complete in roadmap"
```

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage**: §1 (dex/collection comparison, not stats) → Task 4's `ComparePage.vue` scope and header comment. §2 (entry point, import-a-trainer button) → Task 4. §3 (comparison mechanics: new repo method, read-only grid, shared filter bar) → Tasks 1, 2, 3. §4/§5 (deferred trade UX, independent per-side filters) → intentionally not tasked, already logged in roadmap. §6 (NOT a stats comparison) → explicitly called out in Task 4's `ComparePage.vue` header comment and Task 5's roadmap update, so it isn't silently conflated later.
- **Known deviation from the spec's literal wording**: the design doc says "reusing the existing `SpeciesFilter`/toggle-chip UI from the Dex grid," which turned out (on inspecting the real code while writing this plan) to mean a vanilla-TS filter sheet tied to `main.ts`'s own state, not a portable Vue component. Documented explicitly in this plan's Global Constraints section and Task 3 — a new, small Vue-native filter control is built instead, reusing the same types and visual language rather than the literal DOM code.
- **Type consistency check**: `RegionSection` is defined once (Task 2, in `SpeciesTileGrid.vue`) and imported by both `DexGridPage.vue` (Task 2) and `ComparePage.vue` (Task 4) — not redefined. `SpeciesFilter`/`GridFilterField` names match `repository.ts`'s real exports throughout. `importTrainerBundleFile`'s signature (Task 3) matches how both `SettingsPage.vue` (Task 3) and `ComparePage.vue` (Task 4) call it.
