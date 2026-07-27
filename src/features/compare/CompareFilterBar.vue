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
import { CLASSIFICATION_FIELDS, MORE_FILTER_FIELDS, gridFilterFieldLabel } from "../data-entry/indicator-labels";

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
        v-for="field in CLASSIFICATION_FIELDS"
        :key="field"
        type="button"
        :class="['filter-chip', fieldChipClass(field)]"
        :title="gridFilterFieldLabel(field).full"
        @click="cycleFieldFilter(field)"
      >
        {{ gridFilterFieldLabel(field).badge }}
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
