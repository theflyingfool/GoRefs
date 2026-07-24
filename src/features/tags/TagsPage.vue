<!--
  Browse/rename/delete tags -- fixes the "no list of tags" gap. See
  docs/superpowers/specs/2026-07-24-sub-project-5-collection-dex-tags-design.md
  section 5c. Rename follows the same always-editable-input,
  save-on-@change pattern TrainerPage.vue already uses for trainer
  name/friend code, rather than a separate edit-mode toggle.
-->
<script setup lang="ts">
import { ref } from "vue";
import type { Repository } from "../../data/repository";

const props = defineProps<{ repo: Repository }>();

const rows = ref(props.repo.getTagUsageCounts());
const nameDrafts = ref<Record<number, string>>(Object.fromEntries(rows.value.map((r) => [r.tag.id, r.tag.name])));
// Keyed by tag id -- renameErrors[id] shows an inline message under that
// row's input instead of letting a colliding rename silently no-op (see
// renameTag's UNIQUE(profile_id, name) constraint: the write-queue
// swallows the resulting SQL error, so the promise would otherwise
// resolve as if nothing was wrong).
const renameErrors = ref<Record<number, string>>({});

async function saveRename(id: number) {
  const name = (nameDrafts.value[id] ?? "").trim();
  if (!name) return;
  // Mirror createTag's exact-name dedup (see sqlite-repository.ts) rather
  // than calling renameTag and hoping the DB write fails loudly -- it
  // won't, the write-queue's error handler just logs and moves on.
  const collision = rows.value.find((r) => r.tag.id !== id && r.tag.name === name);
  if (collision) {
    renameErrors.value = { ...renameErrors.value, [id]: `A tag named "${name}" already exists.` };
    return;
  }
  renameErrors.value = { ...renameErrors.value, [id]: "" };
  await props.repo.renameTag(id, name);
  rows.value = props.repo.getTagUsageCounts();
}

async function remove(id: number, name: string) {
  if (!confirm(`Delete tag "${name}"? This removes it from every specimen it's applied to.`)) return;
  await props.repo.deleteTag(id);
  rows.value = props.repo.getTagUsageCounts();
}
</script>

<template>
  <h2>Tags</h2>
  <p class="gap-note" v-if="rows.length === 0">No tags yet — create one from Log a catch's Full details mode.</p>

  <ul class="collection-list">
    <li v-for="row in rows" :key="row.tag.id" class="collection-row">
      <input type="text" v-model="nameDrafts[row.tag.id]" @change="saveRename(row.tag.id)" />
      <span class="gap-note">{{ row.count }} specimen{{ row.count === 1 ? "" : "s" }}</span>
      <button type="button" @click="remove(row.tag.id, row.tag.name)">Delete</button>
      <p class="gap-note" v-if="renameErrors[row.tag.id]" style="color: var(--negative, crimson); width: 100%">{{ renameErrors[row.tag.id] }}</p>
    </li>
  </ul>
</template>
