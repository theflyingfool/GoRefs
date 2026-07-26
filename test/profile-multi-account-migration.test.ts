import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { runPersonalMigrations } from "../src/db/migrations";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";

test("fresh install: composite PKs allow two profiles to each hold a row for the same slug", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  const profileRow = db.prepare("SELECT id FROM profile").get() as { id: string };

  // Insert a second profile directly and confirm species_personal accepts a
  // row for the same species_slug under both profiles (the whole point of
  // widening the PK). regions is inserted before species (FK: species ->
  // regions), and species before species_personal (FK: species_personal ->
  // species); foreign_keys is ON for the whole test.
  db.exec(`INSERT INTO profile (id, username, is_current, created_at) VALUES ('11111111-1111-1111-1111-111111111111', 'Second', 0, 0)`);
  db.exec(`INSERT INTO regions (slug, name) VALUES ('kanto', 'Kanto')`);
  db.exec(`INSERT INTO species (slug, dex_number, name, family_slug, gen, rarity, region_slug, has_male, has_female, can_mega_evolve, can_gigantamax) VALUES ('bulbasaur', 1, 'Bulbasaur', 'bulbasaur', 1, 'standard', 'kanto', 1, 1, 0, 0)`);
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '${profileRow.id}', 1, 0)`);
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '11111111-1111-1111-1111-111111111111', 0, 0)`);

  const rows = db.prepare("SELECT profile_id, registered FROM species_personal WHERE species_slug = 'bulbasaur' ORDER BY profile_id").all();
  assert.equal(rows.length, 2);

  // The widened profile_id -> profile(id) FK is really enforced (the
  // Sub-project 2 carry-forward confirmation): a species_personal row for a
  // profile_id with no matching profile row must be rejected.
  assert.throws(
    () =>
      db.exec(
        `INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '99999999-9999-9999-9999-999999999999', 0, 0)`,
      ),
    /FOREIGN KEY constraint failed/,
  );

  // Confirm profile.id is a real UUID (36 chars, has dashes), not a bare "1".
  // Checked LAST: this is Task 2's UUID-seeding job, so it is expected to fail
  // until Task 2 lands — the composite-PK + FK-enforcement assertions above
  // (this task's actual deliverable) run and pass first regardless.
  assert.match(profileRow.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("upgrade from a v9 single-profile device: profile_id=1 is rewritten to a real UUID everywhere", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  // A pre-Drizzle device (schema_version row, no __drizzle_migrations table)
  // triggers the bootstrap path, which replays migrations 0001->0004. Every
  // one of those does an INSERT...SELECT-by-column-name against these tables,
  // so the fixture must supply the full pre-migration (v6-era) column set for
  // each — mirroring test/fixtures/v6-personal-schema.sql. Tables the test
  // doesn't assert on are created empty; only their columns need to exist so
  // the migration chain runs end-to-end instead of dying on a missing table.
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (9);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE profile (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, friend_code TEXT, created_at INTEGER NOT NULL);
    INSERT INTO profile (id, username, created_at) VALUES (1, 'Trainer', 0);
    CREATE TABLE species_personal (species_slug TEXT PRIMARY KEY, profile_id INTEGER NOT NULL DEFAULT 1, registered INTEGER NOT NULL DEFAULT 0, xxl INTEGER NOT NULL DEFAULT 0, xxs INTEGER NOT NULL DEFAULT 0, purified INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', 1, 1, 12345);
    CREATE TABLE form_personal (
      form_slug TEXT PRIMARY KEY, profile_id INTEGER NOT NULL DEFAULT 1,
      caught INTEGER NOT NULL DEFAULT 0, shiny INTEGER NOT NULL DEFAULT 0, floor INTEGER NOT NULL DEFAULT 0, four_star INTEGER NOT NULL DEFAULT 0, shundo INTEGER NOT NULL DEFAULT 0,
      lucky INTEGER NOT NULL DEFAULT 0, lucky_shiny INTEGER NOT NULL DEFAULT 0, lucky_floor INTEGER NOT NULL DEFAULT 0, lucky_four_star INTEGER NOT NULL DEFAULT 0, lucky_shundo INTEGER NOT NULL DEFAULT 0,
      shadow INTEGER NOT NULL DEFAULT 0, shadow_shiny INTEGER NOT NULL DEFAULT 0, shadow_floor INTEGER NOT NULL DEFAULT 0, shadow_four_star INTEGER NOT NULL DEFAULT 0, shadow_shundo INTEGER NOT NULL DEFAULT 0,
      dynamax INTEGER NOT NULL DEFAULT 0, dynamax_floor INTEGER NOT NULL DEFAULT 0, dynamax_shiny INTEGER NOT NULL DEFAULT 0, dynamax_four_star INTEGER NOT NULL DEFAULT 0, dynamax_shundo INTEGER NOT NULL DEFAULT 0,
      lucky_dynamax INTEGER NOT NULL DEFAULT 0, lucky_dynamax_floor INTEGER NOT NULL DEFAULT 0, lucky_dynamax_shiny INTEGER NOT NULL DEFAULT 0, lucky_dynamax_four_star INTEGER NOT NULL DEFAULT 0, lucky_dynamax_shundo INTEGER NOT NULL DEFAULT 0,
      best_shiny TEXT, best_non_shiny TEXT, best_lucky TEXT, updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'
    );
    CREATE TABLE form_background_personal (form_slug TEXT NOT NULL, profile_id INTEGER NOT NULL DEFAULT 1, achievement_field TEXT NOT NULL, background_slug TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z', PRIMARY KEY (form_slug, achievement_field, background_slug));
    CREATE TABLE mega_personal (mega_variant_slug TEXT PRIMARY KEY, profile_id INTEGER NOT NULL DEFAULT 1, evolved INTEGER NOT NULL DEFAULT 0, shiny_evolved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z');
    CREATE TABLE pokemon_instance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, form_slug TEXT NOT NULL, profile_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'kept',
      recorded_at TEXT NOT NULL, caught_at TEXT, updated_at TEXT NOT NULL, cp INTEGER, iv_percent REAL,
      shiny INTEGER NOT NULL DEFAULT 0, lucky INTEGER NOT NULL DEFAULT 0, shadow INTEGER NOT NULL DEFAULT 0, purified INTEGER NOT NULL DEFAULT 0,
      hearts_earned INTEGER, current_mega_level INTEGER, nickname TEXT, background_slug TEXT
    );
    CREATE TABLE tag (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, name TEXT NOT NULL, UNIQUE(profile_id, name));
    CREATE TABLE pokemon_instance_tag (pokemon_instance_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (pokemon_instance_id, tag_id));
    CREATE TABLE pokemon_instance_max_move (pokemon_instance_id INTEGER NOT NULL, move_slot TEXT NOT NULL, level INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY (pokemon_instance_id, move_slot));
    CREATE TABLE player_progress_personal (profile_id INTEGER PRIMARY KEY, current_level INTEGER, total_xp INTEGER, updated_at TEXT NOT NULL);
    CREATE TABLE medal_progress_personal (medal_slug TEXT NOT NULL, profile_id INTEGER NOT NULL DEFAULT 1, current_rank INTEGER NOT NULL DEFAULT 0, current_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (medal_slug, profile_id));
    CREATE TABLE player_progress_log (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL DEFAULT 1, recorded_at TEXT NOT NULL, current_level INTEGER, total_xp INTEGER);
    CREATE TABLE personal_data_quarantine (id INTEGER PRIMARY KEY AUTOINCREMENT, source_table TEXT NOT NULL, slug TEXT NOT NULL, payload_json TEXT NOT NULL, quarantined_at TEXT NOT NULL);
  `);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  const profileRow = db.prepare("SELECT id, is_current FROM profile").get() as { id: string; is_current: number };
  assert.match(profileRow.id, /^[0-9a-f]{8}-/);
  assert.equal(profileRow.is_current, 1);

  const speciesRow = db.prepare("SELECT profile_id, registered, updated_at FROM species_personal WHERE species_slug = 'bulbasaur'").get() as {
    profile_id: string;
    registered: number;
    updated_at: number;
  };
  assert.equal(speciesRow.profile_id, profileRow.id);
  assert.equal(speciesRow.registered, 1);
  assert.equal(speciesRow.updated_at, 12345); // pre-existing data survived, not just the id rewrite
});
