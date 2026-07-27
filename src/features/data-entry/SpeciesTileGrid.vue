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
