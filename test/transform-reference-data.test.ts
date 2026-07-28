// Assembles a full ReferenceData value out of the transform modules the way
// the orchestrator is expected to, and pins the two structural facts that
// aren't any single transform's responsibility: the raid-boss and
// Community-Day tables are dropped (present as empty arrays, not omitted —
// their ReferenceData fields are required), and no transform module emits
// them at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSpecies, GEN_TO_REGION } from "../scripts/ingest/transform/species";
import { buildFormMoves, buildMoves, buildTypeEffectivenessAndWeather } from "../scripts/ingest/transform/moves";
import { buildSpeciesEvolutions } from "../scripts/ingest/transform/evolutions";
import { buildPlayerProgression } from "../scripts/ingest/transform/player-progression";
import { buildPvp } from "../scripts/ingest/transform/pvp";
import type { ReferenceData } from "../src/db/reference-data";
import { gameMasterFrom, genderSettings, pokedexEntry, pokedexFrom, pokemonSettings, shinySheetFrom } from "./transform-fixtures";

const DROPPED_TABLES = ["raidBosses", "raidBossWeatherBoosts", "communityDays", "communityDayBonuses", "communityDaySpecies", "communityDayEventMoves"] as const;

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildAll(): ReferenceData {
  const pokedex = pokedexFrom([
    pokedexEntry({ id: "BULBASAUR", dexNr: 1, primaryType: { type: "POKEMON_TYPE_GRASS" }, evolutions: [{ id: "IVYSAUR", candies: 25 }] }),
    pokedexEntry({ id: "IVYSAUR", dexNr: 2, primaryType: { type: "POKEMON_TYPE_GRASS" } }),
  ]);
  const gameMaster = gameMasterFrom([
    genderSettings("SPAWN_V0001_POKEMON_BULBASAUR", "BULBASAUR", { malePercent: 0.875, femalePercent: 0.125 }),
    genderSettings("SPAWN_V0002_POKEMON_IVYSAUR", "IVYSAUR", { malePercent: 0.875, femalePercent: 0.125 }),
    pokemonSettings({ pokemonId: "BULBASAUR", form: "BULBASAUR_NORMAL", shadow: { purificationCandyNeeded: 3 }, quickMoves: ["VINE_WHIP_FAST"] }),
    ["moveSettings", { templateId: "V0013_MOVE_VINE_WHIP_FAST", movementId: "VINE_WHIP_FAST", pokemonType: "POKEMON_TYPE_GRASS", power: 7, energyDelta: 6, durationMs: 500 }],
    ["combatMove", { templateId: "COMBAT_V0013_MOVE_VINE_WHIP_FAST", uniqueId: "VINE_WHIP_FAST", type: "POKEMON_TYPE_GRASS", power: 5, energyDelta: 8 }],
    ["typeEffective", { templateId: "POKEMON_TYPE_NORMAL", attackType: "POKEMON_TYPE_NORMAL", attackScalar: [1, 1, 1, 1, 1, 0.625, 1, 0.390625, 0.625, 1, 1, 1, 1, 1, 1, 1, 1, 1] }],
    ["weatherAffinities", { templateId: "WEATHER_AFFINITY_CLEAR", weatherCondition: "CLEAR", pokemonType: ["POKEMON_TYPE_GRASS"] }],
    ["playerLevel", { templateId: "PLAYER_LEVEL_SETTINGS", requiredExperience: [0, 1000], cpMultiplier: [0.094, 0.16] }],
    ["levelUpRewards", { templateId: "AWARDS_LEVEL_2", level: 2, items: ["ITEM_POKE_BALL"], itemsCount: [10] }],
    ["badgeSettings", { templateId: "BADGE_7_DAY_STREAKS", badgeType: "BADGE_7_DAY_STREAKS", badgeRank: 5, targets: [1, 10] }],
    ["friendshipMilestoneSettings", { templateId: "FRIENDSHIP_LEVEL_0", milestoneXpReward: 1000, attackBonusPercentage: 1 }],
    ["vsSeekerLoot", { templateId: "VS_SEEKER_LOOT_PER_WIN_SETTINGS_RANK_1_FREE", rankLevel: 1, reward: [{ item: { stardust: true, count: 1200 } }] }],
    ["combatRankingProtoSettings", { templateId: "COMBAT_RANKING_SETTINGS_S30", rankLevel: [{ rankLevel: 1 }] }],
  ]);
  const shinySheet = shinySheetFrom([{ family_dex: "1", debut: "2018-03-25", pid: "pm1" }]);

  const speciesResult = buildSpecies({ pokedex, gameMaster, shinySheet });
  const { moves, slugByMovementId } = buildMoves(gameMaster, pokedex);
  const { typeEffectiveness, weatherBoosts } = buildTypeEffectivenessAndWeather(gameMaster);
  const progression = buildPlayerProgression(gameMaster);
  const pvp = buildPvp(gameMaster);

  const allTypeSlugs = new Set([
    ...speciesResult.formTypes.map((ft) => ft.typeSlug),
    ...moves.map((m) => m.typeSlug),
    ...typeEffectiveness.flatMap((te) => [te.attackingTypeSlug, te.defendingTypeSlug]),
    ...weatherBoosts.map((wb) => wb.typeSlug),
  ]);

  return {
    regions: [...new Set(Object.values(GEN_TO_REGION))].map((slug) => ({ slug, name: capitalize(slug) })),
    types: [...allTypeSlugs].map((slug) => ({ slug, name: capitalize(slug) })),
    backgrounds: [],
    species: speciesResult.species,
    forms: speciesResult.forms,
    formTypes: speciesResult.formTypes,
    megaVariants: speciesResult.megaVariants,
    moves,
    formMoves: buildFormMoves(gameMaster, pokedex, speciesResult.forms, slugByMovementId),
    speciesEvolutions: buildSpeciesEvolutions(pokedex, speciesResult.species),
    typeEffectiveness,
    weatherBoosts,
    ...progression,
    ...pvp,
    // Raid bosses and Community Days are dropped from ingestion entirely —
    // no transform module builds them, and these stay empty.
    raidBosses: [],
    raidBossWeatherBoosts: [],
    communityDays: [],
    communityDayBonuses: [],
    communityDaySpecies: [],
    communityDayEventMoves: [],
  };
}

test("raid-boss and Community-Day tables are present as empty arrays, not omitted", () => {
  const referenceData = buildAll();

  for (const table of DROPPED_TABLES) {
    assert.equal(Object.hasOwn(referenceData, table), true, `${table} must still be present`);
    assert.equal(Array.isArray(referenceData[table]), true, `${table} must be an array`);
    assert.equal(referenceData[table].length, 0, `${table} must be empty`);
  }
});

test("every other table is populated by the transforms", () => {
  const referenceData = buildAll();

  assert.equal(referenceData.species.length, 2);
  assert.equal(referenceData.forms.length, 4);
  assert.equal(referenceData.formTypes.length, 4);
  assert.equal(referenceData.moves.length, 1);
  assert.equal(referenceData.formMoves.length, 2);
  assert.deepEqual(referenceData.speciesEvolutions, [{ fromSpeciesSlug: "bulbasaur", toSpeciesSlug: "ivysaur", candyRequired: 25, itemRequired: null }]);
  assert.equal(referenceData.typeEffectiveness.length, 18);
  assert.deepEqual(referenceData.weatherBoosts, [{ weather: "Clear", typeSlug: "grass" }]);
  assert.equal(referenceData.playerLevels.length, 80);
  assert.equal(referenceData.playerLevelRewards.length, 1);
  assert.equal(referenceData.medals.length, 1);
  assert.equal(referenceData.medalTiers.length, 2);
  assert.equal(referenceData.friendshipLevels.length, 1);
  assert.equal(referenceData.pvpRankRewards.length, 1);
  assert.equal(referenceData.pvpRankRequirements.length, 1);
});

test("the shiny debut date rides along on the form rows for the schema task to pick up", () => {
  const referenceData = buildAll();
  const bulbasaur = referenceData.forms.filter((f) => f.speciesSlug === "bulbasaur");

  assert.equal(bulbasaur.length > 0, true);
  assert.equal(
    bulbasaur.every((f) => (f as { shinyReleasedAt?: string | null }).shinyReleasedAt === "2018-03-25"),
    true,
  );
});
