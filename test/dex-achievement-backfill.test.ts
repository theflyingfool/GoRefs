import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInstanceAchievementField } from "../src/db/cascades";
import { applyDexAchievementBackfillIfNeeded } from "../src/data/dex-achievement-backfill";
import { createInMemoryRepository, type PersonalState, type InMemoryStoreHooks } from "../src/data/in-memory-store";
import type { ReferenceData } from "../src/db/reference-data";
import type { PokemonInstance } from "../src/db/types";

// Fixtures mirror test/create-pokemon-instances-dex-sync.test.ts's established
// pattern for building a minimal PersonalState/ReferenceData pair to drive
// the real createInMemoryRepository engine (no live getDb() needed).
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
      {
        slug: "charmander",
        dexNumber: 4,
        name: "Charmander",
        familySlug: "charmander",
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
      {
        slug: "charmander-standard",
        speciesSlug: "charmander",
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

function makeInstance(overrides: Partial<PokemonInstance>): PokemonInstance {
  return {
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
    shiny: false,
    lucky: false,
    shadow: false,
    purified: false,
    dynamax: false,
    receivedViaTrade: false,
    heartsEarned: null,
    currentMegaLevel: null,
    nickname: null,
    backgroundSlug: null,
    ...overrides,
  };
}

test("applyDexAchievementBackfillIfNeeded sets the real form_personal/species_personal flags for each pokemon_instance", () => {
  const state = emptyPersonalState();
  state.pokemonInstances = [
    makeInstance({ id: 1, formSlug: "bulbasaur-standard", shiny: true }),
    makeInstance({ id: 2, formSlug: "charmander-standard", shiny: false, ivPercent: 100 }),
  ];
  const repo = createInMemoryRepository(emptyReferenceData(), state, noopHooks());

  const ran = applyDexAchievementBackfillIfNeeded(state, repo);

  assert.equal(ran, true);
  // Real assertions against state.formPersonal/state.speciesPersonal after
  // the cascade runs -- not against resolveInstanceAchievementField's output.
  assert.equal(state.formPersonal["bulbasaur-standard"]?.shiny, true);
  assert.equal(state.formPersonal["bulbasaur-standard"]?.caught, true);
  assert.equal(state.speciesPersonal["bulbasaur"]?.registered, true);

  assert.equal(state.formPersonal["charmander-standard"]?.fourStar, true);
  assert.equal(state.formPersonal["charmander-standard"]?.caught, true);
  assert.equal(state.speciesPersonal["charmander"]?.registered, true);

  assert.equal(state.appSettings["dexAchievementBackfillV9Complete"], "1");
});

test("applyDexAchievementBackfillIfNeeded is a genuine no-op on a second call (marker gate short-circuits)", () => {
  const state = emptyPersonalState();
  state.pokemonInstances = [makeInstance({ id: 1, formSlug: "bulbasaur-standard", shiny: true })];
  const repo = createInMemoryRepository(emptyReferenceData(), state, noopHooks());

  const firstRun = applyDexAchievementBackfillIfNeeded(state, repo);
  assert.equal(firstRun, true);
  assert.equal(state.formPersonal["bulbasaur-standard"]?.shiny, true);

  // Manually unset the flag the first run set, simulating a user later
  // un-marking it. If the second call actually re-iterated
  // pokemonInstances instead of being gated by the marker, this would flip
  // back to true.
  repo.setFormPersonalField("bulbasaur-standard", "shiny", false);
  assert.equal(state.formPersonal["bulbasaur-standard"]?.shiny, false);

  const secondRun = applyDexAchievementBackfillIfNeeded(state, repo);

  assert.equal(secondRun, false);
  assert.equal(state.formPersonal["bulbasaur-standard"]?.shiny, false, "second call must not re-touch the flag once the marker is set");
});

test("applyDexAchievementBackfillIfNeeded never unsets an already-true flag on an unrelated form (real cascade)", () => {
  const state = emptyPersonalState();
  const repo = createInMemoryRepository(emptyReferenceData(), state, noopHooks());

  // charmander-standard's shiny flag is already true going in, via some
  // unrelated prior action (e.g. logged directly rather than backfilled) --
  // set through the real cascade, not a hand-built FormPersonal literal.
  // A bulbasaur-only backfill pass must not touch it.
  repo.setFormPersonalField("charmander-standard", "shiny", true);
  assert.equal(state.formPersonal["charmander-standard"]?.shiny, true);

  state.pokemonInstances = [makeInstance({ id: 1, formSlug: "bulbasaur-standard", shiny: true })];

  applyDexAchievementBackfillIfNeeded(state, repo);

  assert.equal(state.formPersonal["bulbasaur-standard"]?.shiny, true);
  // Unrelated form's pre-existing flag is untouched.
  assert.equal(state.formPersonal["charmander-standard"]?.shiny, true);
});

// Lower-level unit test of resolveInstanceAchievementField alone -- kept
// because it's still useful as a fast, DB-free check of the pure derivation
// function, but the name is scoped to that (the real cascade/gating
// integration coverage lives in the tests above).
test("resolveInstanceAchievementField derives the expected achievement field per instance", () => {
  const instances = [
    { formSlug: "bulbasaur-standard", shiny: true, lucky: false, shadow: false, dynamax: false, ivPercent: null },
    { formSlug: "charmander-standard", shiny: false, lucky: false, shadow: false, dynamax: false, ivPercent: 100 },
  ];

  const fields = instances.map((instance) => resolveInstanceAchievementField(instance));

  assert.deepEqual(fields, ["shiny", "fourStar"]);
});
