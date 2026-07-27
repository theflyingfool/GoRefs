import { test } from "node:test";
import assert from "node:assert/strict";

import { createInMemoryRepository, type PersonalState } from "../src/data/in-memory-store";
import type { ReferenceData } from "../src/db/reference-data";

// Regression test for a real bug: on a device upgraded from before
// DEFAULT_PROFILE_ID existed, the actual `profile` table row can have an id
// other than 1. setPlayerProgress/setMedalProgress/createPokemonInstances/
// createTag used to hardcode DEFAULT_PROFILE_ID (1) instead of the real
// profile id, which throws "FOREIGN KEY constraint failed" against a real
// SQLite `player_progress_personal`/`medal_progress_personal` table on such
// a device the first time either write path is actually exercised (species/
// form toggles never hit this because those tables are pre-seeded and only
// ever go through an UPDATE that never touches profile_id).
const referenceData: ReferenceData = {
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
  medals: [{ slug: "collector", name: "Collector", description: "Catch Pokémon", isEventMedal: false }],
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

function stateWithProfileId(profileId: string): PersonalState {
  return {
    speciesPersonal: {},
    formPersonal: {},
    appSettings: {},
    megaPersonal: {},
    formBackgroundPersonal: [],
    medalProgress: {},
    pokemonInstances: [],
    pokemonInstanceTags: [],
    playerProgress: undefined,
    playerProgressLog: [],
    profile: { id: profileId, username: "Trainer", friendCode: null, createdAt: Date.now() },
  };
}

test("setPlayerProgress uses the real profile id, not a hardcoded default", () => {
  const seenProfileIds: string[] = [];
  const repo = createInMemoryRepository(referenceData, stateWithProfileId("42"), {
    onSpeciesPersonalChanged() {},
    onFormPersonalChanged() {},
    onAppSettingChanged() {},
    onMegaPersonalChanged() {},
    onFormBackgroundPersonalAdded() {},
    onMedalProgressChanged() {},
    onPlayerProgressChanged(progress) {
      seenProfileIds.push(progress.profileId);
    },
    onPlayerProgressLogAppended(entry) {
      seenProfileIds.push(entry.profileId);
    },
    onPokemonInstanceStatusChanged() {},
  }, () => []);

  repo.setPlayerProgress(40, 12345);

  assert.deepEqual(seenProfileIds, ["42", "42"]);
  assert.equal(repo.getPlayerProgress()?.profileId, "42");
});

test("setMedalProgress uses the real profile id, not a hardcoded default", () => {
  let seenProfileId: string | undefined;
  const repo = createInMemoryRepository(referenceData, stateWithProfileId("42"), {
    onSpeciesPersonalChanged() {},
    onFormPersonalChanged() {},
    onAppSettingChanged() {},
    onMegaPersonalChanged() {},
    onFormBackgroundPersonalAdded() {},
    onMedalProgressChanged(_medalSlug, progress) {
      seenProfileId = progress.profileId;
    },
    onPlayerProgressChanged() {},
    onPlayerProgressLogAppended() {},
    onPokemonInstanceStatusChanged() {},
  }, () => []);

  repo.setMedalProgress("collector", 1, 5);

  assert.equal(seenProfileId, "42");
  assert.equal(repo.listMedalProgress().find((m) => m.medal.slug === "collector")?.progress.profileId, "42");
});
