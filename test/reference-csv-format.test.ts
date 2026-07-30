// Pins the CSV column order and per-form row-building logic in
// src/data/reference-csv-format.ts, in particular that shinyReleasedAt
// (added alongside shinyAvailable on Form) round-trips into the CSV export
// exactly like its sibling nullable/boolean fields (shiny_available,
// shadow_available, dynamax_available, regional_exclusive, image_ref).

import { test } from "node:test";
import assert from "node:assert/strict";

import { REFERENCE_CSV_COLUMNS, formToCsvRow } from "../src/data/reference-csv-format";
import type { ReferenceData } from "../src/db/reference-data";
import type { Form, Species } from "../src/db/types";

function species(overrides: Partial<Species> = {}): Species {
  return {
    slug: "bulbasaur",
    dexNumber: 1,
    name: "Bulbasaur",
    familySlug: "bulbasaur-family",
    gen: 1,
    rarity: "standard",
    regionSlug: "kanto",
    hasMale: true,
    hasFemale: true,
    canMegaEvolve: false,
    canGigantamax: false,
    ...overrides,
  };
}

function form(overrides: Partial<Form> = {}): Form {
  return {
    slug: "bulbasaur-normal",
    speciesSlug: "bulbasaur",
    formName: "Normal",
    costumeName: null,
    gender: "male",
    evolves: true,
    shinyAvailable: true,
    shinyReleasedAt: "2018-03-25",
    shadowAvailable: false,
    dynamaxAvailable: false,
    regionalExclusive: false,
    imageRef: null,
    ...overrides,
  };
}

function referenceData(forms: Form[], speciesList: Species[]): ReferenceData {
  return {
    regions: [],
    types: [],
    backgrounds: [],
    species: speciesList,
    forms,
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
}

test("REFERENCE_CSV_COLUMNS includes shiny_released_at alongside shiny_available", () => {
  const shinyIdx = REFERENCE_CSV_COLUMNS.indexOf("shiny_available");
  assert.equal(REFERENCE_CSV_COLUMNS[shinyIdx + 1], "shiny_released_at");
});

test("formToCsvRow emits the form's shinyReleasedAt at the shiny_released_at column", () => {
  const data = referenceData([], [species()]);
  const row = formToCsvRow(data, form({ shinyReleasedAt: "2018-03-25" }));
  const idx = REFERENCE_CSV_COLUMNS.indexOf("shiny_released_at");
  assert.equal(row[idx], "2018-03-25");
});

test("formToCsvRow emits an empty string when shinyReleasedAt is null, matching costumeName/imageRef's null convention", () => {
  const data = referenceData([], [species()]);
  const row = formToCsvRow(data, form({ shinyReleasedAt: null }));
  const idx = REFERENCE_CSV_COLUMNS.indexOf("shiny_released_at");
  assert.equal(row[idx], "");
});

test("formToCsvRow's row length matches REFERENCE_CSV_COLUMNS length", () => {
  const data = referenceData([], [species()]);
  const row = formToCsvRow(data, form());
  assert.equal(row.length, REFERENCE_CSV_COLUMNS.length);
});
