<!--
  Vue port of the vanilla settings-page.ts — Phase 0 pilot for the Vue
  migration (docs/vue-migration-plan.md). Behavior and markup are kept
  identical on purpose: this exists to prove the mount/unmount plumbing
  works, not to redesign Settings yet.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { EXCLUDE_REGIONAL_SETTING_KEY, MAX_GRID_INDICATORS, type Repository } from "../../data/repository";
import { CURRENT_PERSONAL_SCHEMA_VERSION } from "../../db/schema";
import { applyTheme, getThemePreference, setThemePreference, type ThemePreference } from "../../app-shell/theme";
import { FORM_GRID_SECOND_FIELD_OPTIONS, INDICATOR_LABELS, INDICATOR_OPTIONS, getFormGridSecondField, setFormGridSecondField } from "../data-entry/indicator-labels";
import { buildExportBundle, downloadTextFile, importTrainerBundleFile } from "./personal-data-transfer";

const props = defineProps<{ repo: Repository }>();

const COLLAPSE_SETTING_KEY = "collapse_gender_forms";
// Off by default: was a per-import window.confirm() prompt, but that meant
// re-deciding every single time. A persistent setting means "no" only has
// to be chosen once.
const BACKUP_BEFORE_IMPORT_SETTING_KEY = "backup_before_import";

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const theme = ref<ThemePreference>(getThemePreference(props.repo));
function chooseTheme(value: ThemePreference) {
  setThemePreference(props.repo, value);
  theme.value = value;
}

const collapseGenderForms = ref(props.repo.getAppSetting(COLLAPSE_SETTING_KEY) === "1");
function onCollapseChange(checked: boolean) {
  collapseGenderForms.value = checked;
  props.repo.setAppSetting(COLLAPSE_SETTING_KEY, checked ? "1" : "0");
}

const excludeRegional = ref(props.repo.getAppSetting(EXCLUDE_REGIONAL_SETTING_KEY) === "1");
function onExcludeRegionalChange(checked: boolean) {
  excludeRegional.value = checked;
  props.repo.setAppSetting(EXCLUDE_REGIONAL_SETTING_KEY, checked ? "1" : "0");
}

const formGridSecondField = ref(getFormGridSecondField(props.repo));
function chooseFormGridSecondField(field: (typeof FORM_GRID_SECOND_FIELD_OPTIONS)[number]) {
  setFormGridSecondField(props.repo, field);
  formGridSecondField.value = field;
}

const selectedIndicators = ref(props.repo.getIndicatorSelection());
const atIndicatorCap = computed(() => selectedIndicators.value.length >= MAX_GRID_INDICATORS);
function toggleIndicator(field: (typeof INDICATOR_OPTIONS)[number], checked: boolean) {
  const current = props.repo.getIndicatorSelection();
  const updated = checked ? [...current, field] : current.filter((f) => f !== field);
  props.repo.setIndicatorSelection(updated);
  selectedIndicators.value = updated;
}

const backupBeforeImport = ref(props.repo.getAppSetting(BACKUP_BEFORE_IMPORT_SETTING_KEY) === "1");
function onBackupBeforeImportChange(checked: boolean) {
  backupBeforeImport.value = checked;
  props.repo.setAppSetting(BACKUP_BEFORE_IMPORT_SETTING_KEY, checked ? "1" : "0");
}

const status = ref("");

async function onExportCurrent() {
  status.value = "Exporting…";
  try {
    const bundle = buildExportBundle(props.repo, [props.repo.getCurrentProfile().id]);
    await downloadTextFile(JSON.stringify(bundle, null, 2), {
      suggestedName: `gobuddy-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      mimeType: "application/json",
      description: "GoBuddy export",
    });
    status.value = "Exported.";
  } catch (err) {
    status.value = `Export failed: ${(err as Error).message}`;
  }
}

async function onExportAll() {
  status.value = "Exporting…";
  try {
    const bundle = buildExportBundle(props.repo, props.repo.listProfiles().map((p) => p.id));
    await downloadTextFile(JSON.stringify(bundle, null, 2), {
      suggestedName: `gobuddy-export-all-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      mimeType: "application/json",
      description: "GoBuddy export (all trainers)",
    });
    status.value = "Exported.";
  } catch (err) {
    status.value = `Export failed: ${(err as Error).message}`;
  }
}

async function onImportFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    status.value = "Importing…";
    // Backup-before-import is a persistent setting (backupBeforeImport
    // above), not a per-import prompt — off by default. Runs as a callback
    // right before the mutating apply step, so a cancelled schema-mismatch
    // or merge/separate prompt never triggers a spurious backup download.
    const summary = await importTrainerBundleFile(props.repo, file, async () => {
      if (backupBeforeImport.value) {
        status.value = "Saving a backup of your current data first…";
        await onExportAll();
      }
    });
    status.value = `Imported: ${summary.merged} merged, ${summary.promoted} promoted, ${summary.created} created as new, ${summary.separate} kept separate.`;
  } catch (err) {
    status.value = `Import failed: ${(err as Error).message}`;
  }
}

const referenceDataVersion = props.repo.getAppSetting("reference_data_version") ?? "unknown";

// applyTheme is already called at boot from the current theme setting;
// re-applying here is a no-op unless the user changes it in this session,
// which chooseTheme already handles via setThemePreference.
void applyTheme;
</script>

<template>
  <h2>Settings</h2>

  <fieldset>
    <legend>Appearance</legend>
    <div class="theme-options">
      <button
        v-for="option in THEME_OPTIONS"
        :key="option.value"
        type="button"
        :class="['filter-chip', { 'filter-chip-active': theme === option.value }]"
        @click="chooseTheme(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
  </fieldset>

  <fieldset>
    <legend>Display</legend>
    <label class="toggle-row">
      <input type="checkbox" :checked="collapseGenderForms" @change="onCollapseChange(($event.target as HTMLInputElement).checked)" />
      <span>Collapse gender-split forms</span>
    </label>
    <!-- Bulk Edit always groups a species' male/female forms into one tile
         regardless of this setting (it's a different screen's own hardcoded
         choice) — worth flagging here since its "N forms selected" counter can
         otherwise be surprising: tapping one gender-split tile adds every form
         underneath it, not just one. -->
    <p class="gap-note">
      Bulk Edit always shows one tile per species/form regardless of this setting — tapping a gender-split tile there selects every form underneath it, so its counter can jump by more than one per tap.
    </p>
  </fieldset>

  <!-- Off by default (today's behavior): some players can actually reach
       region-locked forms (an alt account, travel, trading) so Form-complete
       requiring them is fair; others genuinely never can, which makes the
       stat permanently unattainable for ~50 species. Per-install choice, not
       a fixed app-wide answer. -->
  <fieldset>
    <legend>Stats</legend>
    <label class="toggle-row">
      <input type="checkbox" :checked="excludeRegional" @change="onExcludeRegionalChange(($event.target as HTMLInputElement).checked)" />
      <span>Exclude regional-exclusive forms from Form-complete</span>
    </label>
  </fieldset>

  <!-- Caught is always the form-grid tile's first icon (the baseline everyone
       wants); this picks the *second* one — deliberately one field, not a
       multi-select picker, since the owner specifically didn't want an
       open-ended "which fields" decision here. -->
  <fieldset>
    <legend>Form grid — second quick-toggle</legend>
    <div class="theme-options">
      <button
        v-for="field in FORM_GRID_SECOND_FIELD_OPTIONS"
        :key="field"
        type="button"
        :class="['filter-chip', { 'filter-chip-active': formGridSecondField === field }]"
        @click="chooseFormGridSecondField(field)"
      >
        {{ INDICATOR_LABELS[field].full }}
      </button>
    </div>
  </fieldset>

  <!-- <details> gives collapse/expand for free (no JS state to track across
       rerenders) — this is the longest fieldset on the page (up to
       MAX_GRID_INDICATORS pickable rows), so it starts collapsed rather than
       pushing everything below it down by default. -->
  <details class="settings-details">
    <summary>Grid badges (pick up to {{ MAX_GRID_INDICATORS }})</summary>
    <label
      v-for="field in INDICATOR_OPTIONS"
      :key="field"
      :class="['toggle-row', { 'toggle-row-disabled': !selectedIndicators.includes(field) && atIndicatorCap }]"
    >
      <input
        type="checkbox"
        :checked="selectedIndicators.includes(field)"
        :disabled="!selectedIndicators.includes(field) && atIndicatorCap"
        @change="toggleIndicator(field, ($event.target as HTMLInputElement).checked)"
      />
      <span>{{ INDICATOR_LABELS[field].full }}</span>
    </label>
  </details>

  <fieldset>
    <legend>Data</legend>
    <label class="toggle-row">
      <input type="checkbox" :checked="backupBeforeImport" @change="onBackupBeforeImportChange(($event.target as HTMLInputElement).checked)" />
      <span>Back up before import</span>
    </label>
    <button type="button" @click="onExportCurrent">Export current trainer</button>
    <button type="button" @click="onExportAll">Export all trainers</button>
    <!-- This file is the only backup that exists — nothing here syncs to any
         account or server. Sits right under the button rather than in a
         tooltip/help page, since it's the moment someone decides whether to
         bother exporting at all. -->
    <p class="gap-note">This file is your only backup — export it after play sessions, and before updating or reinstalling the app.</p>
    <label class="toggle-row">
      Import personal data
      <input type="file" accept="application/json" @change="onImportFileChange" />
    </label>
    <p class="gap-note" aria-live="polite">{{ status }}</p>
  </fieldset>

  <fieldset>
    <legend>About</legend>
    <p class="gap-note">Version {{ __APP_VERSION__ }}</p>
    <p class="gap-note">Personal-data schema: v{{ CURRENT_PERSONAL_SCHEMA_VERSION }}</p>
    <p class="gap-note">Reference data: {{ referenceDataVersion }}</p>
  </fieldset>
</template>
