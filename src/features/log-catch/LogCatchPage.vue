<!--
  Log a catch — Quick mode bulk-adds N identical specimens fast (the "I have
  30 random Pidgey" case pokemon_instance exists for, see schema.ts); Full
  details adds CP/IV/nickname/tags to a single catch. See
  docs/vue-migration-plan.md's Log-a-catch milestone.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { NewPokemonInstanceBatch, Repository } from "../../data/repository";
import { computeIvPercent, type Form, type PokemonInstance, type Species } from "../../db/types";
import { speciesSpritePath } from "../../ui/sprites";
import IvComponentInput from "./IvComponentInput.vue";

// prefillSpeciesSlug: deep-link from the species detail page's Log-a-catch
// FAB (/#/log-catch?species=<slug>, see SpeciesDetailPage.vue and
// router.ts's log-catch route). Optional — plain /#/log-catch (no query)
// starts empty exactly as before.
const props = defineProps<{ repo: Repository; prefillSpeciesSlug?: string }>();

const mode = ref<"quick" | "full">("quick");

const speciesQuery = ref("");
const speciesResults = ref<Species[]>([]);
const selectedSpecies = ref<Species | null>(null);
const formsForSpecies = ref<Form[]>([]);
const selectedFormSlug = ref<string>("");

function searchSpecies() {
  speciesResults.value = props.repo.searchSpecies(speciesQuery.value);
}

function pickSpecies(species: Species) {
  selectedSpecies.value = species;
  speciesResults.value = [];
  speciesQuery.value = species.name;
  formsForSpecies.value = props.repo.getSpeciesWithForms(species.slug).forms.map((f) => f.form);
  selectedFormSlug.value = formsForSpecies.value[0]?.slug ?? "";
}

// A prefill slug that doesn't resolve (stale/hand-typed link) falls back to
// the ordinary empty picker rather than throwing — getSpeciesWithForms
// throws for an unknown slug (see src/data/in-memory-store.ts).
if (props.prefillSpeciesSlug) {
  try {
    pickSpecies(props.repo.getSpeciesWithForms(props.prefillSpeciesSlug).species);
  } catch {
    // Unknown slug — leave the picker empty, same as no prefill at all.
  }
}

const shiny = ref(false);
const lucky = ref(false);
const shadow = ref(false);
const purified = ref(false);
const dynamax = ref(false);
const receivedViaTrade = ref(false);

const quantity = ref(1);
function setQuantity(n: number) {
  quantity.value = Math.max(1, Math.min(500, n));
}

const cp = ref<number | null>(null);
const ivAttack = ref<number | null>(null);
const ivDefense = ref<number | null>(null);
const ivStamina = ref<number | null>(null);
const livePreviewIv = computed(() => computeIvPercent(ivAttack.value, ivDefense.value, ivStamina.value));
const nickname = ref("");
// YYYY-MM-DD, bound to <input type="date"> — a UI-only string, converted to
// epoch-ms at save time (dateInputToEpochMs). Built from local date parts
// (not toISOString(), which is UTC) so today's date always matches what the
// date picker shows regardless of the device's timezone offset.
function todayDateInputValue(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const caughtAt = ref(todayDateInputValue());

// Parses a "YYYY-MM-DD" <input type="date"> value as local midnight, not UTC
// midnight (new Date("2026-07-22") parses as UTC, which reads back as the
// previous day in any timezone west of UTC) — this must round-trip back to
// the same calendar date the user picked.
function dateInputToEpochMs(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

const tags = ref(props.repo.listTags());
const selectedTagIds = ref<Set<number>>(new Set());
const newTagName = ref("");

function toggleTag(id: number) {
  if (selectedTagIds.value.has(id)) selectedTagIds.value.delete(id);
  else selectedTagIds.value.add(id);
  // Set mutation doesn't trigger Vue's reactivity on its own — reassign.
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

const saveLabel = computed(() => {
  if (mode.value === "full") return "Save";
  const n = quantity.value;
  return `Log ${n} ${selectedSpecies.value?.name ?? "specimen"}${n > 1 ? "s" : ""}`;
});

const justLogged = ref<PokemonInstance[] | null>(null);
const saving = ref(false);
const saveError = ref("");

async function save() {
  if (!selectedFormSlug.value) {
    saveError.value = "Pick a species first.";
    return;
  }
  saveError.value = "";
  saving.value = true;
  try {
    const batch: NewPokemonInstanceBatch = {
      formSlug: selectedFormSlug.value,
      count: mode.value === "quick" ? quantity.value : 1,
      shiny: shiny.value,
      lucky: lucky.value,
      shadow: shadow.value,
      purified: purified.value,
      dynamax: dynamax.value,
      receivedViaTrade: receivedViaTrade.value,
      cp: mode.value === "full" ? cp.value : null,
      ivAttack: mode.value === "full" ? ivAttack.value : null,
      ivDefense: mode.value === "full" ? ivDefense.value : null,
      ivStamina: mode.value === "full" ? ivStamina.value : null,
      nickname: mode.value === "full" ? nickname.value || null : null,
      caughtAt: mode.value === "full" ? dateInputToEpochMs(caughtAt.value) : null,
      tagIds: mode.value === "full" ? [...selectedTagIds.value] : [],
    };
    justLogged.value = await props.repo.createPokemonInstances(batch);
  } catch (err) {
    saveError.value = `Save failed: ${(err as Error).message}`;
  } finally {
    saving.value = false;
  }
}

async function quickAction(id: number, status: "traded" | "evolved" | "released") {
  await props.repo.setPokemonInstanceStatus(id, status);
}
</script>

<template>
  <h2>Log a catch</h2>

  <div class="segmented">
    <button type="button" :class="{ active: mode === 'quick' }" @click="mode = 'quick'">Quick</button>
    <button type="button" :class="{ active: mode === 'full' }" @click="mode = 'full'">Full details</button>
  </div>
  <p class="gap-note">
    <template v-if="mode === 'quick'">Quick mode bulk-adds identical low-value catches fast — species, state, and how many.</template>
    <template v-else>Full details logs one specimen with CP, IV, nickname, tags, and caught date.</template>
  </p>

  <fieldset>
    <legend>Species</legend>
    <div class="species-picker" v-if="selectedSpecies">
      <img class="sprite-sm" :src="speciesSpritePath(selectedSpecies.dexNumber)" alt="" />
      <div>
        <div class="name">{{ selectedSpecies.name }}</div>
        <div class="form gap-note" v-if="formsForSpecies.length">
          {{ formsForSpecies.find((f) => f.slug === selectedFormSlug)?.costumeName ?? formsForSpecies.find((f) => f.slug === selectedFormSlug)?.formName }}
        </div>
      </div>
      <button type="button" class="chip-btn" @click="selectedSpecies = null; speciesQuery = ''">Change</button>
    </div>
    <input v-else class="search-input" type="search" placeholder="Search species…" v-model="speciesQuery" @input="searchSpecies" />
    <ul v-if="!selectedSpecies && speciesResults.length" class="species-results">
      <li v-for="s in speciesResults" :key="s.slug">
        <button type="button" @click="pickSpecies(s)">
          <img class="sprite-sm" :src="speciesSpritePath(s.dexNumber)" alt="" />#{{ s.dexNumber }} {{ s.name }}
        </button>
      </li>
    </ul>
    <label class="field" v-if="selectedSpecies && formsForSpecies.length > 1">
      Form
      <select v-model="selectedFormSlug">
        <option v-for="f in formsForSpecies" :key="f.slug" :value="f.slug">{{ f.costumeName ?? f.formName }} ({{ f.gender }})</option>
      </select>
    </label>
  </fieldset>

  <fieldset>
    <legend>State (applies to {{ mode === "quick" ? "the whole batch" : "this catch" }})</legend>
    <label class="toggle-row"><input type="checkbox" v-model="shiny" /><span>Shiny</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="lucky" /><span>Lucky</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="shadow" /><span>Shadow</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="purified" /><span>Purified</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="dynamax" /><span>Dynamax</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="receivedViaTrade" /><span>Received via trade</span></label>
  </fieldset>

  <fieldset v-if="mode === 'quick'">
    <legend>How many?</legend>
    <div class="qty-row">
      <button type="button" aria-label="Fewer" @click="setQuantity(quantity - 1)">−</button>
      <input type="number" min="1" max="500" v-model.number="quantity" />
      <button type="button" aria-label="More" @click="setQuantity(quantity + 1)">+</button>
      <button type="button" v-for="n in [5, 10, 25, 50]" :key="n" data-qty="1" :class="{ on: quantity === n }" @click="setQuantity(n)">{{ n }}</button>
    </div>
  </fieldset>

  <fieldset v-if="mode === 'full'">
    <legend>Details</legend>
    <div class="input-grid">
      <label class="field">CP<input type="number" v-model.number="cp" /></label>
      <IvComponentInput v-model="ivAttack" label="Attack IV" />
      <IvComponentInput v-model="ivDefense" label="Defense IV" />
      <IvComponentInput v-model="ivStamina" label="Stamina IV" />
      <div class="field" v-if="livePreviewIv !== null">
        <span class="iv-component-label">IV %</span>
        <span class="tabular">{{ livePreviewIv }}%</span>
      </div>
      <label class="field">Nickname<input type="text" v-model="nickname" /></label>
      <label class="field">Caught on<input type="date" v-model="caughtAt" /></label>
    </div>
  </fieldset>

  <fieldset v-if="mode === 'full'">
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
  <button type="button" class="save-button" :disabled="saving" @click="save">{{ saveLabel }}</button>

  <div v-if="justLogged" class="just-logged">
    <h3>Logged {{ justLogged.length }} specimen{{ justLogged.length === 1 ? "" : "s" }}</h3>
    <p class="gap-note">Act on any of these right away — trade, mark evolved, or release.</p>
    <div v-for="(inst, i) in justLogged.slice(0, 12)" :key="inst.id" class="logged-row">
      <span>#{{ i + 1 }}</span>
      <button type="button" @click="quickAction(inst.id, 'traded')">Trade</button>
      <button type="button" @click="quickAction(inst.id, 'evolved')">Evolved</button>
      <button type="button" @click="quickAction(inst.id, 'released')">Release</button>
    </div>
    <p class="gap-note" v-if="justLogged.length > 12">+ {{ justLogged.length - 12 }} more — see Collection.</p>
  </div>
</template>

<!-- Shared "field-log" classes (segmented, qty-row, tag-picker, save-button,
     just-logged, species-results) are styled globally in src/style.css so
     this page matches Trainer/Collection/species-detail's visual language. -->
