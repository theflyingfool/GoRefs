import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createGameMasterIndex } from "../scripts/ingest/sources/game-master";

function entry(templateId: string, category: string, data: Record<string, unknown>) {
  return { templateId, data: { templateId, [category]: data } };
}

test("createGameMasterIndex buckets entries by their data object's own key, not templateId", () => {
  const raw = [
    entry("V0001_POKEMON_BULBASAUR_NORMAL", "pokemonSettings", { pokemonId: "BULBASAUR", form: "BULBASAUR_NORMAL" }),
    entry("V0013_MOVE_WRAP", "moveSettings", { movementId: "WRAP", power: 60 }),
    entry("COMBAT_V0013_MOVE_WRAP", "combatMove", { uniqueId: "WRAP", power: 70 }),
  ];
  const index = createGameMasterIndex(raw);

  assert.equal(index.allPokemonSettings().length, 1);
  assert.equal(index.allMoveSettings().length, 1);
  assert.equal(index.allCombatMoves().length, 1);
  // WRAP is a shared movementId/uniqueId across two different categories
  // (moveSettings vs combatMove) -- these must never merge into one bucket.
  assert.equal(index.getMoveSettings("WRAP")?.power, 60);
  assert.equal(index.getCombatMove("WRAP")?.power, 70);
});

test("ignores entries with no data object", () => {
  const raw = [{ templateId: "SOME_FLAG" }, entry("V0001_POKEMON_BULBASAUR_NORMAL", "pokemonSettings", { pokemonId: "BULBASAUR" })];
  const index = createGameMasterIndex(raw);
  assert.equal(index.allPokemonSettings().length, 1);
});

test("per-category natural-key lookups are O(1) gets against the secondary map, keyed correctly per category", () => {
  const raw = [
    entry("V0025_POKEMON_PIKACHU_NORMAL", "pokemonSettings", { pokemonId: "PIKACHU", form: "PIKACHU_NORMAL" }),
    // A pokemonSettings record with no form (e.g. a species with only one
    // form) must still be reachable by pokemonId alone.
    entry("V0001_POKEMON_BULBASAUR", "pokemonSettings", { pokemonId: "BULBASAUR" }),
    entry("FORMS_V0025_POKEMON_PIKACHU", "formSettings", { pokemon: "PIKACHU", forms: [{ form: "PIKACHU_NORMAL" }] }),
    entry("V0013_MOVE_WRAP", "moveSettings", { movementId: "WRAP" }),
    entry("COMBAT_V0013_MOVE_WRAP", "combatMove", { uniqueId: "WRAP" }),
    entry("POKEMON_TYPE_BUG", "typeEffective", { attackType: "POKEMON_TYPE_BUG", attackScalar: [1, 0.625] }),
    entry("WEATHER_AFFINITY_CLEAR", "weatherAffinities", { weatherCondition: "CLEAR", pokemonType: ["POKEMON_TYPE_GRASS"] }),
    entry("PLAYER_LEVEL_SETTINGS", "playerLevel", { requiredExperience: [0, 2500], cpMultiplier: [0.1, 0.2] }),
    entry("AWARDS_LEVEL_10", "levelUpRewards", { level: 10, items: ["ITEM_POKE_BALL"] }),
    entry("BADGE_7_DAY_STREAKS", "badgeSettings", { badgeType: "BADGE_7_DAY_STREAKS", badgeRank: 5 }),
    entry("FRIENDSHIP_LEVEL_1", "friendshipMilestoneSettings", { milestoneXpReward: 3000 }),
    entry("COMBAT_LEAGUE_DEFAULT_GREAT", "combatLeague", { title: "combat_great_league" }),
  ];
  const index = createGameMasterIndex(raw);

  assert.equal(index.getPokemonSettings("PIKACHU", "PIKACHU_NORMAL")?.pokemonId, "PIKACHU");
  assert.equal(index.getPokemonSettings("PIKACHU", "PIKACHU_ADVENTURE_HAT")?.pokemonId, undefined);
  assert.equal(index.getPokemonSettings("BULBASAUR")?.pokemonId, "BULBASAUR");
  assert.equal(index.getFormSettings("PIKACHU")?.pokemon, "PIKACHU");
  assert.equal(index.getMoveSettings("WRAP")?.movementId, "WRAP");
  assert.equal(index.getCombatMove("WRAP")?.uniqueId, "WRAP");
  assert.equal(index.getTypeEffective("POKEMON_TYPE_BUG")?.attackScalar?.[0], 1);
  assert.equal(index.getWeatherAffinity("CLEAR")?.pokemonType?.[0], "POKEMON_TYPE_GRASS");
  assert.equal(index.getPlayerLevelSettings()?.requiredExperience[1], 2500);
  assert.equal(index.getLevelUpRewards(10)?.items?.[0], "ITEM_POKE_BALL");
  assert.equal(index.getBadgeSettings("BADGE_7_DAY_STREAKS")?.badgeRank, 5);
  assert.equal(index.getFriendshipMilestoneSettings("FRIENDSHIP_LEVEL_1")?.milestoneXpReward, 3000);
  assert.equal(index.getCombatLeague("COMBAT_LEAGUE_DEFAULT_GREAT")?.title, "combat_great_league");
});

test("genderSettings keys by templateId (not `pokemon`) because distinct gender-ratio records share a pokemon field", () => {
  // Modeled on the real FRILLISH case: a male-only base record and a
  // separately-declared 100%-female record both carry pokemon: "FRILLISH".
  // Keying by `pokemon` alone would silently drop one of these.
  const raw = [
    entry("SPAWN_V0592_POKEMON_FRILLISH", "genderSettings", { pokemon: "FRILLISH", gender: { malePercent: 1 } }),
    entry("SPAWN_V0592_POKEMON_FRILLISH_FEMALE", "genderSettings", { pokemon: "FRILLISH", gender: { femalePercent: 1 } }),
  ];
  const index = createGameMasterIndex(raw);

  assert.equal(index.allGenderSettings().length, 2, "both records must survive indexing");
  assert.equal(index.getGenderSettings("SPAWN_V0592_POKEMON_FRILLISH")?.gender?.malePercent, 1);
  assert.equal(index.getGenderSettings("SPAWN_V0592_POKEMON_FRILLISH_FEMALE")?.gender?.femalePercent, 1);

  const forFrillish = index.genderSettingsFor("FRILLISH");
  assert.equal(forFrillish.length, 2);
});

test("duplicate natural key within a category keeps the first-seen record and warns, without throwing", () => {
  const raw = [
    entry("AWARDS_LEVEL_10", "levelUpRewards", { level: 10, items: ["ITEM_POKE_BALL"], itemsCount: [20] }),
    // A later record for the same level but different content (mirrors the
    // real AWARDS_LEVEL_10 / BACKFILL_AWARDS_LEVEL_10 conflict).
    entry("BACKFILL_AWARDS_LEVEL_10", "levelUpRewards", { level: 10, items: ["ITEM_ITEM_STORAGE_UPGRADE_EARNED"], itemsCount: [25] }),
  ];

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  let index: ReturnType<typeof createGameMasterIndex>;
  try {
    index = createGameMasterIndex(raw);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(index.allLevelUpRewards().length, 2, "both raw records are still retained in the full list");
  const kept = index.getLevelUpRewards(10);
  assert.equal(kept?.templateId, "AWARDS_LEVEL_10", "first-seen record wins the natural-key lookup");
  assert.equal(kept?.items?.[0], "ITEM_POKE_BALL");
  assert.equal(warnings.length, 1, "exactly one conflict warning should have been logged");
  assert.match(String(warnings[0][0]), /levelUpRewards conflict for key "10"/);
});

test("duplicate natural key with identical content is deduped silently (no warning)", () => {
  const raw = [
    entry("BADGE_A", "badgeSettings", { badgeType: "BADGE_X", badgeRank: 1 }),
    entry("BADGE_A_DUP", "badgeSettings", { badgeType: "BADGE_X", badgeRank: 1 }),
  ];

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  let index: ReturnType<typeof createGameMasterIndex>;
  try {
    index = createGameMasterIndex(raw);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 0, "identical duplicate content is a harmless re-declaration, not a conflict worth logging");
  assert.equal(index.getBadgeSettings("BADGE_X")?.badgeRank, 1);
});

// Real-data smoke test -- guarded by existsSync since GAME_MASTER.json is a
// large untracked scratch file (docs/drafts/), not something every checkout
// or CI run is expected to have.
const GAME_MASTER_PATH = resolve(import.meta.dirname, "../docs/drafts/GAME_MASTER.json");

test("real GAME_MASTER.json indexes without throwing and exposes the expected categories", { skip: !existsSync(GAME_MASTER_PATH) }, () => {
  const raw = JSON.parse(readFileSync(GAME_MASTER_PATH, "utf-8")) as unknown[];
  const index = createGameMasterIndex(raw);

  assert.ok(index.allPokemonSettings().length > 2000);
  assert.ok(index.allGenderSettings().length > 2000);
  assert.ok(index.allFormSettings().length > 900);
  assert.ok(index.allMoveSettings().length > 300);
  assert.ok(index.allCombatMoves().length > 300);
  assert.equal(index.allTypeEffective().length, 18);
  assert.equal(index.allWeatherAffinities().length, 7);
  assert.ok(index.getPlayerLevelSettings()?.requiredExperience.length === 80);
  assert.ok(index.allLevelUpRewards().length > 0);
  assert.ok(index.allBadgeSettings().length > 900);
  assert.ok(index.allFriendshipMilestoneSettings().length > 0);
  assert.ok(index.allCombatLeagues().length > 0);

  // A known real record, spot-checked directly against the file.
  assert.equal(index.getPokemonSettings("BULBASAUR", "BULBASAUR_NORMAL")?.pokemonId, "BULBASAUR");
  assert.equal(index.getMoveSettings("WRAP")?.movementId, "WRAP");
});
