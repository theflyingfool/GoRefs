// Regression coverage for the C2 fix (see docs/superpowers/specs — the
// Drizzle migration converted personal-table timestamps from ISO-8601 TEXT
// to epoch-ms INTEGER, see schema.ts's CURRENT_PERSONAL_SCHEMA_VERSION
// comment). An export file written by a pre-7 build still has ISO-string
// timestamps; readPersonalDataFile must convert them before the data ever
// reaches importPersonalData's number-typed merge comparisons — otherwise
// `number >= "2026-..."` is NaN/false, corrupting the merge and reinjecting
// a string into an INTEGER column (see personal-data-transfer.ts's
// convertLegacyTimestamps for the full failure mode this guards against).
import { test } from "node:test";
import assert from "node:assert/strict";

import { readPersonalDataFile } from "../src/features/settings/personal-data-transfer";

function legacyExportFile(): File {
  const legacy = {
    exportedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 6,
    speciesPersonal: {
      bulbasaur: { speciesSlug: "bulbasaur", registered: true, xxl: false, xxs: false, purified: false, updatedAt: "2026-06-15T10:30:00.000Z" },
    },
    formPersonal: {
      "bulbasaur-standard-male": { formSlug: "bulbasaur-standard-male", caught: true, updatedAt: "2026-06-15T10:31:00.000Z" },
    },
    appSettings: {},
    megaPersonal: {
      "charizard-mega-x": { megaVariantSlug: "charizard-mega-x", evolved: true, shinyEvolved: false, updatedAt: "2026-06-10T00:00:00.000Z" },
    },
    formBackgroundPersonal: [{ formSlug: "bulbasaur-standard-male", achievementField: "caught", backgroundSlug: "spring-2024", updatedAt: "2026-06-15T10:31:00.000Z" }],
    medalProgress: {
      collector: { medalSlug: "collector", profileId: 1, currentRank: 2, currentCount: 50, updatedAt: "2026-06-12T00:00:00.000Z" },
    },
    pokemonInstances: [
      {
        id: 1,
        formSlug: "bulbasaur-standard-male",
        profileId: 1,
        status: "kept",
        recordedAt: "2026-06-14T18:00:00.000Z",
        caughtAt: "2026-06-14T00:00:00.000Z",
        updatedAt: "2026-06-14T18:00:00.000Z",
        cp: 1200,
        ivAttack: 15,
        ivDefense: 15,
        ivStamina: 15,
        ivPercent: 100,
        shiny: true,
        lucky: false,
        shadow: false,
        purified: false,
        heartsEarned: null,
        currentMegaLevel: null,
        nickname: null,
        backgroundSlug: null,
      },
    ],
    tags: [],
    playerProgress: { profileId: 1, currentLevel: 30, totalXp: 1000000, updatedAt: "2026-06-15T00:00:00.000Z" },
    playerProgressLog: [{ id: 1, profileId: 1, recordedAt: "2026-06-15T00:00:00.000Z", currentLevel: 30, totalXp: 1000000 }],
  };
  return new File([JSON.stringify(legacy)], "legacy-export.json", { type: "application/json" });
}

test("readPersonalDataFile converts a pre-v7 (ISO-string) export's timestamps to epoch-ms", async () => {
  const { data, schemaMismatch } = await readPersonalDataFile(legacyExportFile());

  assert.equal(schemaMismatch, true);
  assert.equal(data.speciesPersonal.bulbasaur.updatedAt, new Date("2026-06-15T10:30:00.000Z").getTime());
  assert.equal(typeof data.speciesPersonal.bulbasaur.updatedAt, "number");
  assert.equal(data.formPersonal["bulbasaur-standard-male"].updatedAt, new Date("2026-06-15T10:31:00.000Z").getTime());
  assert.equal(data.megaPersonal!["charizard-mega-x"].updatedAt, new Date("2026-06-10T00:00:00.000Z").getTime());
  assert.equal(data.formBackgroundPersonal![0].updatedAt, new Date("2026-06-15T10:31:00.000Z").getTime());
  assert.equal(data.medalProgress!.collector.updatedAt, new Date("2026-06-12T00:00:00.000Z").getTime());
  assert.equal(data.pokemonInstances![0].recordedAt, new Date("2026-06-14T18:00:00.000Z").getTime());
  assert.equal(data.pokemonInstances![0].caughtAt, new Date("2026-06-14T00:00:00.000Z").getTime());
  assert.equal(data.pokemonInstances![0].updatedAt, new Date("2026-06-14T18:00:00.000Z").getTime());
  assert.equal(data.playerProgress!.updatedAt, new Date("2026-06-15T00:00:00.000Z").getTime());
  assert.equal(data.playerProgressLog![0].recordedAt, new Date("2026-06-15T00:00:00.000Z").getTime());
});

test("readPersonalDataFile leaves a current (v11) export's epoch-ms timestamps untouched", async () => {
  const now = Date.now();
  const current = {
    exportedAt: new Date().toISOString(),
    // Bumped 10 -> 11 with CURRENT_PERSONAL_SCHEMA_VERSION (Sub-project 7b
    // Task 1's identity/merge-gap migration): "current" now means v11, so
    // this asserts schemaMismatch === false. Timestamp conversion is a
    // fixed schemaVersion < 7 cutoff, unaffected by the bump.
    schemaVersion: 11,
    speciesPersonal: {
      bulbasaur: { speciesSlug: "bulbasaur", registered: true, xxl: false, xxs: false, purified: false, updatedAt: now },
    },
    formPersonal: {},
    appSettings: {},
  };
  const file = new File([JSON.stringify(current)], "current-export.json", { type: "application/json" });

  const { data, schemaMismatch } = await readPersonalDataFile(file);

  assert.equal(schemaMismatch, false);
  assert.equal(data.speciesPersonal.bulbasaur.updatedAt, now);
});
