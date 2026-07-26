-- Hand-edited after `npm run db:generate`, per 0000_baseline.sql's header
-- comment and the precedent in 0001_timestamps_to_epoch_ms.sql (an 11-table
-- rebuild with the same class of fixes). This migration widens the primary
-- key on five personal tables to include profile_id, retypes every
-- profile_id (and profile.id) from INTEGER to TEXT, and adds
-- app_settings.profile_id + profile.is_current. It also adds a new global
-- (non-profile-scoped) app_meta table and moves reference_data_version out of
-- the now-per-profile app_settings into it (a global value can no longer live
-- in app_settings, whose profile_id is NOT NULL with a REFERENCES profile(id)
-- FK) -- the WHERE key='reference_data_version' backfill runs before
-- app_settings is dropped so an upgrading device keeps its resync-skip marker.
-- Four hand-fixes were needed:
--
-- (1) Restored EVERY REFERENCES clause drizzle-kit's rebuild drops. These
-- columns are deliberately plain (no Drizzle `.references()`) in
-- schema/personal.ts because their targets live in schema/reference.ts,
-- excluded from drizzle-kit's schema path (see that file's header comment).
-- The set matches the current on-disk schema (0001's rebuild + 0002/0003 for
-- pokemon_instance): the reference-slug FKs (form/species/mega_variant/medal
-- slugs, player_progress_personal.current_level -> player_level.level,
-- pokemon_instance/form_background_personal.background_slug) AND every
-- profile_id -> profile(id). app_settings.profile_id's REFERENCES is new
-- (the column itself is new this migration).
--
-- (2) pokemon_instance's generated iv_percent column dropped from the
-- INSERT/SELECT column lists (SQLite rejects INSERTing a GENERATED column;
-- it's computed on read) -- same fix as 0002/0003.
--
-- (3) profile.is_current is a brand-new column, so it cannot be SELECTed
-- from the old profile table -- dropped from the INSERT/SELECT lists; every
-- pre-existing profile row lands is_current=0 (its column default). Setting
-- exactly one profile is_current=1 is Task 2's job (the UUID/seeding step).
--
-- (4) app_settings.profile_id is also brand-new (old app_settings was
-- (key, value) only), so the raw `SELECT ... profile_id ... FROM app_settings`
-- drizzle-kit emitted raises "no such column: profile_id". Replaced with
-- `(SELECT id FROM profile LIMIT 1)` so every pre-existing global setting is
-- carried over onto the single existing profile (app_settings is rebuilt
-- before profile, so the old profile row is still present at that point).
--
-- Also fixed the multi-table PRAGMA-bracketing bug drizzle-kit hits on a
-- >1-table rebuild (see 0000_baseline.sql): it emitted `foreign_keys=ON`
-- after only the FIRST table. Moved it to bracket the whole file
-- (OFF at the top, ON at the very end). (Inert under this project's runner,
-- which toggles FK enforcement outside the migration transaction -- see
-- migrations.ts -- but kept correct to match every prior migration.)
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `__new_form_background_personal` (
	`form_slug` text NOT NULL REFERENCES form(slug),
	`profile_id` text NOT NULL REFERENCES profile(id),
	`achievement_field` text NOT NULL,
	`background_slug` text NOT NULL REFERENCES backgrounds(slug),
	`updated_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`profile_id`, `form_slug`, `achievement_field`, `background_slug`)
);
--> statement-breakpoint
INSERT INTO `__new_form_background_personal`("form_slug", "profile_id", "achievement_field", "background_slug", "updated_at") SELECT "form_slug", "profile_id", "achievement_field", "background_slug", "updated_at" FROM `form_background_personal`;--> statement-breakpoint
DROP TABLE `form_background_personal`;--> statement-breakpoint
ALTER TABLE `__new_form_background_personal` RENAME TO `form_background_personal`;--> statement-breakpoint
CREATE TABLE `__new_app_settings` (
	`key` text NOT NULL,
	`profile_id` text NOT NULL REFERENCES profile(id),
	`value` text NOT NULL,
	PRIMARY KEY(`profile_id`, `key`)
);
--> statement-breakpoint
INSERT INTO `__new_app_settings`("key", "profile_id", "value") SELECT "key", (SELECT id FROM profile LIMIT 1), "value" FROM `app_settings`;--> statement-breakpoint
INSERT INTO `app_meta` ("key", "value") SELECT "key", "value" FROM `app_settings` WHERE "key" = 'reference_data_version';--> statement-breakpoint
DROP TABLE `app_settings`;--> statement-breakpoint
ALTER TABLE `__new_app_settings` RENAME TO `app_settings`;--> statement-breakpoint
CREATE TABLE `__new_form_personal` (
	`form_slug` text NOT NULL REFERENCES form(slug),
	`profile_id` text NOT NULL REFERENCES profile(id),
	`caught` integer DEFAULT false NOT NULL,
	`shiny` integer DEFAULT false NOT NULL,
	`floor` integer DEFAULT false NOT NULL,
	`four_star` integer DEFAULT false NOT NULL,
	`shundo` integer DEFAULT false NOT NULL,
	`lucky` integer DEFAULT false NOT NULL,
	`lucky_shiny` integer DEFAULT false NOT NULL,
	`lucky_floor` integer DEFAULT false NOT NULL,
	`lucky_four_star` integer DEFAULT false NOT NULL,
	`lucky_shundo` integer DEFAULT false NOT NULL,
	`shadow` integer DEFAULT false NOT NULL,
	`shadow_shiny` integer DEFAULT false NOT NULL,
	`shadow_floor` integer DEFAULT false NOT NULL,
	`shadow_four_star` integer DEFAULT false NOT NULL,
	`shadow_shundo` integer DEFAULT false NOT NULL,
	`dynamax` integer DEFAULT false NOT NULL,
	`dynamax_floor` integer DEFAULT false NOT NULL,
	`dynamax_shiny` integer DEFAULT false NOT NULL,
	`dynamax_four_star` integer DEFAULT false NOT NULL,
	`dynamax_shundo` integer DEFAULT false NOT NULL,
	`lucky_dynamax` integer DEFAULT false NOT NULL,
	`lucky_dynamax_floor` integer DEFAULT false NOT NULL,
	`lucky_dynamax_shiny` integer DEFAULT false NOT NULL,
	`lucky_dynamax_four_star` integer DEFAULT false NOT NULL,
	`lucky_dynamax_shundo` integer DEFAULT false NOT NULL,
	`best_shiny` text,
	`best_non_shiny` text,
	`best_lucky` text,
	`updated_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`profile_id`, `form_slug`),
	CONSTRAINT "form_personal_caught_bool" CHECK("__new_form_personal"."caught" IN (0, 1)),
	CONSTRAINT "form_personal_shiny_bool" CHECK("__new_form_personal"."shiny" IN (0, 1)),
	CONSTRAINT "form_personal_floor_bool" CHECK("__new_form_personal"."floor" IN (0, 1)),
	CONSTRAINT "form_personal_fourStar_bool" CHECK("__new_form_personal"."four_star" IN (0, 1)),
	CONSTRAINT "form_personal_shundo_bool" CHECK("__new_form_personal"."shundo" IN (0, 1)),
	CONSTRAINT "form_personal_lucky_bool" CHECK("__new_form_personal"."lucky" IN (0, 1)),
	CONSTRAINT "form_personal_luckyShiny_bool" CHECK("__new_form_personal"."lucky_shiny" IN (0, 1)),
	CONSTRAINT "form_personal_luckyFloor_bool" CHECK("__new_form_personal"."lucky_floor" IN (0, 1)),
	CONSTRAINT "form_personal_luckyFourStar_bool" CHECK("__new_form_personal"."lucky_four_star" IN (0, 1)),
	CONSTRAINT "form_personal_luckyShundo_bool" CHECK("__new_form_personal"."lucky_shundo" IN (0, 1)),
	CONSTRAINT "form_personal_shadow_bool" CHECK("__new_form_personal"."shadow" IN (0, 1)),
	CONSTRAINT "form_personal_shadowShiny_bool" CHECK("__new_form_personal"."shadow_shiny" IN (0, 1)),
	CONSTRAINT "form_personal_shadowFloor_bool" CHECK("__new_form_personal"."shadow_floor" IN (0, 1)),
	CONSTRAINT "form_personal_shadowFourStar_bool" CHECK("__new_form_personal"."shadow_four_star" IN (0, 1)),
	CONSTRAINT "form_personal_shadowShundo_bool" CHECK("__new_form_personal"."shadow_shundo" IN (0, 1)),
	CONSTRAINT "form_personal_dynamax_bool" CHECK("__new_form_personal"."dynamax" IN (0, 1)),
	CONSTRAINT "form_personal_dynamaxFloor_bool" CHECK("__new_form_personal"."dynamax_floor" IN (0, 1)),
	CONSTRAINT "form_personal_dynamaxShiny_bool" CHECK("__new_form_personal"."dynamax_shiny" IN (0, 1)),
	CONSTRAINT "form_personal_dynamaxFourStar_bool" CHECK("__new_form_personal"."dynamax_four_star" IN (0, 1)),
	CONSTRAINT "form_personal_dynamaxShundo_bool" CHECK("__new_form_personal"."dynamax_shundo" IN (0, 1)),
	CONSTRAINT "form_personal_luckyDynamax_bool" CHECK("__new_form_personal"."lucky_dynamax" IN (0, 1)),
	CONSTRAINT "form_personal_luckyDynamaxFloor_bool" CHECK("__new_form_personal"."lucky_dynamax_floor" IN (0, 1)),
	CONSTRAINT "form_personal_luckyDynamaxShiny_bool" CHECK("__new_form_personal"."lucky_dynamax_shiny" IN (0, 1)),
	CONSTRAINT "form_personal_luckyDynamaxFourStar_bool" CHECK("__new_form_personal"."lucky_dynamax_four_star" IN (0, 1)),
	CONSTRAINT "form_personal_luckyDynamaxShundo_bool" CHECK("__new_form_personal"."lucky_dynamax_shundo" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_form_personal`("form_slug", "profile_id", "caught", "shiny", "floor", "four_star", "shundo", "lucky", "lucky_shiny", "lucky_floor", "lucky_four_star", "lucky_shundo", "shadow", "shadow_shiny", "shadow_floor", "shadow_four_star", "shadow_shundo", "dynamax", "dynamax_floor", "dynamax_shiny", "dynamax_four_star", "dynamax_shundo", "lucky_dynamax", "lucky_dynamax_floor", "lucky_dynamax_shiny", "lucky_dynamax_four_star", "lucky_dynamax_shundo", "best_shiny", "best_non_shiny", "best_lucky", "updated_at") SELECT "form_slug", "profile_id", "caught", "shiny", "floor", "four_star", "shundo", "lucky", "lucky_shiny", "lucky_floor", "lucky_four_star", "lucky_shundo", "shadow", "shadow_shiny", "shadow_floor", "shadow_four_star", "shadow_shundo", "dynamax", "dynamax_floor", "dynamax_shiny", "dynamax_four_star", "dynamax_shundo", "lucky_dynamax", "lucky_dynamax_floor", "lucky_dynamax_shiny", "lucky_dynamax_four_star", "lucky_dynamax_shundo", "best_shiny", "best_non_shiny", "best_lucky", "updated_at" FROM `form_personal`;--> statement-breakpoint
DROP TABLE `form_personal`;--> statement-breakpoint
ALTER TABLE `__new_form_personal` RENAME TO `form_personal`;--> statement-breakpoint
CREATE TABLE `__new_medal_progress_personal` (
	`medal_slug` text NOT NULL REFERENCES medal(slug),
	`profile_id` text NOT NULL REFERENCES profile(id),
	`current_rank` integer DEFAULT 0 NOT NULL,
	`current_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`medal_slug`, `profile_id`)
);
--> statement-breakpoint
INSERT INTO `__new_medal_progress_personal`("medal_slug", "profile_id", "current_rank", "current_count", "updated_at") SELECT "medal_slug", "profile_id", "current_rank", "current_count", "updated_at" FROM `medal_progress_personal`;--> statement-breakpoint
DROP TABLE `medal_progress_personal`;--> statement-breakpoint
ALTER TABLE `__new_medal_progress_personal` RENAME TO `medal_progress_personal`;--> statement-breakpoint
CREATE TABLE `__new_mega_personal` (
	`mega_variant_slug` text NOT NULL REFERENCES mega_variant(slug),
	`profile_id` text NOT NULL REFERENCES profile(id),
	`evolved` integer DEFAULT false NOT NULL,
	`shiny_evolved` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`profile_id`, `mega_variant_slug`),
	CONSTRAINT "mega_personal_evolved_bool" CHECK("__new_mega_personal"."evolved" IN (0, 1)),
	CONSTRAINT "mega_personal_shinyEvolved_bool" CHECK("__new_mega_personal"."shiny_evolved" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_mega_personal`("mega_variant_slug", "profile_id", "evolved", "shiny_evolved", "updated_at") SELECT "mega_variant_slug", "profile_id", "evolved", "shiny_evolved", "updated_at" FROM `mega_personal`;--> statement-breakpoint
DROP TABLE `mega_personal`;--> statement-breakpoint
ALTER TABLE `__new_mega_personal` RENAME TO `mega_personal`;--> statement-breakpoint
CREATE TABLE `__new_player_progress_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` text NOT NULL REFERENCES profile(id),
	`recorded_at` integer NOT NULL,
	`current_level` integer,
	`total_xp` integer
);
--> statement-breakpoint
INSERT INTO `__new_player_progress_log`("id", "profile_id", "recorded_at", "current_level", "total_xp") SELECT "id", "profile_id", "recorded_at", "current_level", "total_xp" FROM `player_progress_log`;--> statement-breakpoint
DROP TABLE `player_progress_log`;--> statement-breakpoint
ALTER TABLE `__new_player_progress_log` RENAME TO `player_progress_log`;--> statement-breakpoint
CREATE TABLE `__new_player_progress_personal` (
	`profile_id` text PRIMARY KEY NOT NULL REFERENCES profile(id),
	`current_level` integer REFERENCES player_level(level),
	`total_xp` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_player_progress_personal`("profile_id", "current_level", "total_xp", "updated_at") SELECT "profile_id", "current_level", "total_xp", "updated_at" FROM `player_progress_personal`;--> statement-breakpoint
DROP TABLE `player_progress_personal`;--> statement-breakpoint
ALTER TABLE `__new_player_progress_personal` RENAME TO `player_progress_personal`;--> statement-breakpoint
CREATE TABLE `__new_pokemon_instance` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`form_slug` text NOT NULL REFERENCES form(slug),
	`profile_id` text NOT NULL REFERENCES profile(id),
	`status` text DEFAULT 'kept' NOT NULL,
	`recorded_at` integer NOT NULL,
	`caught_at` integer,
	`updated_at` integer NOT NULL,
	`cp` integer,
	`iv_attack` integer,
	`iv_defense` integer,
	`iv_stamina` integer,
	`iv_percent` real GENERATED ALWAYS AS (CASE WHEN iv_attack IS NOT NULL AND iv_defense IS NOT NULL AND iv_stamina IS NOT NULL THEN ROUND((iv_attack + iv_defense + iv_stamina) * 100.0 / 45, 1) ELSE NULL END) VIRTUAL,
	`shiny` integer DEFAULT false NOT NULL,
	`lucky` integer DEFAULT false NOT NULL,
	`shadow` integer DEFAULT false NOT NULL,
	`purified` integer DEFAULT false NOT NULL,
	`dynamax` integer DEFAULT false NOT NULL,
	`received_via_trade` integer DEFAULT false NOT NULL,
	`hearts_earned` integer,
	`current_mega_level` integer,
	`nickname` text,
	`background_slug` text REFERENCES backgrounds(slug),
	CONSTRAINT "pokemon_instance_shiny_bool" CHECK("__new_pokemon_instance"."shiny" IN (0, 1)),
	CONSTRAINT "pokemon_instance_lucky_bool" CHECK("__new_pokemon_instance"."lucky" IN (0, 1)),
	CONSTRAINT "pokemon_instance_shadow_bool" CHECK("__new_pokemon_instance"."shadow" IN (0, 1)),
	CONSTRAINT "pokemon_instance_purified_bool" CHECK("__new_pokemon_instance"."purified" IN (0, 1)),
	CONSTRAINT "pokemon_instance_dynamax_bool" CHECK("__new_pokemon_instance"."dynamax" IN (0, 1)),
	CONSTRAINT "pokemon_instance_receivedViaTrade_bool" CHECK("__new_pokemon_instance"."received_via_trade" IN (0, 1)),
	CONSTRAINT "pokemon_instance_status_enum" CHECK("__new_pokemon_instance"."status" IN ('kept', 'traded', 'released', 'evolved')),
	CONSTRAINT "pokemon_instance_iv_attack_range" CHECK("__new_pokemon_instance"."iv_attack" IS NULL OR ("__new_pokemon_instance"."iv_attack" >= 0 AND "__new_pokemon_instance"."iv_attack" <= 15)),
	CONSTRAINT "pokemon_instance_iv_defense_range" CHECK("__new_pokemon_instance"."iv_defense" IS NULL OR ("__new_pokemon_instance"."iv_defense" >= 0 AND "__new_pokemon_instance"."iv_defense" <= 15)),
	CONSTRAINT "pokemon_instance_iv_stamina_range" CHECK("__new_pokemon_instance"."iv_stamina" IS NULL OR ("__new_pokemon_instance"."iv_stamina" >= 0 AND "__new_pokemon_instance"."iv_stamina" <= 15))
);
--> statement-breakpoint
INSERT INTO `__new_pokemon_instance`("id", "form_slug", "profile_id", "status", "recorded_at", "caught_at", "updated_at", "cp", "iv_attack", "iv_defense", "iv_stamina", "shiny", "lucky", "shadow", "purified", "dynamax", "received_via_trade", "hearts_earned", "current_mega_level", "nickname", "background_slug") SELECT "id", "form_slug", "profile_id", "status", "recorded_at", "caught_at", "updated_at", "cp", "iv_attack", "iv_defense", "iv_stamina", "shiny", "lucky", "shadow", "purified", "dynamax", "received_via_trade", "hearts_earned", "current_mega_level", "nickname", "background_slug" FROM `pokemon_instance`;--> statement-breakpoint
DROP TABLE `pokemon_instance`;--> statement-breakpoint
ALTER TABLE `__new_pokemon_instance` RENAME TO `pokemon_instance`;--> statement-breakpoint
CREATE TABLE `__new_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`friend_code` text,
	`is_current` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_profile`("id", "username", "friend_code", "created_at") SELECT "id", "username", "friend_code", "created_at" FROM `profile`;--> statement-breakpoint
DROP TABLE `profile`;--> statement-breakpoint
ALTER TABLE `__new_profile` RENAME TO `profile`;--> statement-breakpoint
CREATE TABLE `__new_species_personal` (
	`species_slug` text NOT NULL REFERENCES species(slug),
	`profile_id` text NOT NULL REFERENCES profile(id),
	`registered` integer DEFAULT false NOT NULL,
	`xxl` integer DEFAULT false NOT NULL,
	`xxs` integer DEFAULT false NOT NULL,
	`purified` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`profile_id`, `species_slug`),
	CONSTRAINT "species_personal_registered_bool" CHECK("__new_species_personal"."registered" IN (0, 1)),
	CONSTRAINT "species_personal_xxl_bool" CHECK("__new_species_personal"."xxl" IN (0, 1)),
	CONSTRAINT "species_personal_xxs_bool" CHECK("__new_species_personal"."xxs" IN (0, 1)),
	CONSTRAINT "species_personal_purified_bool" CHECK("__new_species_personal"."purified" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_species_personal`("species_slug", "profile_id", "registered", "xxl", "xxs", "purified", "updated_at") SELECT "species_slug", "profile_id", "registered", "xxl", "xxs", "purified", "updated_at" FROM `species_personal`;--> statement-breakpoint
DROP TABLE `species_personal`;--> statement-breakpoint
ALTER TABLE `__new_species_personal` RENAME TO `species_personal`;--> statement-breakpoint
CREATE TABLE `__new_tag` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` text NOT NULL REFERENCES profile(id),
	`name` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_tag`("id", "profile_id", "name") SELECT "id", "profile_id", "name" FROM `tag`;--> statement-breakpoint
DROP TABLE `tag`;--> statement-breakpoint
ALTER TABLE `__new_tag` RENAME TO `tag`;--> statement-breakpoint
CREATE UNIQUE INDEX `tag_profile_id_name_unique` ON `tag` (`profile_id`,`name`);--> statement-breakpoint
PRAGMA foreign_keys=ON;