<!--
  Dex grid — Vue port of species-grid.ts's renderSpeciesGrid, now covering
  the full behavior: core tile rendering (Task 6) plus select-mode,
  species-field bulk-apply, the species/form granularity toggle, and the
  Dex-grid FAB (Task 7 — see docs/vue-migration-plan.md).

  props.state is the same GridState object main.ts owns and mutates from the
  header search box / filter sheet (still vanilla TS, per the migration
  plan's Global Constraints) — every callback-driven mutation calls the
  surrounding renderGrid() closure in main.ts, which re-invokes
  mountVueRoute() and so fully remounts this component with the freshly-
  mutated state. That's true for every GridCallbacks-driven change
  (onToggleSelectMode/onGranularityChange/onBulkFieldChange/
  onBulkValueChange/onApplyBulk/onClearSelection all trigger a full
  remount in main.ts, same as onCaughtFilterChange etc already did in Task
  6). The one exception is tapping a tile to select/deselect it while in
  select mode: species-grid.ts deliberately mutates state.selectedSpecies
  in place WITHOUT calling back into main.ts, to avoid a full grid rebuild
  (possibly 1000+ tiles) on every tap — this component preserves that by
  mutating props.state.selectedSpecies (the same Set main.ts's
  onApplyBulk/onClearSelection read) directly, then bumping a local
  `selectionVersion` ref to re-render just this component in place.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { Repository, SpeciesSummary } from "../../data/repository";
import { navigate } from "../../app-shell/router";
import { SPECIES_FIELDS } from "./field-groups";
import type { GridCallbacks, GridState, SpeciesBulkField } from "./grid-types";
import BulkFormEditPanel from "./BulkFormEditPanel.vue";
import SpeciesTileGrid, { type RegionSection } from "./SpeciesTileGrid.vue";

const props = defineProps<{ repo: Repository; state: GridState; callbacks: GridCallbacks }>();

const indicatorSelection = computed(() => props.repo.getIndicatorSelection());

const sections = computed<RegionSection[]>(() => {
  const out: RegionSection[] = [];
  for (const region of props.repo.listRegions()) {
    const summaries = props.repo.listSpeciesSummaries({
      region: region.slug,
      search: props.state.filterText,
      caught: props.state.caughtFilter,
      fieldFilters: props.state.fieldFilters,
    });
    if (summaries.length === 0) continue;
    out.push({ slug: region.slug, name: region.name, collapsed: props.state.collapsedRegions.has(region.slug), summaries });
  }
  return out;
});

// Registered-toggle click patches this tile's own visual state in place
// instead of re-querying listSpeciesSummaries() — same tradeoff
// species-grid.ts's renderSpeciesGrid makes: if the current Caught/Uncaught
// filter would now exclude this tile, it stays visible (with its badge/class
// flipped) until the next full requery (a search/filter change or
// navigation), rather than paying for a requery on every tap.
const registeredOverrides = ref<Map<string, boolean>>(new Map());
function effectiveCaught(summary: SpeciesSummary): boolean {
  return registeredOverrides.value.get(summary.species.slug) ?? summary.caught;
}
function toggleRegistered(summary: SpeciesSummary) {
  const next = !effectiveCaught(summary);
  props.repo.setSpeciesPersonalField(summary.species.slug, "registered", next);
  const overrides = new Map(registeredOverrides.value);
  overrides.set(summary.species.slug, next);
  registeredOverrides.value = overrides;
}

// ---- Select mode / bulk-apply (species granularity) ----
// See the module comment above for why this mutates props.state directly
// instead of going through a callback.
const selectionVersion = ref(0);
function isSelected(summary: SpeciesSummary): boolean {
  void selectionVersion.value; // establish reactive dependency
  return props.state.selectMode && props.state.selectedSpecies.has(summary.species.slug);
}
function selectedCount(): number {
  void selectionVersion.value;
  return props.state.selectedSpecies.size;
}
function onTileClick(summary: SpeciesSummary) {
  if (!props.state.selectMode) {
    props.callbacks.onSelectSpecies(summary.species.slug);
    return;
  }
  const slug = summary.species.slug;
  if (props.state.selectedSpecies.has(slug)) props.state.selectedSpecies.delete(slug);
  else props.state.selectedSpecies.add(slug);
  selectionVersion.value++;
}

function onBulkFieldChange(e: Event) {
  props.callbacks.onBulkFieldChange((e.target as HTMLSelectElement).value as SpeciesBulkField);
}
</script>

<template>
  <div class="grid-select-toolbar">
    <button
      type="button"
      :class="['filter-chip', { 'filter-chip-active': state.selectMode }]"
      :aria-pressed="String(state.selectMode)"
      @click="callbacks.onToggleSelectMode()"
    >
      {{ state.selectMode ? "✓ Selecting" : "Select" }}
    </button>
    <template v-if="state.selectMode">
      <div class="segmented" style="margin: 0; flex-shrink: 0">
        <button type="button" :aria-selected="String(state.bulkGranularity === 'species')" @click="callbacks.onGranularityChange('species')">
          Species fields
        </button>
        <button type="button" :aria-selected="String(state.bulkGranularity === 'form')" @click="callbacks.onGranularityChange('form')">
          Form fields
        </button>
      </div>
      <span v-if="state.bulkGranularity === 'species'" class="grid-select-hint">Tap tiles to select, then choose a field to set.</span>
    </template>
  </div>

  <BulkFormEditPanel v-if="state.selectMode && state.bulkGranularity === 'form'" :repo="repo" />

  <template v-else>
    <div v-if="state.selectMode && selectedCount() > 0" class="bulk-action-bar">
      <span class="bulk-count">{{ selectedCount() }} selected</span>
      <span class="bulk-set-label">Set</span>
      <select class="bulk-field-select" aria-label="Field to set" :value="state.bulkField" @change="onBulkFieldChange">
        <option v-for="{ field, label } in SPECIES_FIELDS" :key="field" :value="field">{{ label }}</option>
      </select>
      <div class="bulk-onoff">
        <button
          type="button"
          :class="['filter-chip', { 'filter-chip-active': state.bulkValue === true }]"
          :aria-pressed="String(state.bulkValue === true)"
          @click="callbacks.onBulkValueChange(true)"
        >
          On
        </button>
        <button
          type="button"
          :class="['filter-chip', { 'filter-chip-active': state.bulkValue === false }]"
          :aria-pressed="String(state.bulkValue === false)"
          @click="callbacks.onBulkValueChange(false)"
        >
          Off
        </button>
      </div>
      <button type="button" class="bulk-apply-button" @click="callbacks.onApplyBulk()">Apply to {{ selectedCount() }}</button>
      <button type="button" class="bulk-clear-button" @click="callbacks.onClearSelection()">Clear</button>
    </div>

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

    <button type="button" class="fab" @click="navigate('/log-catch')">+ Log a catch</button>
  </template>
</template>
