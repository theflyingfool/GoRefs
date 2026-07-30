import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPlayerProgression } from "../scripts/ingest/transform/player-progression";
import { loadVendorBadgeDisplayNames } from "../scripts/ingest/sources/pogoapi-badges";
import { gameMasterFrom } from "./transform-fixtures";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReferenceData } from "../src/db/reference-data";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

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
  const { playerLevels } = buildPlayerProgression(gameMasterFrom([playerLevel(PLAYER_LEVEL_CURVE)]), []);

  assert.equal(playerLevels.length, 80);
  assert.deepEqual(playerLevels[0], { level: 1, cumulativeXp: 0 });
  assert.deepEqual(playerLevels[49], { level: 50, cumulativeXp: 49000 });
  // The old source stopped at 50 and levels 51-80 were seeded with null; the
  // real curve covers all 80, so nothing is null any more.
  assert.equal(playerLevels.every((l) => l.cumulativeXp !== null), true);
  assert.deepEqual(playerLevels[79], { level: 80, cumulativeXp: 79000 });
});

test("levels the curve doesn't cover are still emitted with a null XP so the FK target exists", () => {
  const { playerLevels } = buildPlayerProgression(gameMasterFrom([playerLevel([0, 1000, 3000])]), []);

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

  const { playerLevelRewards } = buildPlayerProgression(gameMaster, []);

  assert.deepEqual(playerLevelRewards, [
    { level: 2, sortOrder: 0, itemName: "Poke Ball", amount: 10 },
    { level: 2, sortOrder: 1, itemName: "Nanab Berry", amount: 3 },
    { level: 3, sortOrder: 0, itemName: "Potion", amount: 10 },
  ]);
});

test("with no vendored badge data, medals fall back to a slug/name derived from the badge id", () => {
  const { medals, medalTiers } = buildPlayerProgression(
    gameMasterFrom([
      playerLevel(PLAYER_LEVEL_CURVE),
      ["badgeSettings", { templateId: "BADGE_7_DAY_STREAKS", badgeType: "BADGE_7_DAY_STREAKS", badgeRank: 5, targets: [1, 10, 50, 100] }],
      ["badgeSettings", { templateId: "BADGE_AA_2023_JEJU_DAY_00", badgeType: "BADGE_AA_2023_JEJU_DAY_00", badgeRank: 2, eventBadge: true }],
    ]),
    // Empty vendorBadges: every badge falls back to the id-derived name.
    // This is also what happens for badges added to GAME_MASTER after the
    // vendored snapshot was taken (see the "index beyond the vendored
    // array" test below).
    [],
  );

  assert.deepEqual(medals, [
    { slug: "7-day-streaks", name: "7 Day Streaks", description: "", isEventMedal: false },
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

test("with vendored badge data, medal name/description come from the snapshot (via alignVendorBadges), not the badge id", () => {
  const { medals } = buildPlayerProgression(
    gameMasterFrom([
      playerLevel(PLAYER_LEVEL_CURVE),
      ["badgeSettings", { templateId: "BADGE_7_DAY_STREAKS", badgeType: "BADGE_7_DAY_STREAKS", badgeRank: 5, targets: [1, 10, 50, 100] }],
    ]),
    [{ name: "Triathlete", description: "Achieve a seven-day catch/spin streak.", rank: 5 }],
  );

  assert.deepEqual(medals, [{ slug: "triathlete", name: "Triathlete", description: "Achieve a seven-day catch/spin streak.", isEventMedal: false }]);
});

test("a vendored candidate whose rank never matches any badge present makes buildPlayerProgression throw instead of silently falling back", () => {
  // alignVendorBadges itself (test/pogoapi-badges-source.test.ts) is where
  // the join logic lives and is unit-tested directly; this just confirms
  // buildPlayerProgression propagates alignVendorBadges' now-hard failure
  // rather than swallowing it and trusting a partial result. (Before the
  // consumed-everything assertion was added, this silently fell back to
  // the id-derived medal name instead — exactly the misalignment risk the
  // assertion exists to catch.)
  assert.throws(
    () =>
      buildPlayerProgression(
        gameMasterFrom([
          playerLevel(PLAYER_LEVEL_CURVE),
          ["badgeSettings", { templateId: "BADGE_7_DAY_STREAKS", badgeType: "BADGE_7_DAY_STREAKS", badgeRank: 5, targets: [1, 10, 50, 100] }],
        ]),
        // rank 2 never appears among the one badge present (rank 5), so
        // alignVendorBadges never consumes it.
        [{ name: "Triathlete", description: "Achieve a seven-day catch/spin streak.", rank: 2 }],
      ),
    /alignVendorBadges: stalled at vendored index 0 of 1/,
  );
});

test("badges past the end of the vendored array (added to GAME_MASTER since the snapshot) still fall back to the id-derived name", () => {
  const { medals } = buildPlayerProgression(
    gameMasterFrom([
      playerLevel(PLAYER_LEVEL_CURVE),
      ["badgeSettings", { templateId: "BADGE_KNOWN", badgeType: "BADGE_KNOWN", badgeRank: 1, targets: [1] }],
      ["badgeSettings", { templateId: "BADGE_NEWER_THAN_SNAPSHOT", badgeType: "BADGE_NEWER_THAN_SNAPSHOT", badgeRank: 1, targets: [1] }],
    ]),
    // Only one vendored entry — index 1 (the second badge) has nothing to
    // look up and must fall back, not throw or silently reuse index 0.
    [{ name: "Known Badge", description: "A real name.", rank: 1 }],
  );

  assert.deepEqual(medals, [
    { slug: "known-badge", name: "Known Badge", description: "A real name.", isEventMedal: false },
    { slug: "newer-than-snapshot", name: "Newer Than Snapshot", description: "", isEventMedal: false },
  ]);
});

test("real vendored snapshot: BADGE_7_DAY_STREAKS at index 0 round-trips to the production 'Triathlete' medal slug", () => {
  const vendorBadges = loadVendorBadgeDisplayNames();
  assert.ok(vendorBadges.length > 0, "vendor/pogoapi-snapshot/badges.json should not be empty");

  // BADGE_7_DAY_STREAKS is GAME_MASTER's real index-0 badge (see
  // .superpowers/sdd/task-3-fix-medals-report.md); the vendored snapshot is
  // positionally aligned, so index 0 there must be the same badge. Only
  // that first (real, not fabricated) entry is passed through here — the
  // fixture badgeSettings below deliberately carries just the one matching
  // badge, and alignVendorBadges now throws unless every vendored entry it's
  // given gets consumed, so passing the full 597-entry snapshot against a
  // one-badge fixture would stall instead of testing what this test is for.
  const { medals } = buildPlayerProgression(
    gameMasterFrom([playerLevel(PLAYER_LEVEL_CURVE), ["badgeSettings", { templateId: "BADGE_7_DAY_STREAKS", badgeType: "BADGE_7_DAY_STREAKS", badgeRank: 5, targets: [1, 10, 50, 100] }]]),
    [vendorBadges[0]],
  );

  assert.equal(medals.length, 1);
  assert.equal(medals[0].slug, "triathlete");
  assert.equal(medals[0].name, "Triathlete");
  assert.notEqual(medals[0].description, "");

  // Cross-check against the currently-committed reference.json: the slug
  // this fix produces must be the exact slug already live in production
  // (and referenced by real medal_progress_personal rows), not a new one.
  const referencePath = resolve(__dirname, "../src/data/reference.json");
  const reference: ReferenceData = JSON.parse(readFileSync(referencePath, "utf-8"));
  const committedTriathlete = reference.medals.find((m) => m.slug === "triathlete");
  assert.ok(committedTriathlete, "src/data/reference.json should already have a 'triathlete' medal slug");
  assert.equal(medals[0].name, committedTriathlete?.name);
});

test("same-slug badges collapse to one medal and one targetless tier row", () => {
  const { medals, medalTiers } = buildPlayerProgression(
    gameMasterFrom([
      playerLevel(PLAYER_LEVEL_CURVE),
      ["badgeSettings", { templateId: "BADGE_EVENT", badgeType: "BADGE_EVENT", badgeRank: 2, eventBadge: true }],
      ["badgeSettings", { templateId: "BADGE_EVENT_2", badgeType: "BADGE_EVENT", badgeRank: 2, eventBadge: true }],
    ]),
    [],
  );

  assert.equal(medals.length, 1);
  assert.equal(medalTiers.length, 1);
  assert.equal(new Set(medalTiers.map((t) => `${t.medalSlug}|${t.rank}`)).size, medalTiers.length);
});

test("same-slug badges that BOTH carry targets still collapse to one medal's tier rows, not duplicate (slug, rank) rows", () => {
  // Real-world shape: GAME_MASTER's four BADGE_AA_2023_JEJU_DAY_0{0..3}
  // event badges all resolve to the same vendored name ("Pokémon Air
  // Adventures") and each individually carries `targets`. Before this
  // fix's isFirstForSlug guard on the `targets` branch, every one of them
  // would have pushed a (medalSlug, rank) row, colliding on the medal_tier
  // primary key.
  const { medals, medalTiers } = buildPlayerProgression(
    gameMasterFrom([
      playerLevel(PLAYER_LEVEL_CURVE),
      ["badgeSettings", { templateId: "BADGE_AA_2023_JEJU_DAY_00", badgeType: "BADGE_AA_2023_JEJU_DAY_00", badgeRank: 2, eventBadge: true, targets: [100] }],
      ["badgeSettings", { templateId: "BADGE_AA_2023_JEJU_DAY_01", badgeType: "BADGE_AA_2023_JEJU_DAY_01", badgeRank: 2, eventBadge: true, targets: [100] }],
    ]),
    [
      { name: "Pokemon Air Adventures", description: "Jeju Island, 2023", rank: 2 },
      { name: "Pokemon Air Adventures", description: "Jeju Island, July 28, 2023", rank: 2 },
    ],
  );

  assert.equal(medals.length, 1);
  assert.equal(medalTiers.length, 1);
  assert.deepEqual(medalTiers, [{ medalSlug: "pokemon-air-adventures", rank: 1, target: 100 }]);
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
    [],
  );

  assert.deepEqual(friendshipLevels, [
    { level: 0, name: "Friend", pointsRequired: 0, xpReward: 1000, attackBonus: 1, tradingDiscount: 0, raidBallBonus: 0 },
    { level: 2, name: "Great Friend", pointsRequired: 7, xpReward: 10000, attackBonus: 1.05, tradingDiscount: 0.2, raidBallBonus: 1 },
  ]);
});
