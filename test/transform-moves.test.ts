import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFormMoves, buildMoves, buildTypeEffectivenessAndWeather, titleCaseEnumToken } from "../scripts/ingest/transform/moves";
import { buildSpecies } from "../scripts/ingest/transform/species";
import { gameMasterFrom, genderSettings, pokedexEntry, pokedexFrom, pokemonSettings, shinySheetFrom } from "./transform-fixtures";

function moveSettings(record: Record<string, unknown>): [string, Record<string, unknown>] {
  return ["moveSettings", { templateId: `V_MOVE_${record.movementId}`, ...record }];
}
function combatMove(record: Record<string, unknown>): [string, Record<string, unknown>] {
  return ["combatMove", { templateId: `COMBAT_V_MOVE_${record.uniqueId}`, ...record }];
}

const MOVE_FIXTURE = gameMasterFrom([
  moveSettings({ movementId: "VINE_WHIP_FAST", pokemonType: "POKEMON_TYPE_GRASS", power: 7, energyDelta: 6, durationMs: 500 }),
  moveSettings({ movementId: "SLUDGE_BOMB", pokemonType: "POKEMON_TYPE_POISON", power: 80, energyDelta: -50, durationMs: 2300 }),
  moveSettings({ movementId: "FRENZY_PLANT", pokemonType: "POKEMON_TYPE_GRASS", power: 100, energyDelta: -50, durationMs: 2600 }),
  // No combatMove counterpart — PvP columns stay null, same as when the PvP
  // numbers came from a separate endpoint that didn't list the move.
  moveSettings({ movementId: "HORN_DRILL", pokemonType: "POKEMON_TYPE_NORMAL", power: 70, energyDelta: -50, durationMs: 2000 }),
  // Placeholder record that must never reach the moves table.
  moveSettings({ movementId: "VN_BM_001", pokemonType: "POKEMON_TYPE_NORMAL", power: 10, energyDelta: -10, durationMs: 1000 }),
  combatMove({ uniqueId: "VINE_WHIP_FAST", type: "POKEMON_TYPE_GRASS", power: 5, energyDelta: 8 }),
  combatMove({ uniqueId: "SLUDGE_BOMB", type: "POKEMON_TYPE_POISON", power: 80, energyDelta: -50 }),
  combatMove({ uniqueId: "FRENZY_PLANT", type: "POKEMON_TYPE_GRASS", power: 100, energyDelta: -45 }),
]);

const MOVE_POKEDEX = pokedexFrom([
  pokedexEntry({
    id: "BULBASAUR",
    dexNr: 1,
    primaryType: { type: "POKEMON_TYPE_GRASS" },
    quickMoves: { VINE_WHIP_FAST: { names: { English: "Vine Whip" } } },
    cinematicMoves: { SLUDGE_BOMB: { names: { English: "Sludge Bomb" } } },
    eliteCinematicMoves: { FRENZY_PLANT: { names: { English: "Frenzy Plant" } } },
  } as never),
]);

test("moves are built from moveSettings, categorised by the _FAST id suffix, with combatMove supplying PvP stats", () => {
  const { moves, slugByMovementId } = buildMoves(MOVE_FIXTURE, MOVE_POKEDEX);

  const bySlug = (slug: string) => moves.find((m) => m.slug === slug)!;
  assert.deepEqual(bySlug("vine-whip-fast"), {
    slug: "vine-whip-fast",
    name: "Vine Whip",
    category: "fast",
    typeSlug: "grass",
    power: 7,
    energyDelta: 6,
    durationMs: 500,
    pvpPower: 5,
    pvpEnergyDelta: 8,
    // durationTurns absent means a one-turn move.
    pvpTurns: 1,
  });
  assert.equal(bySlug("sludge-bomb-charged").category, "charged");
  assert.equal(bySlug("horn-drill-charged").pvpPower, null);
  assert.equal(bySlug("horn-drill-charged").pvpTurns, null);
  assert.equal(slugByMovementId.get("FRENZY_PLANT"), "frenzy-plant-charged");
});

test("durationTurns is turns-minus-one", () => {
  const gm = gameMasterFrom([
    moveSettings({ movementId: "TAKE_DOWN_FAST", pokemonType: "POKEMON_TYPE_NORMAL", power: 8, energyDelta: 10, durationMs: 1200 }),
    combatMove({ uniqueId: "TAKE_DOWN_FAST", type: "POKEMON_TYPE_NORMAL", power: 5, energyDelta: 3, durationTurns: 2 }),
  ]);

  assert.equal(buildMoves(gm, pokedexFrom([])).moves[0].pvpTurns, 3);
});

test("GAME_MASTER placeholder moves (VN_BM_*) are excluded", () => {
  const { moves, slugByMovementId } = buildMoves(MOVE_FIXTURE, MOVE_POKEDEX);

  assert.equal(moves.some((m) => m.slug.startsWith("vn-bm")), false);
  assert.equal(slugByMovementId.has("VN_BM_001"), false);
});

test("move names come from the move id, and only take pokemon-go-api's spelling when the slug is unaffected", () => {
  const gm = gameMasterFrom([
    // Four distinct moves pokemon-go-api all calls "Weather Ball" — using
    // its name would collapse them onto one slug.
    moveSettings({ movementId: "WEATHER_BALL_FIRE", pokemonType: "POKEMON_TYPE_FIRE", power: 55, energyDelta: -33, durationMs: 2000 }),
    moveSettings({ movementId: "WEATHER_BALL_ICE", pokemonType: "POKEMON_TYPE_ICE", power: 55, energyDelta: -33, durationMs: 2000 }),
    moveSettings({ movementId: "X_SCISSOR", pokemonType: "POKEMON_TYPE_BUG", power: 45, energyDelta: -33, durationMs: 1500 }),
  ]);
  const pokedex = pokedexFrom([
    pokedexEntry({
      id: "CASTFORM",
      dexNr: 351,
      cinematicMoves: {
        WEATHER_BALL_FIRE: { names: { English: "Weather Ball" } },
        WEATHER_BALL_ICE: { names: { English: "Weather Ball" } },
        X_SCISSOR: { names: { English: "X-Scissor" } },
      },
    } as never),
  ]);

  const { moves } = buildMoves(gm, pokedex);

  assert.deepEqual(
    moves.map((m) => [m.slug, m.name]),
    [
      ["weather-ball-fire-charged", "Weather Ball Fire"],
      ["weather-ball-ice-charged", "Weather Ball Ice"],
      // Same slug either way, so the published spelling wins.
      ["x-scissor-charged", "X-Scissor"],
    ],
  );
});

test("colliding move slugs keep every record by appending the move id", () => {
  const gm = gameMasterFrom([
    moveSettings({ movementId: "AURA_WHEEL", pokemonType: "POKEMON_TYPE_ELECTRIC", power: 100, energyDelta: -50, durationMs: 2000 }),
    moveSettings({ movementId: "AURA__WHEEL", pokemonType: "POKEMON_TYPE_DARK", power: 100, energyDelta: -50, durationMs: 2000 }),
  ]);

  const { moves } = buildMoves(gm, pokedexFrom([]));

  assert.deepEqual(moves.map((m) => m.slug), ["aura-wheel-charged", "aura-wheel-charged-aura-wheel"]);
  assert.equal(new Set(moves.map((m) => m.slug)).size, 2);
});

test("form moves apply the species' base move pool to its Standard forms only, marking elite moves", () => {
  const gameMaster = gameMasterFrom([
    ...MOVE_FIXTURE.allMoveSettings().map((r) => moveSettings(r)),
    ...MOVE_FIXTURE.allCombatMoves().map((r) => combatMove(r)),
    genderSettings("SPAWN_V0001_POKEMON_BULBASAUR", "BULBASAUR", { malePercent: 0.875, femalePercent: 0.125 }),
    pokemonSettings({
      pokemonId: "BULBASAUR",
      form: "BULBASAUR_NORMAL",
      quickMoves: ["VINE_WHIP_FAST"],
      cinematicMoves: ["SLUDGE_BOMB"],
      eliteCinematicMove: ["FRENZY_PLANT"],
    }),
  ]);
  const pokedex = pokedexFrom([
    pokedexEntry({
      id: "BULBASAUR",
      dexNr: 1,
      assetForms: [{ form: null, costume: "HOLIDAY", isFemale: false, image: "c.png" }],
    }),
  ]);

  const { forms } = buildSpecies({ pokedex, gameMaster, shinySheet: shinySheetFrom([]) });
  const { slugByMovementId } = buildMoves(gameMaster, pokedex);
  const formMoves = buildFormMoves(gameMaster, pokedex, forms, slugByMovementId);

  // Two Standard forms (male/female) x 3 moves; the costume form gets none.
  assert.equal(formMoves.length, 6);
  assert.equal(formMoves.some((fm) => fm.formSlug.includes("holiday")), false);
  assert.deepEqual(
    formMoves.filter((fm) => fm.formSlug === "bulbasaur-standard-male"),
    [
      { formSlug: "bulbasaur-standard-male", moveSlug: "vine-whip-fast", isElite: false },
      { formSlug: "bulbasaur-standard-male", moveSlug: "sludge-bomb-charged", isElite: false },
      { formSlug: "bulbasaur-standard-male", moveSlug: "frenzy-plant-charged", isElite: true },
    ],
  );
});

test("type effectiveness decodes attackScalar against the POKEMON_TYPE ordinal order", () => {
  // Real GAME_MASTER rows — the ordinal order these are indexed by is not
  // published anywhere in the dump, so this test is what pins it.
  const gm = gameMasterFrom([
    ["typeEffective", { templateId: "POKEMON_TYPE_BUG", attackType: "POKEMON_TYPE_BUG", attackScalar: [1, 0.625, 0.625, 0.625, 1, 1, 1, 0.625, 0.625, 0.625, 1, 1.6, 1, 1.6, 1, 1, 1.6, 0.625] }],
    ["typeEffective", { templateId: "POKEMON_TYPE_NORMAL", attackType: "POKEMON_TYPE_NORMAL", attackScalar: [1, 1, 1, 1, 1, 0.625, 1, 0.390625, 0.625, 1, 1, 1, 1, 1, 1, 1, 1, 1] }],
    ["weatherAffinities", { templateId: "WEATHER_AFFINITY_PARTLY_CLOUDY", weatherCondition: "PARTLY_CLOUDY", pokemonType: ["POKEMON_TYPE_NORMAL", "POKEMON_TYPE_ROCK"] }],
  ]);

  const { typeEffectiveness, weatherBoosts } = buildTypeEffectivenessAndWeather(gm);

  assert.equal(typeEffectiveness.length, 36);
  const mult = (a: string, d: string) => typeEffectiveness.find((t) => t.attackingTypeSlug === a && t.defendingTypeSlug === d)?.multiplier;
  assert.equal(mult("bug", "grass"), 1.6);
  assert.equal(mult("bug", "psychic"), 1.6);
  assert.equal(mult("bug", "dark"), 1.6);
  assert.equal(mult("bug", "fairy"), 0.625);
  assert.equal(mult("bug", "normal"), 1);
  assert.equal(mult("normal", "rock"), 0.625);
  assert.equal(mult("normal", "steel"), 0.625);
  assert.equal(mult("normal", "ghost"), 0.390625);

  assert.deepEqual(weatherBoosts, [
    { weather: "Partly Cloudy", typeSlug: "normal" },
    { weather: "Partly Cloudy", typeSlug: "rock" },
  ]);
});

test("titleCaseEnumToken turns an enum id into a display string", () => {
  assert.equal(titleCaseEnumToken("VINE_WHIP"), "Vine Whip");
  assert.equal(titleCaseEnumToken("PARTLY_CLOUDY"), "Partly Cloudy");
  assert.equal(titleCaseEnumToken("BADGE_7_DAY_STREAKS"), "Badge 7 Day Streaks");
});
