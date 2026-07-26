import { test } from "node:test";
import assert from "node:assert/strict";

import { createInMemoryRepository, type PersonalState } from "../src/data/in-memory-store";
import type { ReferenceData } from "../src/db/reference-data";

const referenceData: ReferenceData = {
  regions: [{ slug: "kanto", name: "Kanto" }],
  types: [],
  backgrounds: [],
  species: [
    {
      slug: "bulbasaur",
      dexNumber: 1,
      name: "Bulbasaur",
      familySlug: "bulbasaur",
      gen: 1,
      rarity: "standard",
      regionSlug: "kanto",
      hasMale: true,
      hasFemale: true,
      canMegaEvolve: false,
      canGigantamax: false,
    },
  ],
  forms: [
    {
      slug: "bulbasaur-standard",
      speciesSlug: "bulbasaur",
      formName: "Standard",
      costumeName: null,
      gender: "male",
      evolves: true,
      shinyAvailable: true,
      shadowAvailable: false,
      dynamaxAvailable: false,
      regionalExclusive: false,
      imageRef: null,
    },
  ],
  formTypes: [],
  megaVariants: [],
  moves: [],
  formMoves: [],
  speciesEvolutions: [],
  typeEffectiveness: [],
  weatherBoosts: [],
  playerLevels: [],
  playerLevelRewards: [],
  medals: [],
  medalTiers: [],
  friendshipLevels: [],
  pvpRankRewards: [],
  pvpRankRequirements: [],
  raidBosses: [],
  raidBossWeatherBoosts: [],
  communityDays: [],
  communityDayBonuses: [],
  communityDaySpecies: [],
  communityDayEventMoves: [],
};

function emptyState(): PersonalState {
  return {
    speciesPersonal: {},
    formPersonal: {},
    appSettings: {},
    megaPersonal: {},
    formBackgroundPersonal: [],
    medalProgress: {},
    pokemonInstances: [],
    tags: [],
    pokemonInstanceTags: [],
    playerProgress: undefined,
    playerProgressLog: [],
    profile: { id: "1", username: "Trainer", friendCode: null, createdAt: Date.now() },
  };
}

const noopHooks = {
  onSpeciesPersonalChanged() {},
  onFormPersonalChanged() {},
  onAppSettingChanged() {},
  onMegaPersonalChanged() {},
  onFormBackgroundPersonalAdded() {},
  onMedalProgressChanged() {},
  onPlayerProgressChanged() {},
  onPlayerProgressLogAppended() {},
  onPokemonInstanceStatusChanged() {},
};

test("export/import round-trips species, form, and app-setting personal data", async () => {
  const sourceState = emptyState();
  const source = createInMemoryRepository(referenceData, sourceState, noopHooks);

  source.setSpeciesPersonalField("bulbasaur", "xxl", true);
  source.setFormPersonalField("bulbasaur-standard", "shiny", true);
  source.setAppSetting("grid_indicators", JSON.stringify(["shiny"]));

  const exported = source.exportPersonalData();

  const destState = emptyState();
  const dest = createInMemoryRepository(referenceData, destState, noopHooks);
  const result = await dest.importPersonalData(exported);

  assert.deepEqual(result, { skippedSpeciesSlugs: 0, skippedFormSlugs: 0 });

  const withForms = dest.getSpeciesWithForms("bulbasaur");
  // xxl implies registered (see applySpeciesPersonalField's cascade) — the
  // export/import path reuses this repo's setters, but importPersonalData
  // writes state directly rather than re-deriving cascades, so it's the
  // *exporting* side's cascade we're really confirming survived the trip.
  assert.equal(withForms.personal.xxl, true);
  assert.equal(withForms.personal.registered, true);
  assert.equal(withForms.forms[0].personal.shiny, true);
  assert.equal(dest.getAppSetting("grid_indicators"), JSON.stringify(["shiny"]));
});

test("import skips rows whose slug no longer resolves against the loaded reference data, and counts them", async () => {
  const destState = emptyState();
  const dest = createInMemoryRepository(referenceData, destState, noopHooks);

  const result = await dest.importPersonalData({
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    speciesPersonal: {
      bulbasaur: { speciesSlug: "bulbasaur", registered: true, xxl: false, xxs: false, purified: false, updatedAt: Date.now() },
      "no-longer-exists": { speciesSlug: "no-longer-exists", registered: true, xxl: false, xxs: false, purified: false, updatedAt: Date.now() },
    },
    formPersonal: {},
    appSettings: {},
  });

  assert.equal(result.skippedSpeciesSlugs, 1);
  assert.equal(result.skippedFormSlugs, 0);
  assert.equal(dest.getSpeciesWithForms("bulbasaur").personal.registered, true);
});

test("import merges instead of wiping: a local row absent from the import survives untouched", async () => {
  const destState = emptyState();
  const dest = createInMemoryRepository(referenceData, destState, noopHooks);

  // Local data that the about-to-be-imported file knows nothing about.
  dest.setSpeciesPersonalField("bulbasaur", "xxl", true);
  dest.setFormPersonalField("bulbasaur-standard", "shiny", true);
  dest.setAppSetting("grid_indicators", JSON.stringify(["shiny"]));

  const result = await dest.importPersonalData({
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    speciesPersonal: {},
    formPersonal: {},
    appSettings: {},
  });

  assert.deepEqual(result, { skippedSpeciesSlugs: 0, skippedFormSlugs: 0 });
  const withForms = dest.getSpeciesWithForms("bulbasaur");
  // A wipe-and-restore would have cleared these; a merge leaves them alone
  // since the import didn't mention bulbasaur at all.
  assert.equal(withForms.personal.xxl, true);
  assert.equal(withForms.personal.registered, true);
  assert.equal(withForms.forms[0].personal.shiny, true);
  assert.equal(dest.getAppSetting("grid_indicators"), JSON.stringify(["shiny"]));
});

test("import keeps the local row when it's newer than the imported one", async () => {
  const destState = emptyState();
  const dest = createInMemoryRepository(referenceData, destState, noopHooks);
  dest.setSpeciesPersonalField("bulbasaur", "xxl", true); // stamps a real, current updatedAt

  await dest.importPersonalData({
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    speciesPersonal: {
      bulbasaur: { speciesSlug: "bulbasaur", registered: false, xxl: false, xxs: true, purified: false, updatedAt: new Date("2000-01-01T00:00:00.000Z").getTime() },
    },
    formPersonal: {},
    appSettings: {},
  });

  // The incoming row is older, so the local (newer) row wins entirely.
  assert.equal(dest.getSpeciesWithForms("bulbasaur").personal.xxl, true);
  assert.equal(dest.getSpeciesWithForms("bulbasaur").personal.xxs, false);
});

test("import overwrites the local row when the imported one is newer", async () => {
  const destState = emptyState();
  const dest = createInMemoryRepository(referenceData, destState, noopHooks);
  destState.speciesPersonal.bulbasaur = { speciesSlug: "bulbasaur", registered: true, xxl: true, xxs: false, purified: false, updatedAt: new Date("2000-01-01T00:00:00.000Z").getTime() };

  await dest.importPersonalData({
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    speciesPersonal: {
      bulbasaur: { speciesSlug: "bulbasaur", registered: true, xxl: false, xxs: true, purified: false, updatedAt: Date.now() },
    },
    formPersonal: {},
    appSettings: {},
  });

  // The incoming row is newer, so it replaces the local one entirely (not
  // merged field-by-field — xxl reverts to false along with xxs flipping true).
  assert.equal(dest.getSpeciesWithForms("bulbasaur").personal.xxl, false);
  assert.equal(dest.getSpeciesWithForms("bulbasaur").personal.xxs, true);
});

test("import applies every app-setting key (reference_data_version is now device-level app_meta, never in personal data)", async () => {
  // reference_data_version moved out of the now-per-profile app_settings into
  // the global app_meta table (migration 0004), so it is never part of a
  // personal-data export's appSettings in the first place — the old import-time
  // special-case skip for it is gone, and every imported app-setting key is
  // applied unconditionally.
  const destState = emptyState();
  destState.appSettings.collapse_gender_forms = "0";
  const dest = createInMemoryRepository(referenceData, destState, noopHooks);

  await dest.importPersonalData({
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    speciesPersonal: {},
    formPersonal: {},
    appSettings: { collapse_gender_forms: "1" },
  });

  assert.equal(dest.getAppSetting("collapse_gender_forms"), "1");
});
