<!--
  Edit an individual logged specimen's details -- reached from Collection's
  row-tap action menu ("Edit details" button, see CollectionPage.vue). Status
  changes (kept/traded/released/evolved) stay on Collection's own action
  menu, not duplicated here -- see docs/superpowers/specs/2026-07-24-sub-project-5-collection-dex-tags-design.md.
-->
<script setup lang="ts">
import { ref } from "vue";
import type { Repository, UpdatePokemonInstanceFields } from "../../data/repository";
import { computeIvPercent } from "../../db/types";
import { navigate } from "../../app-shell/router";
import IvComponentInput from "../log-catch/IvComponentInput.vue";

const props = defineProps<{ repo: Repository; instanceId: number }>();

const loaded = props.repo.getPokemonInstance(props.instanceId);
if (!loaded) {
  navigate("/collection");
}

const instance = loaded!.instance;

const nickname = ref(instance.nickname ?? "");
const cp = ref<number | null>(instance.cp);
const ivAttack = ref<number | null>(instance.ivAttack);
const ivDefense = ref<number | null>(instance.ivDefense);
const ivStamina = ref<number | null>(instance.ivStamina);
const shiny = ref(instance.shiny);
const lucky = ref(instance.lucky);
const shadow = ref(instance.shadow);
const purified = ref(instance.purified);
const dynamax = ref(instance.dynamax);
const receivedViaTrade = ref(instance.receivedViaTrade);
const heartsEarned = ref<number | null>(instance.heartsEarned);
const currentMegaLevel = ref<number | null>(instance.currentMegaLevel);
const backgroundSlug = ref<string | null>(instance.backgroundSlug);

const backgrounds = props.repo.listBackgrounds();

const tags = ref(props.repo.listTags());
const selectedTagIds = ref<Set<number>>(new Set(loaded!.tags.map((t) => t.id)));
const newTagName = ref("");

function toggleTag(id: number) {
  if (selectedTagIds.value.has(id)) selectedTagIds.value.delete(id);
  else selectedTagIds.value.add(id);
  selectedTagIds.value = new Set(selectedTagIds.value);
}

async function addNewTag() {
  const name = newTagName.value.trim();
  if (!name) return;
  const tag = await props.repo.createTag(name);
  tags.value = props.repo.listTags();
  selectedTagIds.value = new Set([...selectedTagIds.value, tag.id]);
  newTagName.value = "";
}

const saving = ref(false);
const saveError = ref("");

async function save() {
  saving.value = true;
  saveError.value = "";
  try {
    const fields: UpdatePokemonInstanceFields = {
      nickname: nickname.value.trim() || null,
      cp: cp.value,
      ivAttack: ivAttack.value,
      ivDefense: ivDefense.value,
      ivStamina: ivStamina.value,
      shiny: shiny.value,
      lucky: lucky.value,
      shadow: shadow.value,
      purified: purified.value,
      dynamax: dynamax.value,
      receivedViaTrade: receivedViaTrade.value,
      heartsEarned: heartsEarned.value,
      currentMegaLevel: currentMegaLevel.value,
      backgroundSlug: backgroundSlug.value,
      tagIds: [...selectedTagIds.value],
    };
    await props.repo.updatePokemonInstance(props.instanceId, fields);
    navigate("/collection");
  } catch (err) {
    saveError.value = `Save failed: ${(err as Error).message}`;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <h2>Edit specimen</h2>
  <p class="gap-note" v-if="loaded">{{ loaded.species.name }} — #{{ loaded.species.dexNumber }} {{ loaded.form.formName }}</p>

  <fieldset>
    <legend>Details</legend>
    <div class="input-grid">
      <label class="field">Nickname<input type="text" v-model="nickname" /></label>
      <label class="field">CP<input type="number" v-model.number="cp" /></label>
      <IvComponentInput v-model="ivAttack" label="Attack IV" />
      <IvComponentInput v-model="ivDefense" label="Defense IV" />
      <IvComponentInput v-model="ivStamina" label="Stamina IV" />
      <div class="field" v-if="computeIvPercent(ivAttack, ivDefense, ivStamina) !== null">
        <span class="iv-component-label">IV %</span>
        <span class="tabular">{{ computeIvPercent(ivAttack, ivDefense, ivStamina) }}%</span>
      </div>
      <label class="field">Hearts earned<input type="number" v-model.number="heartsEarned" /></label>
      <label class="field">Current Mega Level<input type="number" v-model.number="currentMegaLevel" /></label>
      <label class="field">
        Background
        <select v-model="backgroundSlug">
          <option :value="null">None</option>
          <option v-for="bg in backgrounds" :key="bg.slug" :value="bg.slug">{{ bg.name }}</option>
        </select>
      </label>
    </div>
  </fieldset>

  <fieldset>
    <legend>State</legend>
    <label class="toggle-row"><input type="checkbox" v-model="shiny" /><span>Shiny</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="lucky" /><span>Lucky</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="shadow" /><span>Shadow</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="purified" /><span>Purified</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="dynamax" /><span>Dynamax</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="receivedViaTrade" /><span>Received via trade</span></label>
  </fieldset>

  <fieldset>
    <legend>Tags</legend>
    <div class="tag-picker">
      <button
        type="button"
        v-for="tag in tags"
        :key="tag.id"
        :class="['tag-chip', { on: selectedTagIds.has(tag.id) }]"
        @click="toggleTag(tag.id)"
      >
        {{ tag.name }}
      </button>
    </div>
    <div class="new-tag-row">
      <input type="text" placeholder="New tag…" v-model="newTagName" @keyup.enter="addNewTag" />
      <button type="button" @click="addNewTag">+ Add tag</button>
    </div>
  </fieldset>

  <p class="gap-note" v-if="saveError" style="color: var(--negative, crimson);">{{ saveError }}</p>
  <button type="button" class="save-button" :disabled="saving" @click="save">Save</button>
</template>
