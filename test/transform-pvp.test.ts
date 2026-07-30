import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPvp } from "../scripts/ingest/transform/pvp";
import { gameMasterFrom } from "./transform-fixtures";

function vsSeekerLoot(templateId: string, rankLevel: number, reward: unknown[], rewardTrack?: string): [string, Record<string, unknown>] {
  return ["vsSeekerLoot", { templateId, rankLevel, reward, ...(rewardTrack ? { rewardTrack } : {}) }];
}

test("rank rewards map every GAME_MASTER reward slot shape, per track, keeping slot order", () => {
  const { pvpRankRewards } = buildPvp(
    gameMasterFrom([
      vsSeekerLoot("VS_SEEKER_LOOT_PER_WIN_SETTINGS_RANK_1_FREE", 1, [
        { item: { stardust: true, count: 1200 } },
        { itemRankingLootTableCount: 1 },
        { pokemonReward: true },
        { item: { item: "ITEM_RARE_CANDY", count: 3 } },
      ]),
      vsSeekerLoot("VS_SEEKER_LOOT_PER_WIN_SETTINGS_RANK_1_PREMIUM", 1, [{ item: { stardust: true, count: 2400 } }], "PREMIUM"),
    ]),
  );

  assert.deepEqual(pvpRankRewards, [
    { leagueRank: 1, track: "free", sortOrder: 0, rewardType: "stardust", itemName: null, amount: 1200 },
    { leagueRank: 1, track: "free", sortOrder: 1, rewardType: "item_loot_table", itemName: null, amount: 1 },
    { leagueRank: 1, track: "free", sortOrder: 2, rewardType: "pokemon_from_pool", itemName: null, amount: null },
    { leagueRank: 1, track: "free", sortOrder: 3, rewardType: "item", itemName: "Rare Candy", amount: 3 },
    { leagueRank: 1, track: "premium", sortOrder: 0, rewardType: "stardust", itemName: null, amount: 2400 },
  ]);
  assert.equal(new Set(pvpRankRewards.map((r) => `${r.leagueRank}|${r.track}|${r.sortOrder}`)).size, pvpRankRewards.length);
});

test("an unrecognised reward slot is skipped without shifting the remaining slot indices", () => {
  const { pvpRankRewards } = buildPvp(
    gameMasterFrom([vsSeekerLoot("VS_SEEKER_LOOT_PER_WIN_SETTINGS_RANK_5_FREE", 5, [{}, { item: { stardust: true, count: 100 } }])]),
  );

  assert.deepEqual(pvpRankRewards, [{ leagueRank: 5, track: "free", sortOrder: 1, rewardType: "stardust", itemName: null, amount: 100 }]);
});

test("rank requirements come from the highest-numbered season, compared numerically", () => {
  const { pvpRankRequirements } = buildPvp(
    gameMasterFrom([
      // The legacy, season-less 10-rank ladder the previous source published.
      ["combatRankingProtoSettings", { templateId: "COMBAT_RANKING_SETTINGS", rankLevel: [{ rankLevel: 1 }, { rankLevel: 2, additionalTotalBattlesRequired: 5 }] }],
      // S9 must not beat S30 — a lexical sort would put it last.
      ["combatRankingProtoSettings", { templateId: "COMBAT_RANKING_SETTINGS_S9", rankLevel: [{ rankLevel: 1 }] }],
      [
        "combatRankingProtoSettings",
        {
          templateId: "COMBAT_RANKING_SETTINGS_S30",
          rankLevel: [
            { rankLevel: 1 },
            { rankLevel: 2, additionalTotalBattlesRequired: 5 },
            { rankLevel: 3, additionalWinsRequired: 1 },
            // minRatingRequired has no column — the rank still gets a row.
            { rankLevel: 21, minRatingRequired: 2000 },
          ],
        },
      ],
    ]),
  );

  assert.deepEqual(pvpRankRequirements, [
    { rank: 1, additionalBattlesRequired: null, additionalBattleWinsRequired: null },
    { rank: 2, additionalBattlesRequired: 5, additionalBattleWinsRequired: null },
    { rank: 3, additionalBattlesRequired: null, additionalBattleWinsRequired: 1 },
    { rank: 21, additionalBattlesRequired: null, additionalBattleWinsRequired: null },
  ]);
});

test("no PvP source data yields empty tables rather than throwing", () => {
  assert.deepEqual(buildPvp(gameMasterFrom([])), { pvpRankRewards: [], pvpRankRequirements: [] });
});
