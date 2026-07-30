// Drizzle schema for GoBuddy's reference tables — for typed queries only
// (see Plan 2). Deliberately NOT part of drizzle.config.ts's schema path:
// these tables are wholesale dropped/recreated by src/db/reference-sync.ts
// on every reference-data update, never incrementally migrated, so
// drizzle-kit must never diff or generate migrations for them.

import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const regions = sqliteTable("regions", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
});

export const types = sqliteTable("types", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
});

export const backgrounds = sqliteTable("backgrounds", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
});

export const species = sqliteTable("species", {
  slug: text("slug").primaryKey(),
  dexNumber: integer("dex_number").notNull(),
  name: text("name").notNull(),
  familySlug: text("family_slug").notNull(),
  gen: integer("gen").notNull(),
  rarity: text("rarity", { enum: ["standard", "legendary", "mythical", "ultra_beast"] }).notNull(),
  regionSlug: text("region_slug").notNull(),
  hasMale: integer("has_male", { mode: "boolean" }).notNull(),
  hasFemale: integer("has_female", { mode: "boolean" }).notNull(),
  canMegaEvolve: integer("can_mega_evolve", { mode: "boolean" }).notNull(),
  canGigantamax: integer("can_gigantamax", { mode: "boolean" }).notNull(),
});

export const form = sqliteTable("form", {
  slug: text("slug").primaryKey(),
  speciesSlug: text("species_slug").notNull(),
  formName: text("form_name").notNull(),
  costumeName: text("costume_name"),
  gender: text("gender", { enum: ["male", "female", "unknown"] }).notNull(),
  evolves: integer("evolves", { mode: "boolean" }).notNull(),
  shinyAvailable: integer("shiny_available", { mode: "boolean" }).notNull(),
  shinyReleasedAt: text("shiny_released_at"),
  shadowAvailable: integer("shadow_available", { mode: "boolean" }).notNull(),
  dynamaxAvailable: integer("dynamax_available", { mode: "boolean" }).notNull(),
  regionalExclusive: integer("regional_exclusive", { mode: "boolean" }).notNull(),
  imageRef: text("image_ref"),
});

export const formTypes = sqliteTable(
  "form_types",
  {
    formSlug: text("form_slug").notNull(),
    typeSlug: text("type_slug").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.formSlug, table.typeSlug] }) }),
);

export const megaVariant = sqliteTable("mega_variant", {
  slug: text("slug").primaryKey(),
  speciesSlug: text("species_slug").notNull(),
  variant: text("variant", { enum: ["X", "Y", "Primal"] }),
});

export const move = sqliteTable("move", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  category: text("category", { enum: ["fast", "charged"] }).notNull(),
  typeSlug: text("type_slug").notNull(),
  power: integer("power"),
  energyDelta: integer("energy_delta"),
  durationMs: integer("duration_ms"),
  pvpPower: integer("pvp_power"),
  pvpEnergyDelta: integer("pvp_energy_delta"),
  pvpTurns: integer("pvp_turns"),
});

export const formMove = sqliteTable(
  "form_move",
  {
    formSlug: text("form_slug").notNull(),
    moveSlug: text("move_slug").notNull(),
    isElite: integer("is_elite", { mode: "boolean" }).notNull().default(false),
  },
  (table) => ({ pk: primaryKey({ columns: [table.formSlug, table.moveSlug] }) }),
);

export const speciesEvolution = sqliteTable(
  "species_evolution",
  {
    fromSpeciesSlug: text("from_species_slug").notNull(),
    toSpeciesSlug: text("to_species_slug").notNull(),
    candyRequired: integer("candy_required"),
    itemRequired: text("item_required"),
  },
  (table) => ({ pk: primaryKey({ columns: [table.fromSpeciesSlug, table.toSpeciesSlug] }) }),
);

export const typeEffectiveness = sqliteTable(
  "type_effectiveness",
  {
    attackingTypeSlug: text("attacking_type_slug").notNull(),
    defendingTypeSlug: text("defending_type_slug").notNull(),
    multiplier: real("multiplier").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.attackingTypeSlug, table.defendingTypeSlug] }) }),
);

export const weatherBoost = sqliteTable(
  "weather_boost",
  {
    weather: text("weather").notNull(),
    typeSlug: text("type_slug").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.weather, table.typeSlug] }) }),
);

// cumulativeXp is nullable: see src/db/schema.ts's player_level DDL comment
// -- levels 51-80 are real but have no published XP-requirement figure
// from any currently-integrated ingestion source.
export const playerLevel = sqliteTable("player_level", {
  level: integer("level").primaryKey(),
  cumulativeXp: integer("cumulative_xp"),
});

export const playerLevelReward = sqliteTable(
  "player_level_reward",
  {
    level: integer("level").notNull(),
    sortOrder: integer("sort_order").notNull(),
    itemName: text("item_name").notNull(),
    amount: integer("amount").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.level, table.sortOrder] }) }),
);

export const medal = sqliteTable("medal", {
  slug: text("slug").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  isEventMedal: integer("is_event_medal", { mode: "boolean" }).notNull(),
});

export const medalTier = sqliteTable(
  "medal_tier",
  {
    medalSlug: text("medal_slug").notNull(),
    rank: integer("rank").notNull(),
    target: integer("target"),
  },
  (table) => ({ pk: primaryKey({ columns: [table.medalSlug, table.rank] }) }),
);

export const friendshipLevel = sqliteTable("friendship_level", {
  level: integer("level").primaryKey(),
  name: text("name").notNull(),
  pointsRequired: integer("points_required").notNull(),
  xpReward: integer("xp_reward").notNull(),
  attackBonus: real("attack_bonus").notNull(),
  tradingDiscount: real("trading_discount").notNull(),
  raidBallBonus: real("raid_ball_bonus").notNull(),
});

export const pvpRankReward = sqliteTable(
  "pvp_rank_reward",
  {
    leagueRank: integer("league_rank").notNull(),
    track: text("track", { enum: ["free", "premium"] }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    rewardType: text("reward_type").notNull(),
    itemName: text("item_name"),
    amount: integer("amount"),
  },
  (table) => ({ pk: primaryKey({ columns: [table.leagueRank, table.track, table.sortOrder] }) }),
);

export const pvpRankRequirement = sqliteTable("pvp_rank_requirement", {
  rank: integer("rank").primaryKey(),
  additionalBattlesRequired: integer("additional_battles_required"),
  additionalBattleWinsRequired: integer("additional_battle_wins_required"),
});

export const raidBoss = sqliteTable(
  "raid_boss",
  {
    tier: text("tier").notNull(),
    formSlug: text("form_slug").notNull(),
    minCp: integer("min_cp").notNull(),
    maxCp: integer("max_cp").notNull(),
    minBoostedCp: integer("min_boosted_cp").notNull(),
    maxBoostedCp: integer("max_boosted_cp").notNull(),
    possibleShiny: integer("possible_shiny", { mode: "boolean" }).notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.tier, table.formSlug] }) }),
);

export const raidBossWeatherBoost = sqliteTable(
  "raid_boss_weather_boost",
  {
    tier: text("tier").notNull(),
    formSlug: text("form_slug").notNull(),
    weather: text("weather").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.tier, table.formSlug, table.weather] }) }),
);

export const communityDay = sqliteTable("community_day", {
  number: integer("number").primaryKey(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
});

export const communityDayBonus = sqliteTable(
  "community_day_bonus",
  {
    communityDayNumber: integer("community_day_number").notNull(),
    bonus: text("bonus").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.communityDayNumber, table.bonus] }) }),
);

export const communityDaySpecies = sqliteTable(
  "community_day_species",
  {
    communityDayNumber: integer("community_day_number").notNull(),
    speciesSlug: text("species_slug").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.communityDayNumber, table.speciesSlug] }) }),
);

export const communityDayEventMove = sqliteTable(
  "community_day_event_move",
  {
    communityDayNumber: integer("community_day_number").notNull(),
    speciesSlug: text("species_slug").notNull(),
    moveSlug: text("move_slug").notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.communityDayNumber, table.speciesSlug, table.moveSlug] }) }),
);
