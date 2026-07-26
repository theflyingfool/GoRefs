// Drizzle schema for GoBuddy's personal tables — the sole input to
// `npm run db:generate` (see drizzle.config.ts). Column names stay
// snake_case to match the existing on-disk schema; Drizzle's inferred
// $inferSelect/$inferInsert types are camelCase automatically.
//
// Columns that reference a row in a *reference* table (species.slug,
// form.slug, mega_variant.slug, backgrounds.slug, medal.slug,
// player_level.level) are plain columns here, not Drizzle `.references()`
// calls — those tables live in schema/reference.ts, deliberately excluded
// from drizzle-kit's schema path (they're wholesale-replaced by
// reference-sync.ts, never migrated). The REFERENCES SQL for these columns
// is restored by hand in the generated migration file — see
// src/db/migrations/0000_baseline.sql's header comment.

import { check, integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// Builds one check() constraint per boolean column, named `<table>_<column>_bool`,
// reproducing today's `CHECK (x IN (0, 1))` — used inline in each table's
// constraints callback below.
function boolChecks(tableName: string, columns: Record<string, AnySQLiteColumn>): Record<string, ReturnType<typeof check>> {
  return Object.fromEntries(
    Object.entries(columns).map(([name, col]) => [`${name}Check`, check(`${tableName}_${name}_bool`, sql`${col} IN (0, 1)`)]),
  );
}

export const appSettings = sqliteTable(
  "app_settings",
  {
    key: text("key").notNull(),
    profileId: text("profile_id").notNull(),
    value: text("value").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.key] }),
  }),
);

export const profile = sqliteTable("profile", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  friendCode: text("friend_code"),
  isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const speciesPersonal = sqliteTable(
  "species_personal",
  {
    speciesSlug: text("species_slug").notNull(),
    profileId: text("profile_id").notNull(),
    registered: integer("registered", { mode: "boolean" }).notNull().default(false),
    xxl: integer("xxl", { mode: "boolean" }).notNull().default(false),
    xxs: integer("xxs", { mode: "boolean" }).notNull().default(false),
    purified: integer("purified", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.speciesSlug] }),
    ...boolChecks("species_personal", { registered: table.registered, xxl: table.xxl, xxs: table.xxs, purified: table.purified }),
  }),
);

export const formPersonal = sqliteTable(
  "form_personal",
  {
    formSlug: text("form_slug").notNull(),
    profileId: text("profile_id").notNull(),

    caught: integer("caught", { mode: "boolean" }).notNull().default(false),
    shiny: integer("shiny", { mode: "boolean" }).notNull().default(false),
    floor: integer("floor", { mode: "boolean" }).notNull().default(false),
    fourStar: integer("four_star", { mode: "boolean" }).notNull().default(false),
    shundo: integer("shundo", { mode: "boolean" }).notNull().default(false),

    lucky: integer("lucky", { mode: "boolean" }).notNull().default(false),
    luckyShiny: integer("lucky_shiny", { mode: "boolean" }).notNull().default(false),
    luckyFloor: integer("lucky_floor", { mode: "boolean" }).notNull().default(false),
    luckyFourStar: integer("lucky_four_star", { mode: "boolean" }).notNull().default(false),
    luckyShundo: integer("lucky_shundo", { mode: "boolean" }).notNull().default(false),

    shadow: integer("shadow", { mode: "boolean" }).notNull().default(false),
    shadowShiny: integer("shadow_shiny", { mode: "boolean" }).notNull().default(false),
    shadowFloor: integer("shadow_floor", { mode: "boolean" }).notNull().default(false),
    shadowFourStar: integer("shadow_four_star", { mode: "boolean" }).notNull().default(false),
    shadowShundo: integer("shadow_shundo", { mode: "boolean" }).notNull().default(false),

    dynamax: integer("dynamax", { mode: "boolean" }).notNull().default(false),
    dynamaxFloor: integer("dynamax_floor", { mode: "boolean" }).notNull().default(false),
    dynamaxShiny: integer("dynamax_shiny", { mode: "boolean" }).notNull().default(false),
    dynamaxFourStar: integer("dynamax_four_star", { mode: "boolean" }).notNull().default(false),
    dynamaxShundo: integer("dynamax_shundo", { mode: "boolean" }).notNull().default(false),

    luckyDynamax: integer("lucky_dynamax", { mode: "boolean" }).notNull().default(false),
    luckyDynamaxFloor: integer("lucky_dynamax_floor", { mode: "boolean" }).notNull().default(false),
    luckyDynamaxShiny: integer("lucky_dynamax_shiny", { mode: "boolean" }).notNull().default(false),
    luckyDynamaxFourStar: integer("lucky_dynamax_four_star", { mode: "boolean" }).notNull().default(false),
    luckyDynamaxShundo: integer("lucky_dynamax_shundo", { mode: "boolean" }).notNull().default(false),

    bestShiny: text("best_shiny"),
    bestNonShiny: text("best_non_shiny"),
    bestLucky: text("best_lucky"),

    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.formSlug] }),
    ...boolChecks("form_personal", {
      caught: table.caught,
      shiny: table.shiny,
      floor: table.floor,
      fourStar: table.fourStar,
      shundo: table.shundo,
      lucky: table.lucky,
      luckyShiny: table.luckyShiny,
      luckyFloor: table.luckyFloor,
      luckyFourStar: table.luckyFourStar,
      luckyShundo: table.luckyShundo,
      shadow: table.shadow,
      shadowShiny: table.shadowShiny,
      shadowFloor: table.shadowFloor,
      shadowFourStar: table.shadowFourStar,
      shadowShundo: table.shadowShundo,
      dynamax: table.dynamax,
      dynamaxFloor: table.dynamaxFloor,
      dynamaxShiny: table.dynamaxShiny,
      dynamaxFourStar: table.dynamaxFourStar,
      dynamaxShundo: table.dynamaxShundo,
      luckyDynamax: table.luckyDynamax,
      luckyDynamaxFloor: table.luckyDynamaxFloor,
      luckyDynamaxShiny: table.luckyDynamaxShiny,
      luckyDynamaxFourStar: table.luckyDynamaxFourStar,
      luckyDynamaxShundo: table.luckyDynamaxShundo,
    }),
  }),
);

export const formBackgroundPersonal = sqliteTable(
  "form_background_personal",
  {
    formSlug: text("form_slug").notNull(),
    profileId: text("profile_id").notNull(),
    achievementField: text("achievement_field").notNull(),
    backgroundSlug: text("background_slug").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.formSlug, table.achievementField, table.backgroundSlug] }),
  }),
);

export const megaPersonal = sqliteTable(
  "mega_personal",
  {
    megaVariantSlug: text("mega_variant_slug").notNull(),
    profileId: text("profile_id").notNull(),
    evolved: integer("evolved", { mode: "boolean" }).notNull().default(false),
    shinyEvolved: integer("shiny_evolved", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.megaVariantSlug] }),
    ...boolChecks("mega_personal", { evolved: table.evolved, shinyEvolved: table.shinyEvolved }),
  }),
);

export const pokemonInstance = sqliteTable(
  "pokemon_instance",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    formSlug: text("form_slug").notNull(),
    profileId: text("profile_id").notNull(),
    status: text("status", { enum: ["kept", "traded", "released", "evolved"] }).notNull().default("kept"),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
    caughtAt: integer("caught_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    cp: integer("cp"),
    ivAttack: integer("iv_attack"),
    ivDefense: integer("iv_defense"),
    ivStamina: integer("iv_stamina"),
    // Generated, not written directly -- SQLite rejects an explicit INSERT
    // into a GENERATED column. Rounds to 1 decimal place; NULL unless all
    // three components are present. See src/db/types.ts's computeIvPercent
    // for the JS-side mirror of this exact formula (used for the in-memory
    // cache and the Log-a-catch live preview, both of which need a value
    // before a DB round-trip is possible).
    ivPercent: real("iv_percent").generatedAlwaysAs(
      sql`CASE WHEN iv_attack IS NOT NULL AND iv_defense IS NOT NULL AND iv_stamina IS NOT NULL THEN ROUND((iv_attack + iv_defense + iv_stamina) * 100.0 / 45, 1) ELSE NULL END`,
      { mode: "virtual" },
    ),
    shiny: integer("shiny", { mode: "boolean" }).notNull().default(false),
    lucky: integer("lucky", { mode: "boolean" }).notNull().default(false),
    shadow: integer("shadow", { mode: "boolean" }).notNull().default(false),
    purified: integer("purified", { mode: "boolean" }).notNull().default(false),
    dynamax: integer("dynamax", { mode: "boolean" }).notNull().default(false),
    receivedViaTrade: integer("received_via_trade", { mode: "boolean" }).notNull().default(false),
    heartsEarned: integer("hearts_earned"),
    currentMegaLevel: integer("current_mega_level"),
    nickname: text("nickname"),
    backgroundSlug: text("background_slug"),
  },
  (table) => ({
    ...boolChecks("pokemon_instance", {
      shiny: table.shiny,
      lucky: table.lucky,
      shadow: table.shadow,
      purified: table.purified,
      dynamax: table.dynamax,
      receivedViaTrade: table.receivedViaTrade,
    }),
    statusCheck: check("pokemon_instance_status_enum", sql`${table.status} IN ('kept', 'traded', 'released', 'evolved')`),
    ivAttackCheck: check("pokemon_instance_iv_attack_range", sql`${table.ivAttack} IS NULL OR (${table.ivAttack} >= 0 AND ${table.ivAttack} <= 15)`),
    ivDefenseCheck: check("pokemon_instance_iv_defense_range", sql`${table.ivDefense} IS NULL OR (${table.ivDefense} >= 0 AND ${table.ivDefense} <= 15)`),
    ivStaminaCheck: check("pokemon_instance_iv_stamina_range", sql`${table.ivStamina} IS NULL OR (${table.ivStamina} >= 0 AND ${table.ivStamina} <= 15)`),
  }),
);

export const tag = sqliteTable(
  "tag",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    profileId: text("profile_id").notNull(),
    name: text("name").notNull(),
  },
  (table) => ({
    profileNameUnique: unique("tag_profile_id_name_unique").on(table.profileId, table.name),
  }),
);

export const pokemonInstanceTag = sqliteTable(
  "pokemon_instance_tag",
  {
    pokemonInstanceId: integer("pokemon_instance_id").notNull(),
    tagId: integer("tag_id").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pokemonInstanceId, table.tagId] }),
  }),
);

export const pokemonInstanceMaxMove = sqliteTable(
  "pokemon_instance_max_move",
  {
    pokemonInstanceId: integer("pokemon_instance_id").notNull(),
    moveSlot: text("move_slot").notNull(),
    level: integer("level"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pokemonInstanceId, table.moveSlot] }),
  }),
);

export const playerProgressPersonal = sqliteTable("player_progress_personal", {
  profileId: text("profile_id").primaryKey(),
  currentLevel: integer("current_level"),
  totalXp: integer("total_xp"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const medalProgressPersonal = sqliteTable(
  "medal_progress_personal",
  {
    medalSlug: text("medal_slug").notNull(),
    profileId: text("profile_id").notNull(),
    currentRank: integer("current_rank").notNull().default(0),
    currentCount: integer("current_count").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.medalSlug, table.profileId] }),
  }),
);

export const playerProgressLog = sqliteTable("player_progress_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: text("profile_id").notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
  currentLevel: integer("current_level"),
  totalXp: integer("total_xp"),
});

export const personalDataQuarantine = sqliteTable("personal_data_quarantine", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sourceTable: text("source_table").notNull(),
  slug: text("slug").notNull(),
  payloadJson: text("payload_json", { mode: "json" }).notNull(),
  quarantinedAt: integer("quarantined_at", { mode: "timestamp_ms" }).notNull(),
});
