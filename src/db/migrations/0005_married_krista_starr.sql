-- Hand-edited after `npm run db:generate`, per 0000_baseline.sql's header
-- comment and the precedent in 0004_empty_vapor.sql. This migration adds
-- pokemon_instance.uuid/original_trainer_name/original_trainer_id, renames
-- pokemon_instance.status's 'released' value to 'transferred', changes tag's
-- uniqueness from per-profile to device-wide, and adds a new referenced_trainer
-- trainer-identity registry table, backfilled from every existing profile row.
-- See docs/superpowers/specs/2026-07-26-sub-project-7b-identity-and-merge-design.md.
--
-- Hand-fixes applied, same class as 0004:
--
-- (1) Restored the REFERENCES clauses drizzle-kit's rebuild drops on
-- pokemon_instance.form_slug -> form(slug), pokemon_instance.profile_id ->
-- profile(id), and pokemon_instance.background_slug -> backgrounds(slug) --
-- these columns are deliberately plain (no Drizzle `.references()`) because
-- their targets live in schema/reference.ts (see personal.ts's header
-- comment). pokemon_instance.original_trainer_id deliberately has NO
-- REFERENCES clause -- it's a soft link into referenced_trainer.uuid (see
-- the design doc section 3.1): a specimen naming a trainer this device has
-- never imported must not fail or silently drop on write.
--
-- (2) pokemon_instance's generated iv_percent column dropped from the
-- INSERT/SELECT column lists (SQLite rejects INSERTing a GENERATED column;
-- it's computed on read) -- same fix as every prior pokemon_instance rebuild.
--
-- (3) uuid and original_trainer_name are NOT NULL with no schema-level
-- default, so the straight `SELECT ... FROM pokemon_instance` drizzle-kit
-- emitted would fail against pre-existing rows (the old table has neither
-- column). Replaced with `'' AS uuid, '' AS original_trainer_name` (and
-- `NULL AS original_trainer_id`, since that column is new too) in the SELECT
-- list; the UPDATE statements immediately after the rename-back replace
-- these placeholders with real values.
--
-- (4) Moved `PRAGMA foreign_keys=OFF` to the very top and `PRAGMA
-- foreign_keys=ON` to the very end, bracketing the whole file (drizzle-kit
-- placed OFF only ahead of the pokemon_instance rebuild, and ON immediately
-- after it, leaving the referenced_trainer CREATE TABLE and the tag index
-- change outside the bracket) -- same multi-statement bracketing bug
-- documented in 0000_baseline.sql/0004_empty_vapor.sql. (Inert under this
-- project's runner, which toggles FK enforcement outside the migration
-- transaction -- see migrations.ts -- but kept correct to match every prior
-- migration.)
--
-- Beyond the mechanical rebuild, this migration adds real backfill logic
-- drizzle-kit cannot generate:
--
-- (5) The brief's originally-specified plan was to copy `status` straight
-- across in the rebuild's SELECT and rename 'released' -> 'transferred' via
-- a separate UPDATE run afterward, against the real `pokemon_instance` name.
-- That does not work: __new_pokemon_instance's own CHECK constraint
-- (pokemon_instance_status_enum) only allows 'kept'/'traded'/'transferred'/
-- 'evolved', and SQLite enforces CHECK constraints at INSERT time -- the
-- rebuild's `INSERT INTO __new_pokemon_instance ... SELECT ... FROM
-- pokemon_instance` fails immediately on any pre-existing 'released' row,
-- before a later UPDATE ever gets a chance to run. Fixed by translating the
-- value inline in the SELECT itself (`CASE WHEN status = 'released' THEN
-- 'transferred' ELSE status END`) instead of copying it as-is.
--
-- (6) After pokemon_instance is renamed back from __new_pokemon_instance,
-- three UPDATE statements populate the real values behind the uuid/
-- original_trainer_name/original_trainer_id placeholders above: uuid gets a
-- fresh random value per row, original_trainer_name gets that row's own
-- profile's current username (matches real Pokémon GO's "originally caught
-- by" field showing yourself for untraded Pokémon), and original_trainer_id
-- gets that row's own profile_id (every existing specimen's original
-- trainer is itself, until proven otherwise by a future trade). Note
-- `CREATE UNIQUE INDEX pokemon_instance_uuid_unique` is placed AFTER this
-- backfill, not immediately after the rename (drizzle-kit originally
-- generated it right after the rename) -- every pre-existing row lands with
-- uuid='' from the placeholder SELECT above, and '' is a real (colliding)
-- value, not NULL, so creating the unique index before the backfill runs
-- would fail with a UNIQUE constraint violation on any device with more
-- than one existing pokemon_instance row. Same class of hazard as the
-- tag_name_unique index below, just not called out by name in the brief.
--
-- (7) referenced_trainer (moved to appear after the pokemon_instance block,
-- since it's seeded from `profile` and reads better once pokemon_instance's
-- backfill has already established the pattern) is backfilled with one row
-- per existing profile -- see the design doc section 4.2's "every real
-- profile row has a mirrored referenced_trainer row" invariant.
--
-- (8) tag's uniqueness moves from (profile_id, name) to name alone. Real
-- per-profile duplicate tag names are now possible collisions (tags were
-- profile-scoped until this migration), so a de-duplication pass runs
-- before the new unique index is created: pokemon_instance_tag rows
-- pointing at a duplicate are repointed to the lowest-id survivor, then the
-- duplicate tag rows themselves are deleted. This must run before
-- `CREATE UNIQUE INDEX tag_name_unique`, or that statement fails if
-- duplicates remain.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`uuid` text NOT NULL,
	`original_trainer_name` text NOT NULL,
	`original_trainer_id` text,
	CONSTRAINT "pokemon_instance_shiny_bool" CHECK("__new_pokemon_instance"."shiny" IN (0, 1)),
	CONSTRAINT "pokemon_instance_lucky_bool" CHECK("__new_pokemon_instance"."lucky" IN (0, 1)),
	CONSTRAINT "pokemon_instance_shadow_bool" CHECK("__new_pokemon_instance"."shadow" IN (0, 1)),
	CONSTRAINT "pokemon_instance_purified_bool" CHECK("__new_pokemon_instance"."purified" IN (0, 1)),
	CONSTRAINT "pokemon_instance_dynamax_bool" CHECK("__new_pokemon_instance"."dynamax" IN (0, 1)),
	CONSTRAINT "pokemon_instance_receivedViaTrade_bool" CHECK("__new_pokemon_instance"."received_via_trade" IN (0, 1)),
	CONSTRAINT "pokemon_instance_status_enum" CHECK("__new_pokemon_instance"."status" IN ('kept', 'traded', 'transferred', 'evolved')),
	CONSTRAINT "pokemon_instance_iv_attack_range" CHECK("__new_pokemon_instance"."iv_attack" IS NULL OR ("__new_pokemon_instance"."iv_attack" >= 0 AND "__new_pokemon_instance"."iv_attack" <= 15)),
	CONSTRAINT "pokemon_instance_iv_defense_range" CHECK("__new_pokemon_instance"."iv_defense" IS NULL OR ("__new_pokemon_instance"."iv_defense" >= 0 AND "__new_pokemon_instance"."iv_defense" <= 15)),
	CONSTRAINT "pokemon_instance_iv_stamina_range" CHECK("__new_pokemon_instance"."iv_stamina" IS NULL OR ("__new_pokemon_instance"."iv_stamina" >= 0 AND "__new_pokemon_instance"."iv_stamina" <= 15))
);
--> statement-breakpoint
INSERT INTO `__new_pokemon_instance`("id", "form_slug", "profile_id", "status", "recorded_at", "caught_at", "updated_at", "cp", "iv_attack", "iv_defense", "iv_stamina", "shiny", "lucky", "shadow", "purified", "dynamax", "received_via_trade", "hearts_earned", "current_mega_level", "nickname", "background_slug", "uuid", "original_trainer_name", "original_trainer_id") SELECT "id", "form_slug", "profile_id", CASE WHEN "status" = 'released' THEN 'transferred' ELSE "status" END, "recorded_at", "caught_at", "updated_at", "cp", "iv_attack", "iv_defense", "iv_stamina", "shiny", "lucky", "shadow", "purified", "dynamax", "received_via_trade", "hearts_earned", "current_mega_level", "nickname", "background_slug", '' AS uuid, '' AS original_trainer_name, NULL AS original_trainer_id FROM `pokemon_instance`;--> statement-breakpoint
DROP TABLE `pokemon_instance`;--> statement-breakpoint
ALTER TABLE `__new_pokemon_instance` RENAME TO `pokemon_instance`;--> statement-breakpoint
UPDATE pokemon_instance SET uuid = lower(hex(randomblob(16))) WHERE uuid = '' OR uuid IS NULL;--> statement-breakpoint
UPDATE pokemon_instance SET original_trainer_name = (SELECT username FROM profile WHERE profile.id = pokemon_instance.profile_id) WHERE original_trainer_name = '' OR original_trainer_name IS NULL;--> statement-breakpoint
UPDATE pokemon_instance SET original_trainer_id = profile_id WHERE original_trainer_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `pokemon_instance_uuid_unique` ON `pokemon_instance` (`uuid`);--> statement-breakpoint
CREATE TABLE `referenced_trainer` (
	`uuid` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`friend_code` text
);
--> statement-breakpoint
INSERT INTO referenced_trainer (uuid, name, friend_code) SELECT id, username, friend_code FROM profile;--> statement-breakpoint
UPDATE pokemon_instance_tag SET tag_id = (
  SELECT MIN(t2.id) FROM tag t1 JOIN tag t2 ON t2.name = t1.name WHERE t1.id = pokemon_instance_tag.tag_id
) WHERE tag_id IN (
  SELECT t1.id FROM tag t1 JOIN tag t2 ON t2.name = t1.name AND t2.id < t1.id
);--> statement-breakpoint
DELETE FROM tag WHERE id IN (
  SELECT t1.id FROM tag t1 JOIN tag t2 ON t2.name = t1.name AND t2.id < t1.id
);--> statement-breakpoint
DROP INDEX `tag_profile_id_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `tag_name_unique` ON `tag` (`name`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
