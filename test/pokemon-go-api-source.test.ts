import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PGAPI_FILES,
  createMegaSource,
  createPokedexSource,
  createRaidBossSource,
  createTypesSource,
  type PokedexEntry,
  type RaidBossListRaw,
  type TypeMatchup,
} from "../scripts/ingest/sources/pokemon-go-api";

test("PGAPI_FILES names the 3 cached pgapi files this pipeline consumes against their real URLs (raidboss.json is deliberately excluded -- unused by any transform, see the module's header comment)", () => {
  assert.deepEqual(PGAPI_FILES, {
    "pgapi/pokedex.json": "https://pokemon-go-api.github.io/pokemon-go-api/api/pokedex.json",
    "pgapi/types.json": "https://pokemon-go-api.github.io/pokemon-go-api/api/types.json",
    "pgapi/mega.json": "https://pokemon-go-api.github.io/pokemon-go-api/api/pokedex/mega.json",
  });
});

test("createPokedexSource indexes by id and exposes the full list", () => {
  const raw: PokedexEntry[] = [
    { id: "BULBASAUR", formId: "BULBASAUR", dexNr: 1, names: { English: "Bulbasaur" } },
    { id: "IVYSAUR", formId: "IVYSAUR", dexNr: 2, names: { English: "Ivysaur" } },
  ];
  const source = createPokedexSource(raw);

  assert.equal(source.all().length, 2);
  assert.equal(source.byId("IVYSAUR")?.dexNr, 2);
  assert.equal(source.byId("MISSINGNO"), undefined);
});

test("createTypesSource indexes by English type name", () => {
  const raw: TypeMatchup[] = [
    { type: "Fighting", names: { English: "Fighting" }, doubleDamageFrom: ["Flying", "Psychic", "Fairy"], halfDamageFrom: ["Rock", "Bug", "Dark"], noDamageFrom: [] },
  ];
  const source = createTypesSource(raw);

  assert.equal(source.all().length, 1);
  assert.deepEqual(source.byType("Fighting")?.doubleDamageFrom, ["Flying", "Psychic", "Fairy"]);
  assert.equal(source.byType("Steel"), undefined);
});

test("createMegaSource groups multiple mega-variant entries for the same base id (Charizard-style duplication)", () => {
  const raw: PokedexEntry[] = [
    { id: "CHARIZARD", formId: "CHARIZARD", dexNr: 6, names: { English: "Charizard" }, megaEvolutions: { CHARIZARD_MEGA_X: {} } },
    { id: "CHARIZARD", formId: "CHARIZARD", dexNr: 6, names: { English: "Charizard" }, megaEvolutions: { CHARIZARD_MEGA_Y: {} } },
    { id: "VENUSAUR", formId: "VENUSAUR", dexNr: 3, names: { English: "Venusaur" }, megaEvolutions: { VENUSAUR_MEGA: {} } },
  ];
  const source = createMegaSource(raw);

  assert.equal(source.all().length, 3);
  assert.equal(source.byId("CHARIZARD").length, 2);
  assert.equal(source.byId("VENUSAUR").length, 1);
  assert.deepEqual(source.byId("MISSINGNO"), []);
});

test("createRaidBossSource flattens currentList across tiers and supports per-tier lookup", () => {
  const raw: RaidBossListRaw = {
    currentList: {
      lvl1: [{ id: "PIKACHU", form: "PIKACHU", costume: null, level: "lvl1", names: { English: "Pikachu" }, shiny: true, types: ["Electric"], cpRange: [493, 536], cpRangeBoost: [616, 670] }],
      mega: [{ id: "SCEPTILE", form: "SCEPTILE_MEGA", costume: null, level: "mega", names: { English: "Mega Sceptile" }, shiny: true, types: ["Grass", "Dragon"], cpRange: [1500, 1575], cpRangeBoost: [1876, 1969] }],
    },
  };
  const source = createRaidBossSource(raw);

  assert.equal(source.all().length, 2);
  assert.equal(source.byTier("lvl1")[0]?.id, "PIKACHU");
  assert.equal(source.byTier("mega")[0]?.id, "SCEPTILE");
  assert.deepEqual(source.byTier("lvl5"), [], "an absent tier key must yield an empty array, not throw");
});
