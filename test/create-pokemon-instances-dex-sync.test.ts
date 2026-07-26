import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runPersonalMigrations } from "../src/db/migrations";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { createInMemoryRepository, type PersonalState, type InMemoryStoreHooks } from "../src/data/in-memory-store";
import { resolveInstanceAchievementField } from "../src/db/cascades";
import type { ReferenceData } from "../src/db/reference-data";
import type { PokemonInstance } from "../src/db/types";

// Minimal harness: exercises the real INSERT + cascade SQL sqlite-repository.ts
// runs, without needing the full createSqliteRepository (which requires a
// live getDb()/persistDb() pair this test doesn't have). Mirrors the raw-SQL
// setup style already used by test/iv-generated-column.test.ts.
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF"); // form_slug/profile_id reference tables this test doesn't create
  return db;
}

test("logging a shiny catch flips form_personal.shiny and species_personal.registered", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  // runPersonalMigrations itself re-enables foreign_keys at the end (see
  // src/db/migrations.ts) regardless of the pragma freshDb() set beforehand,
  // so it must be turned off again here -- same two-step pattern
  // test/iv-generated-column.test.ts already uses -- before inserting a row
  // that references form_slug/profile_id tables this test doesn't create.
  db.exec("PRAGMA foreign_keys = OFF");

  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at, shiny) VALUES ('bulbasaur-standard', '1', 0, 0, 1)",
  ).run();

  // Simulates what Task 3's createPokemonInstances change does after insert:
  // resolve the field, then apply the same UPSERT shape sqlite-repository.ts's
  // onFormPersonalChanged hook writes (see buildFormPersonalUpsert() in
  // src/data/profile-scoped-write-sql.ts) — composite PK (profile_id, form_slug)
  // / (profile_id, species_slug) per Task 1's schema widening.
  db.prepare(
    `INSERT INTO form_personal (form_slug, profile_id, shiny, updated_at) VALUES ('bulbasaur-standard', '1', 1, 1)
     ON CONFLICT(profile_id, form_slug) DO UPDATE SET shiny = 1, caught = 1, updated_at = 1`,
  ).run();
  db.prepare(
    `INSERT INTO form_personal (form_slug, profile_id, caught, updated_at) VALUES ('bulbasaur-standard', '1', 1, 1)
     ON CONFLICT(profile_id, form_slug) DO UPDATE SET caught = 1, updated_at = 1`,
  ).run();
  db.prepare(
    `INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '1', 1, 1)
     ON CONFLICT(profile_id, species_slug) DO UPDATE SET registered = 1, updated_at = 1`,
  ).run();

  const form = db.prepare("SELECT shiny, caught FROM form_personal WHERE form_slug = 'bulbasaur-standard'").get() as {
    shiny: number;
    caught: number;
  };
  assert.equal(form.shiny, 1);
  assert.equal(form.caught, 1);

  const species = db.prepare("SELECT registered FROM species_personal WHERE species_slug = 'bulbasaur'").get() as {
    registered: number;
  };
  assert.equal(species.registered, 1);
});

// --- Integration-level test against the real in-memory engine ---
//
// Deviation from the brief's Step 5 sketch: `createInMemoryRepository`'s
// return type is `Omit<Repository, "getCompletionStats" | "createPokemonInstances"
// | "createTag">` -- those three methods were deliberately moved out into
// sqlite-repository.ts (see commit 264d713) because row creation needs a
// real AUTOINCREMENT id that only the live SQLite connection can hand back.
// There is no separate "dummy backend" implementing createPokemonInstances
// to call directly or to mirror Task 3's change into -- in-memory-store.ts's
// createPokemonInstances simply does not exist. Nor is `createSqliteRepository`
// (the only real implementation) callable here: it hard-calls the singleton
// `getDb()` (see src/data/sqlite-repository.ts), not an injectable connection,
// so it can't run against this test's throwaway DatabaseSync without
// production-code changes out of scope for this task.
//
// Instead, this test exercises exactly the two moving parts Task 3 wires
// together -- resolveInstanceAchievementField (Task 2) and the real
// setFormPersonalField/cascade machinery this file's createInMemoryRepository
// implements -- the same call sequence sqlite-repository.ts's
// createPokemonInstances now performs after every insert.
function emptyReferenceData(): ReferenceData {
  return {
    regions: [],
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
}

function emptyPersonalState(): PersonalState {
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
    profile: { id: 1, username: "Trainer", friendCode: null, createdAt: 0 },
  };
}

function noopHooks(): InMemoryStoreHooks {
  return {
    onSpeciesPersonalChanged() {},
    onFormPersonalChanged() {},
    onAppSettingChanged() {},
    onMegaPersonalChanged() {},
    onFormBackgroundPersonalAdded() {},
    onMedalProgressChanged() {},
    onPlayerProgressChanged() {},
    onPlayerProgressLogAppended() {},
    onPokemonInstanceStatusChanged() {},
    onProfileChanged() {},
  };
}

test("resolveInstanceAchievementField + setFormPersonalField (in-memory engine) flips form_personal.shiny/caught and species_personal.registered", () => {
  const state = emptyPersonalState();
  const repo = createInMemoryRepository(emptyReferenceData(), state, noopHooks());

  // Mirrors exactly what sqlite-repository.ts's createPokemonInstances does
  // after inserting a new pokemon_instance row: resolve the achievement
  // field for the created instance, then apply it through the shared
  // cascade machinery.
  const instance: PokemonInstance = {
    id: 1,
    formSlug: "bulbasaur-standard",
    profileId: 1,
    status: "kept",
    recordedAt: 0,
    caughtAt: null,
    updatedAt: 0,
    cp: null,
    ivAttack: null,
    ivDefense: null,
    ivStamina: null,
    ivPercent: null,
    shiny: true,
    lucky: false,
    shadow: false,
    purified: false,
    dynamax: false,
    receivedViaTrade: false,
    heartsEarned: null,
    currentMegaLevel: null,
    nickname: null,
    backgroundSlug: null,
  };

  repo.setFormPersonalField(instance.formSlug, resolveInstanceAchievementField(instance), true);

  assert.equal(state.formPersonal["bulbasaur-standard"]?.shiny, true);
  assert.equal(state.formPersonal["bulbasaur-standard"]?.caught, true);
  assert.equal(state.speciesPersonal["bulbasaur"]?.registered, true);
});
