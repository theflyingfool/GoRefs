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
