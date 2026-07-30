import { test } from "node:test";
import assert from "node:assert/strict";

import { findVanishedSlugProblems, slugsOf, type SlugSets } from "../scripts/ingest/slug-stability";
import type { ReferenceData } from "../src/db/reference-data";

function referenceDataWith(overrides: Partial<Pick<ReferenceData, "species" | "forms" | "megaVariants" | "medals">>): ReferenceData {
  return {
    regions: [],
    types: [],
    backgrounds: [],
    species: [],
    forms: [],
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
    ...overrides,
  } as ReferenceData;
}

test("slugsOf extracts species/form/megaVariant/medal slug sets", () => {
  const data = referenceDataWith({
    species: [{ slug: "bulbasaur" } as ReferenceData["species"][number]],
    forms: [{ slug: "bulbasaur-standard-male" } as ReferenceData["forms"][number]],
    megaVariants: [{ slug: "venusaur-mega" } as ReferenceData["megaVariants"][number]],
    medals: [{ slug: "triathlete" } as ReferenceData["medals"][number]],
  });

  const sets = slugsOf(data);
  assert.deepEqual([...sets.species], ["bulbasaur"]);
  assert.deepEqual([...sets.forms], ["bulbasaur-standard-male"]);
  assert.deepEqual([...sets.megaVariants], ["venusaur-mega"]);
  assert.deepEqual([...sets.medals], ["triathlete"]);
});

test("findVanishedSlugProblems reports nothing when nothing vanished", () => {
  const before: SlugSets = { species: new Set(["a"]), forms: new Set(["b"]), megaVariants: new Set(["c"]), medals: new Set(["d"]) };
  const after: SlugSets = { species: new Set(["a"]), forms: new Set(["b"]), megaVariants: new Set(["c"]), medals: new Set(["d"]) };
  assert.deepEqual(findVanishedSlugProblems(before, after, new Set(), new Set()), []);
});

test("a vanished species slug is reported unless covered by a rename", () => {
  const before: SlugSets = { species: new Set(["nidoran-f"]), forms: new Set(), megaVariants: new Set(), medals: new Set() };
  const after: SlugSets = { species: new Set(), forms: new Set(), megaVariants: new Set(), medals: new Set() };

  const unrenamed = findVanishedSlugProblems(before, after, new Set(), new Set());
  assert.equal(unrenamed.length, 1);
  assert.match(unrenamed[0], /species slug disappeared/);

  const renamed = findVanishedSlugProblems(before, after, new Set(["nidoran-f"]), new Set());
  assert.deepEqual(renamed, []);
});

test("a vanished form slug is reported unless covered by a rename", () => {
  const before: SlugSets = { species: new Set(), forms: new Set(["old-form-slug"]), megaVariants: new Set(), medals: new Set() };
  const after: SlugSets = { species: new Set(), forms: new Set(), megaVariants: new Set(), medals: new Set() };

  const unrenamed = findVanishedSlugProblems(before, after, new Set(), new Set());
  assert.equal(unrenamed.length, 1);
  assert.match(unrenamed[0], /form slug disappeared/);

  const renamed = findVanishedSlugProblems(before, after, new Set(), new Set(["old-form-slug"]));
  assert.deepEqual(renamed, []);
});

test("a vanished mega-variant slug is always reported -- no rename mechanism exists", () => {
  const before: SlugSets = { species: new Set(), forms: new Set(), megaVariants: new Set(["venusaur-mega"]), medals: new Set() };
  const after: SlugSets = { species: new Set(), forms: new Set(), megaVariants: new Set(), medals: new Set() };

  const problems = findVanishedSlugProblems(before, after, new Set(), new Set());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /mega_variant slug disappeared/);
});

test("a vanished medal slug is always reported -- medal_progress_personal has a live FK and no rename mechanism", () => {
  const before: SlugSets = { species: new Set(), forms: new Set(), megaVariants: new Set(), medals: new Set(["triathlete"]) };
  const after: SlugSets = { species: new Set(), forms: new Set(), megaVariants: new Set(), medals: new Set() };

  const problems = findVanishedSlugProblems(before, after, new Set(), new Set());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /medal slug disappeared/);
  assert.match(problems[0], /triathlete/);
});

test("multiple simultaneous vanishings across all four slug kinds are all reported", () => {
  const before: SlugSets = {
    species: new Set(["a-species"]),
    forms: new Set(["a-form"]),
    megaVariants: new Set(["a-mega"]),
    medals: new Set(["a-medal"]),
  };
  const after: SlugSets = { species: new Set(), forms: new Set(), megaVariants: new Set(), medals: new Set() };

  const problems = findVanishedSlugProblems(before, after, new Set(), new Set());
  assert.equal(problems.length, 4);
});
