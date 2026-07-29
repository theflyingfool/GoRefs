// Trainer-level curve, level-up rewards, medals and friendship levels —
// re-sourced from GAME_MASTER (playerLevel, levelUpRewards, badgeSettings,
// friendshipMilestoneSettings) in place of pogoapi.net's
// player_xp_requirements/levelup_rewards/badges/friendship_level_settings
// endpoints.

import { slugify } from "../slug";
import type { GameMasterIndex } from "../sources/game-master";
import { alignVendorBadges, type VendorBadgeDisplay } from "../sources/pogoapi-badges";
import type { FriendshipLevel, Medal, MedalTier, PlayerLevel, PlayerLevelReward } from "../../../src/db/types";
import { titleCaseEnumToken } from "./moves";

// The real in-game level cap (owner-confirmed 2026-07-23). This is no longer
// an unbacked figure: GAME_MASTER's `playerLevel` template publishes the full
// level-1-80 XP/CP curve (requiredExperience[]/cpMultiplier[], 80 entries
// each, milestoneLevels ending at 80), which corroborates it directly —
// replacing the previous situation where no integrated source published XP
// requirements past level 50 and levels above that had to be seeded with a
// null cumulative_xp just so player_progress_personal.current_level (a real
// FK into player_level(level)) could record a real trainer's level at all.
const MAX_TRAINER_LEVEL = 80;

/** "ITEM_POKE_BALL" -> "Poke Ball". GAME_MASTER names items by enum id only; the accented "Poké Ball" the previous source published is not recoverable from it. */
function itemDisplayName(itemId: string): string {
  return titleCaseEnumToken(itemId.replace(/^ITEM_/, ""));
}

// GAME_MASTER's badgeSettings carries no display strings at all — only the
// `BADGE_*` enum id, its rank and its tier targets. The vendored
// pogoapi.net snapshot (see sources/pogoapi-badges.ts, including why a
// two-pointer subsequence realignment is needed rather than plain
// positional indexing) supplies the real name/description for the ~597
// badges it captured, preserving the original medal slugs (and keeping
// medal_progress_personal.medal_slug, a live FK, intact). Badges
// GAME_MASTER has added since that snapshot was taken have no recoverable
// name and fall back to a token-derived one, same as before this fix.
// `alignVendorBadges` already enforces rank agreement as its match
// condition, so a `vendored` value reaching here is trusted by
// construction — there is no second, weaker join to re-verify.
function medalDisplayName(badgeType: string, vendored: VendorBadgeDisplay | undefined): Pick<Medal, "name" | "description"> {
  if (vendored) return { name: vendored.name, description: vendored.description };
  return { name: titleCaseEnumToken(badgeType.replace(/^BADGE_/, "")), description: "" };
}

// friendshipMilestoneSettings has no display name and no numeric level field
// — the level lives only in the templateId. These names are the ones already
// in production's reference.json (i.e. preserved existing data, not invented
// Pokémon GO mechanics). GAME_MASTER publishes a sixth record
// (FRIENDSHIP_LEVEL_5) that production has never had and that no source
// names; it is deliberately not emitted here.
const FRIENDSHIP_LEVEL_NAMES: Record<number, string> = {
  0: "Friend",
  1: "Good Friend",
  2: "Great Friend",
  3: "Ultra Friend",
  4: "Best Friend",
};

const FRIENDSHIP_TEMPLATE_ID = /^FRIENDSHIP_LEVEL_(\d+)$/;

export interface PlayerProgressionBuildResult {
  playerLevels: PlayerLevel[];
  playerLevelRewards: PlayerLevelReward[];
  medals: Medal[];
  medalTiers: MedalTier[];
  friendshipLevels: FriendshipLevel[];
}

/**
 * `vendorBadges` is the vendored snapshot in its own natural order (e.g.
 * straight from `loadVendorBadgeDisplayNames()`) — this function aligns it
 * against `gameMaster`'s badgeSettings itself (`alignVendorBadges`) rather
 * than expecting the caller to have already indexed it positionally, since
 * plain positional indexing does not hold (see sources/pogoapi-badges.ts).
 */
export function buildPlayerProgression(gameMaster: GameMasterIndex, vendorBadges: VendorBadgeDisplay[]): PlayerProgressionBuildResult {
  // requiredExperience is a parallel array with index 0 = level 1.
  const levelSettings = gameMaster.getPlayerLevelSettings();
  const playerLevels: PlayerLevel[] = (levelSettings?.requiredExperience ?? []).map((xp, i) => ({ level: i + 1, cumulativeXp: xp }));

  const knownXpLevels = new Set(playerLevels.map((l) => l.level));
  for (let level = 1; level <= MAX_TRAINER_LEVEL; level++) {
    if (!knownXpLevels.has(level)) playerLevels.push({ level, cumulativeXp: null });
  }
  playerLevels.sort((a, b) => a.level - b.level);

  const knownLevels = new Set(playerLevels.map((l) => l.level));

  const playerLevelRewards: PlayerLevelReward[] = [];
  // sortOrder is a running counter per level rather than a per-record index:
  // the (level, sort_order) primary key has to stay unique even when a level
  // draws items from more than one source record (GAME_MASTER's
  // AWARDS_LEVEL_N / BACKFILL_AWARDS_LEVEL_N pairs collapse to one record in
  // sources/game-master.ts's first-seen index, but the counter is what keeps
  // that an implementation detail rather than a latent PK collision).
  const nextSortOrderByLevel = new Map<number, number>();
  for (let level = 1; level <= MAX_TRAINER_LEVEL; level++) {
    // player_level_reward.level is a real FK to player_level(level) — every
    // level up to MAX_TRAINER_LEVEL has a row (see above), so this only
    // guards against a future source listing a reward past the level cap.
    if (!knownLevels.has(level)) continue;
    const record = gameMaster.getLevelUpRewards(level);
    if (!record) continue;
    const items = record.items ?? [];
    const counts = record.itemsCount ?? [];
    const nextSortOrder = nextSortOrderByLevel.get(level) ?? 0;
    items.forEach((item, i) => {
      playerLevelRewards.push({ level, sortOrder: nextSortOrder + i, itemName: itemDisplayName(item), amount: counts[i] ?? 0 });
    });
    nextSortOrderByLevel.set(level, nextSortOrder + items.length);
  }

  const medals: Medal[] = [];
  const medalTiers: MedalTier[] = [];
  const seenMedalSlugs = new Set<string>();
  const badgeSettings = gameMaster.allBadgeSettings();
  const alignedVendorBadges = alignVendorBadges(badgeSettings, vendorBadges);
  badgeSettings.forEach((badge, index) => {
    const targets = badge.targets as number[] | undefined;
    const rank = badge.badgeRank as number | undefined;
    const { name, description } = medalDisplayName(badge.badgeType, alignedVendorBadges[index]);
    const slug = slugify(name);
    const isFirstForSlug = !seenMedalSlugs.has(slug);
    if (isFirstForSlug) {
      seenMedalSlugs.add(slug);
      medals.push({ slug, name, description, isEventMedal: Boolean(badge.eventBadge) });
    }
    // Event badges reuse a generic display name across many records (every
    // "Pokémon GO Fest" city/year is its own badge, and — now that names come
    // from the vendored snapshot instead of the badge id — so are the four
    // BADGE_AA_2023_JEJU_DAY_0{0..3} records, which all resolve to
    // "Pokémon Air Adventures"). The `medals` table above already collapses
    // those to one canonical medal per slug; pushing a tier row for every
    // same-named record — whether it carries `targets` or just a `rank` —
    // produced duplicate (medal_slug, rank) primary keys. Both branches are
    // gated on `isFirstForSlug` for that reason, at the cost of not being
    // able to tell individual event medals apart — a real, pre-existing
    // data-model gap worth a product call on later if per-event medal
    // tracking ever matters.
    if (targets && isFirstForSlug) {
      targets.forEach((target, i) => medalTiers.push({ medalSlug: slug, rank: i + 1, target }));
    } else if (rank !== undefined && isFirstForSlug) {
      medalTiers.push({ medalSlug: slug, rank, target: null });
    }
  });

  const friendshipLevels: FriendshipLevel[] = [];
  for (const record of gameMaster.allFriendshipMilestoneSettings()) {
    const match = FRIENDSHIP_TEMPLATE_ID.exec(record.templateId);
    if (!match) continue;
    const level = Number(match[1]);
    const name = FRIENDSHIP_LEVEL_NAMES[level];
    if (name === undefined) continue;
    friendshipLevels.push({
      level,
      name,
      pointsRequired: (record.minPointsToReach as number | undefined) ?? 0,
      xpReward: record.milestoneXpReward ?? 0,
      attackBonus: (record.attackBonusPercentage as number | undefined) ?? 1,
      tradingDiscount: (record.tradingDiscount as number | undefined) ?? 0,
      raidBallBonus: (record.raidBallBonus as number | undefined) ?? 0,
    });
  }
  friendshipLevels.sort((a, b) => a.level - b.level);

  return { playerLevels, playerLevelRewards, medals, medalTiers, friendshipLevels };
}
