<!--
  Browses pokemon_instance directly — what you actually hold, independent of
  the Dex grid's per-species achievement completion (duplicates, traded-away,
  and un-registered forms all show up here too). See docs/vue-migration-plan.md.

  Scale note: this filters/sorts/paginates over the in-memory cache, same
  pattern as every other screen today — NOT the dedicated parameterized-SQL
  approach the migration plan flagged as the real fix for 12,000+ specimens.
  That upgrade is still outstanding; this is a working but not yet
  scale-proven implementation.
-->
<script setup lang="ts">
import { ref, watch } from "vue";
import type { PokemonInstanceSort, Repository } from "../../data/repository";
import type { PokemonInstanceStatus } from "../../db/types";
import { formSpritePath } from "../../ui/sprites";
import { editInstancePath, navigate } from "../../app-shell/router";

const props = defineProps<{ repo: Repository }>();

const PAGE_SIZE = 30;

const search = ref("");
const status = ref<PokemonInstanceStatus | "all">("all");
const sort = ref<PokemonInstanceSort>("recent");
const tagId = ref<number | undefined>(undefined);
const offset = ref(0);

const tags = ref(props.repo.listTags());

function currentFilter() {
  return { search: search.value, status: status.value, sort: sort.value, tagId: tagId.value };
}

const rows = ref(props.repo.listPokemonInstances({ ...currentFilter(), limit: PAGE_SIZE, offset: 0 }));
const total = ref(props.repo.countPokemonInstances(currentFilter()));

function reload() {
  offset.value = 0;
  rows.value = props.repo.listPokemonInstances({ ...currentFilter(), limit: PAGE_SIZE, offset: 0 });
  total.value = props.repo.countPokemonInstances(currentFilter());
}

function loadMore() {
  offset.value += PAGE_SIZE;
  rows.value = [...rows.value, ...props.repo.listPokemonInstances({ ...currentFilter(), limit: PAGE_SIZE, offset: offset.value })];
}

watch([search, status, sort, tagId], reload);

const openActionsFor = ref<number | null>(null);
function toggleActions(id: number) {
  openActionsFor.value = openActionsFor.value === id ? null : id;
}

async function setStatus(id: number, next: PokemonInstanceStatus) {
  await props.repo.setPokemonInstanceStatus(id, next);
  reload();
  openActionsFor.value = null;
}

function editInstance(id: number) {
  navigate(editInstancePath(id));
}
</script>

<template>
  <h2>Collection</h2>
  <p class="gap-note">{{ total }} specimen{{ total === 1 ? "" : "s" }} logged — this is what you hold, not what's checked off in the dex.</p>

  <div class="collection-filters">
    <input class="search-input" type="search" placeholder="Search species or nickname…" v-model="search" />
    <select v-model="sort">
      <option value="recent">Most recent</option>
      <option value="cpDesc">Highest CP</option>
      <option value="ivDesc">Highest IV%</option>
      <option value="nameAsc">Name A–Z</option>
    </select>
    <select v-model="status">
      <option value="all">All statuses</option>
      <option value="kept">Kept</option>
      <option value="traded">Traded</option>
      <option value="released">Released</option>
      <option value="evolved">Evolved</option>
    </select>
    <select v-model="tagId">
      <option :value="undefined">Any tag</option>
      <option v-for="tag in tags" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
    </select>
  </div>

  <ul class="collection-list">
    <li v-for="row in rows" :key="row.instance.id" class="collection-row">
      <button type="button" class="collection-row-main" @click="toggleActions(row.instance.id)">
        <img class="collection-sprite" :src="formSpritePath(row.form.slug, row.species.dexNumber, row.instance.shiny)" alt="" />
        <span class="collection-name">{{ row.instance.nickname || row.species.name }}</span>
        <span v-if="row.instance.status !== 'kept'" :class="['status-pill', row.instance.status]">{{ row.instance.status }}</span>
        <span class="gap-note">#{{ row.species.dexNumber }} {{ row.form.formName }}</span>
        <span class="collection-stats tabular" v-if="row.instance.cp !== null || row.instance.ivPercent !== null">
          <template v-if="row.instance.cp !== null">{{ row.instance.cp }} CP</template>
          <template v-if="row.instance.ivPercent !== null"> · {{ row.instance.ivPercent }}% IV</template>
        </span>
        <span class="collection-tags" v-if="row.tags.length">
          <span v-for="tag in row.tags" :key="tag.id" class="mini-tag">{{ tag.name }}</span>
        </span>
      </button>
      <div class="collection-actions" v-if="openActionsFor === row.instance.id">
        <button type="button" @click="setStatus(row.instance.id, 'kept')">Mark kept</button>
        <button type="button" @click="setStatus(row.instance.id, 'traded')">Mark traded</button>
        <button type="button" @click="setStatus(row.instance.id, 'released')">Release</button>
        <button type="button" @click="setStatus(row.instance.id, 'evolved')">Mark evolved</button>
        <button type="button" @click="editInstance(row.instance.id)">Edit details</button>
      </div>
    </li>
  </ul>

  <p v-if="rows.length === 0" class="gap-note">No specimens match these filters yet.</p>
  <button type="button" v-if="rows.length < total" @click="loadMore">Load more ({{ rows.length }} / {{ total }})</button>
</template>

<!-- .collection-* classes are styled globally in src/style.css. -->
