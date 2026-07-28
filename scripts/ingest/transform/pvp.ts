// GO Battle League rank rewards and rank requirements, re-sourced from
// GAME_MASTER's `vsSeekerLoot` and `combatRankingProtoSettings` categories
// in place of pogoapi.net's gobattle_league_rewards/gobattle_ranking_settings
// endpoints. Neither category has a typed getter in sources/game-master.ts
// (they're outside the 12 categories that task covered), so both go through
// its untyped `categoryEntries` escape hatch and are narrowed here.

import type { GameMasterIndex } from "../sources/game-master";
import type { PvpRankRequirement, PvpRankReward, PvpTrack } from "../../../src/db/types";

interface VsSeekerLootRecord {
  templateId: string;
  rankLevel?: number;
  rewardTrack?: string;
  reward?: VsSeekerReward[];
}

interface VsSeekerReward {
  item?: { item?: string; stardust?: boolean; count?: number };
  pokemonReward?: boolean;
  itemRankingLootTableCount?: number;
}

interface CombatRankingRecord {
  templateId: string;
  rankLevel?: { rankLevel?: number; additionalTotalBattlesRequired?: number; additionalWinsRequired?: number; minRatingRequired?: number }[];
}

/** "ITEM_RARE_CANDY" -> "Rare Candy" — same derivation as player-progression's item names, kept local to avoid a transform-to-transform dependency for four lines. */
function itemDisplayName(itemId: string): string {
  return itemId
    .replace(/^ITEM_/, "")
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

// Maps one GAME_MASTER reward slot onto the (reward_type, item_name, amount)
// triple the pvp_rank_reward table stores. `reward_type` is a free-text
// column; the first three values match the vocabulary the previous source
// used ("stardust", "item", "pokemon_from_pool"). `itemRankingLootTableCount`
// has no previous-source equivalent — it's a roll on an item loot table
// rather than a fixed item — so it gets its own value rather than being
// flattened into "item" with a missing name.
function rewardFields(reward: VsSeekerReward): { rewardType: string; itemName: string | null; amount: number | null } | null {
  if (reward.item?.stardust) return { rewardType: "stardust", itemName: null, amount: reward.item.count ?? null };
  if (reward.item?.item) return { rewardType: "item", itemName: itemDisplayName(reward.item.item), amount: reward.item.count ?? null };
  if (reward.pokemonReward) return { rewardType: "pokemon_from_pool", itemName: null, amount: null };
  if (reward.itemRankingLootTableCount !== undefined) return { rewardType: "item_loot_table", itemName: null, amount: reward.itemRankingLootTableCount };
  return null;
}

export interface PvpBuildResult {
  pvpRankRewards: PvpRankReward[];
  pvpRankRequirements: PvpRankRequirement[];
}

export function buildPvp(gameMaster: GameMasterIndex): PvpBuildResult {
  const pvpRankRewards: PvpRankReward[] = [];
  for (const raw of gameMaster.categoryEntries("vsSeekerLoot") as VsSeekerLootRecord[]) {
    if (raw.rankLevel === undefined) continue;
    const track: PvpTrack = raw.rewardTrack === "PREMIUM" || raw.templateId.endsWith("_PREMIUM") ? "premium" : "free";
    // sortOrder is the slot's index in the reward track, so it stays stable
    // even when a slot maps to no representable reward (none do today) —
    // matching the previous source's handling of its own genuinely-null
    // slots, which were skipped without shifting the remaining indices.
    (raw.reward ?? []).forEach((reward, i) => {
      const fields = rewardFields(reward);
      if (!fields) return;
      pvpRankRewards.push({ leagueRank: raw.rankLevel!, track, sortOrder: i, ...fields });
    });
  }

  // combatRankingProtoSettings ships one record per GO Battle League season
  // (COMBAT_RANKING_SETTINGS plus COMBAT_RANKING_SETTINGS_S8..S30) — only
  // the newest describes the live ladder. The base, season-less record is
  // the legacy 10-rank ladder the previous source published; the current
  // seasons run to rank 24, which is also how far vsSeekerLoot's rewards go,
  // so taking the highest season number keeps the two tables describing the
  // same ladder. Compared numerically: a lexical sort would put S9 after S30.
  const seasons = gameMaster.categoryEntries("combatRankingProtoSettings") as CombatRankingRecord[];
  let latest: CombatRankingRecord | undefined;
  let latestSeason = -1;
  for (const record of seasons) {
    const match = /_S(\d+)$/.exec(record.templateId);
    const season = match ? Number(match[1]) : 0;
    if (season >= latestSeason) {
      latestSeason = season;
      latest = record;
    }
  }

  // minRatingRequired (ranks 21-24 of the modern ladder) has no column in
  // pvp_rank_requirement — those ranks land with both requirement columns
  // null rather than being dropped, so the rank list stays complete.
  const pvpRankRequirements: PvpRankRequirement[] = (latest?.rankLevel ?? [])
    .filter((r) => r.rankLevel !== undefined)
    .map((r) => ({
      rank: r.rankLevel!,
      additionalBattlesRequired: r.additionalTotalBattlesRequired ?? null,
      additionalBattleWinsRequired: r.additionalWinsRequired ?? null,
    }));

  return { pvpRankRewards, pvpRankRequirements };
}
