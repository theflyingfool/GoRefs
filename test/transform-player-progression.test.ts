import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPlayerProgression } from "../scripts/ingest/transform/player-progression";
import { gameMasterFrom } from "./transform-fixtures";

const PLAYER_LEVEL_CURVE = Array.from({ length: 80 }, (_, i) => i * 1000);

function playerLevel(requiredExperience: number[]): [string, Record<string, unknown>] {
  return ["playerLevel", { templateId: "PLAYER_LEVEL_SETTINGS", requiredExperience, cpMultiplier: requiredExperience.map(() => 0.5), milestoneLevels: [10, 20, 30, 40, 50, 60, 70, 80] }];
}

/** sources/game-master.ts logs real duplicate-natural-key conflicts on purpose; a fixture that exercises one shouldn't look like a test failure. */
function withoutWarnings<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

test("player levels come from GAME_MASTER's full level-80 XP curve, index 0 = level 1", () => {
  const { playerLevels } = buildPlayerProgression(gameMasterFrom([playerLevel(PLAYER_LEVEL_CURVE)]));

  assert.equal(playerLevels.length, 80);
  assert.deepEqual(playerLevels[0], { level: 1, cumulativeXp: 0 });
  assert.deepEqual(playerLevels[49], { level: 50, cumulativeXp: 49000 });
  // The old source stopped at 50 and levels 51-80 were seeded with null; the
  // real curve covers all 80, so nothing is null any more.
  assert.equal(playerLevels.every((l) => l.cumulativeXp !== null), true);
  assert.deepEqual(playerLevels[79], { level: 80, cumulativeXp: 79000 });
});

test("levels the curve doesn't cover are still emitted with a null XP so the FK target exists", () => {
  const { playerLevels } = buildPlayerProgression(gameMasterFrom([playerLevel([0, 1000, 3000])]));

  assert.equal(playerLevels.length, 80);
  assert.deepEqual(playerLevels[2], { level: 3, cumulativeXp: 3000 });
  assert.deepEqual(playerLevels[3], { level: 4, cumulativeXp: null });
  assert.equal(playerLevels.at(-1)?.level, 80);
});

test("level-up rewards pair items with their counts and get a per-level running sort order", () => {
  // The AWARDS/BACKFILL_AWARDS pair below is a real duplicate-key conflict,
  // which sources/game-master.ts logs on purpose — silenced here so it
  // doesn't look like a test failure.
  const gameMaster = withoutWarnings(() =>
    gameMasterFrom([
      playerLevel(PLAYER_LEVEL_CURVE),
      ["levelUpRewards", { templateId: "AWARDS_LEVEL_2", level: 2, items: ["ITEM_POKE_BALL", "ITEM_NANAB_BERRY"], itemsCount: [10, 3] }],
      // The backfill duplicate must not double up the level's rewards.
      ["levelUpRewards", { templateId: "BACKFILL_AWARDS_LEVEL_2", level: 2, items: ["ITEM_POKE_BALL"], itemsCount: [10] }],
      ["levelUpRewards", { templateId: "AWARDS_LEVEL_3", level: 3, items: ["ITEM_POTION"], itemsCount: [10] }],
      // Past the level cap — no player_level row to reference.
      ["levelUpRewards", { templateId: "AWARDS_LEVEL_99", level: 99, items: ["ITEM_POTION"], itemsCount: [1] }],
    ]),
  );

  const { playerLevelRewards } = buildPlayerProgression(gameMaster);

  assert.deepEqual(playerLevelRewards, [
    { level: 2, sortOrder: 0, itemName: "Poke Ball", amount: 10 },
    { level: 2, sortOrder: 1, itemName: "Nanab Berry", amount: 3 },
    { level: 3, sortOrder: 0, itemName: "Potion", amount: 10 },
  ]);
});

test("medals derive slug and name from the badge id, with tier targets", () => {
  const { medals, medalTiers } = buildPlayerProgression(
    gameMasterFrom([
      playerLevel(PLAYER_LEVEL_CURVE),
      ["badgeSettings", { templateId: "BADGE_7_DAY_STREAKS", badgeType: "BADGE_7_DAY_STREAKS", badgeRank: 5, targets: [1, 10, 50, 100] }],
      ["badgeSettings", { templateId: "BADGE_AA_2023_JEJU_DAY_00", badgeType: "BADGE_AA_2023_JEJU_DAY_00", badgeRank: 2, eventBadge: true }],
    ]),
  );

  assert.deepEqual(medals, [
    { slug: "7-day-streaks", name: "7 Day Streaks", description: "", isEventMedal: false },
    // GAME_MASTER publishes no display strings, so the real name
    // ("Triathlete") and description are not recoverable — see this task's
    // report; both are derived from the badge id instead.
    { slug: "aa-2023-jeju-day-00", name: "Aa 2023 Jeju Day 00", description: "", isEventMedal: true },
  ]);
  assert.deepEqual(medalTiers, [
    { medalSlug: "7-day-streaks", rank: 1, target: 1 },
    { medalSlug: "7-day-streaks", rank: 2, target: 10 },
    { medalSlug: "7-day-streaks", rank: 3, target: 50 },
    { medalSlug: "7-day-streaks", rank: 4, target: 100 },
    { medalSlug: "aa-2023-jeju-day-00", rank: 2, target: null },
  ]);
});

test("same-slug badges collapse to one medal and one targetless tier row", () => {
  const { medals, medalTiers } = buildPlayerProgression(
    gameMasterFrom([
      playerLevel(PLAYER_LEVEL_CURVE),
      ["badgeSettings", { templateId: "BADGE_EVENT", badgeType: "BADGE_EVENT", badgeRank: 2, eventBadge: true }],
      ["badgeSettings", { templateId: "BADGE_EVENT_2", badgeType: "BADGE_EVENT", badgeRank: 2, eventBadge: true }],
    ]),
  );

  assert.equal(medals.length, 1);
  assert.equal(medalTiers.length, 1);
  assert.equal(new Set(medalTiers.map((t) => `${t.medalSlug}|${t.rank}`)).size, medalTiers.length);
});

test("friendship levels take their number from the templateId and keep production's names", () => {
  const { friendshipLevels } = buildPlayerProgression(
    gameMasterFrom([
      playerLevel(PLAYER_LEVEL_CURVE),
      ["friendshipMilestoneSettings", { templateId: "FRIENDSHIP_LEVEL_2", minPointsToReach: 7, milestoneXpReward: 10000, attackBonusPercentage: 1.05, raidBallBonus: 1, tradingDiscount: 0.2 }],
      ["friendshipMilestoneSettings", { templateId: "FRIENDSHIP_LEVEL_0", milestoneXpReward: 1000, attackBonusPercentage: 1 }],
      // GAME_MASTER has a sixth record no source names and production has
      // never carried — deliberately not emitted.
      ["friendshipMilestoneSettings", { templateId: "FRIENDSHIP_LEVEL_5", minPointsToReach: 90, milestoneXpReward: 150000, attackBonusPercentage: 1.12 }],
    ]),
  );

  assert.deepEqual(friendshipLevels, [
    { level: 0, name: "Friend", pointsRequired: 0, xpReward: 1000, attackBonus: 1, tradingDiscount: 0, raidBallBonus: 0 },
    { level: 2, name: "Great Friend", pointsRequired: 7, xpReward: 10000, attackBonus: 1.05, tradingDiscount: 0.2, raidBallBonus: 1 },
  ]);
});
