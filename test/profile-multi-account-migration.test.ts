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

  // Confirm profile.id is a real UUID (36 chars, has dashes), not a bare "1".
  const profileRow = db.prepare("SELECT id FROM profile").get() as { id: string };
  assert.match(profileRow.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // Insert a second profile directly and confirm species_personal accepts a
  // row for the same species_slug under both profiles (the whole point of
  // widening the PK).
  db.exec(`INSERT INTO profile (id, username, is_current, created_at) VALUES ('11111111-1111-1111-1111-111111111111', 'Second', 0, 0)`);
  db.exec(`INSERT INTO species (slug, dex_number, name, family_slug, gen, rarity, region_slug, has_male, has_female, can_mega_evolve, can_gigantamax) VALUES ('bulbasaur', 1, 'Bulbasaur', 'bulbasaur', 1, 'standard', 'kanto', 1, 1, 0, 0)`);
  db.exec(`INSERT INTO regions (slug, name) VALUES ('kanto', 'Kanto')`);
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '${profileRow.id}', 1, 0)`);
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '11111111-1111-1111-1111-111111111111', 0, 0)`);

  const rows = db.prepare("SELECT profile_id, registered FROM species_personal WHERE species_slug = 'bulbasaur' ORDER BY profile_id").all();
  assert.equal(rows.length, 2);
});

test("upgrade from a v9 single-profile device: profile_id=1 is rewritten to a real UUID everywhere", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (9);
    CREATE TABLE profile (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, friend_code TEXT, created_at INTEGER NOT NULL);
    INSERT INTO profile (id, username, created_at) VALUES (1, 'Trainer', 0);
    CREATE TABLE species_personal (species_slug TEXT PRIMARY KEY, profile_id INTEGER NOT NULL DEFAULT 1, registered INTEGER NOT NULL DEFAULT 0, xxl INTEGER NOT NULL DEFAULT 0, xxs INTEGER NOT NULL DEFAULT 0, purified INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', 1, 1, 12345);
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
