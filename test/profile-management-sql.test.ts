import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildProfileDeleteStatements, buildDeleteProfileStatements } from "../src/data/profile-management-sql";

// Minimal-but-COMPLETE stand-in for the real migrated schema: one CREATE TABLE
// for every table buildProfileDeleteStatements touches (13). If the builder
// gains a table, add its CREATE TABLE here or the DELETE will throw
// `no such table` at prepare time.
const SCHEMA_DDL = `
  CREATE TABLE profile (id TEXT PRIMARY KEY, username TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE species_personal (species_slug TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profile(id), registered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, species_slug));
  CREATE TABLE form_personal (form_slug TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profile(id), caught INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, form_slug));
  CREATE TABLE mega_personal (mega_variant_slug TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profile(id), evolved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, mega_variant_slug));
  CREATE TABLE form_background_personal (form_slug TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profile(id), achievement_field TEXT NOT NULL, background_slug TEXT NOT NULL, PRIMARY KEY (profile_id, form_slug, achievement_field, background_slug));
  CREATE TABLE app_settings (key TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profile(id), value TEXT NOT NULL, PRIMARY KEY (profile_id, key));
  CREATE TABLE player_progress_personal (profile_id TEXT PRIMARY KEY REFERENCES profile(id), current_level INTEGER, total_xp INTEGER);
  CREATE TABLE player_progress_log (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profile(id), recorded_at INTEGER NOT NULL);
  CREATE TABLE medal_progress_personal (medal_slug TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profile(id), current_rank INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (medal_slug, profile_id));
  CREATE TABLE pokemon_instance (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profile(id));
  CREATE TABLE pokemon_instance_tag (pokemon_instance_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (pokemon_instance_id, tag_id));
  CREATE TABLE pokemon_instance_max_move (pokemon_instance_id INTEGER NOT NULL, move_slot TEXT NOT NULL, PRIMARY KEY (pokemon_instance_id, move_slot));
  CREATE TABLE tag (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profile(id), name TEXT NOT NULL);
`;

const currentCount = (db: DatabaseSync) =>
  (db.prepare("SELECT COUNT(*) as c FROM profile WHERE is_current = 1").get() as { c: number }).c;
const currentId = (db: DatabaseSync) =>
  (db.prepare("SELECT id FROM profile WHERE is_current = 1").get() as { id: string } | undefined)?.id;
const profileCount = (db: DatabaseSync) =>
  (db.prepare("SELECT COUNT(*) as c FROM profile").get() as { c: number }).c;

test("buildProfileDeleteStatements removes exactly one profile's rows across every profile-scoped table, leaving others untouched", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_DDL);
  db.exec(`
    INSERT INTO profile (id, username, created_at) VALUES ('a', 'A', 0), ('b', 'B', 0);
    INSERT INTO species_personal (species_slug, profile_id, registered) VALUES ('bulbasaur', 'a', 1), ('bulbasaur', 'b', 1);
    INSERT INTO form_personal (form_slug, profile_id, caught) VALUES ('bulbasaur-normal', 'a', 1), ('bulbasaur-normal', 'b', 1);
    INSERT INTO mega_personal (mega_variant_slug, profile_id, evolved) VALUES ('venusaur-mega', 'a', 1), ('venusaur-mega', 'b', 1);
    INSERT INTO form_background_personal (form_slug, profile_id, achievement_field, background_slug) VALUES ('bulbasaur-normal', 'a', 'caught', 'bg1'), ('bulbasaur-normal', 'b', 'caught', 'bg1');
    INSERT INTO app_settings (key, profile_id, value) VALUES ('grid_indicators', 'a', '[]'), ('grid_indicators', 'b', '[]');
    INSERT INTO player_progress_personal (profile_id, current_level, total_xp) VALUES ('a', 40, 100), ('b', 30, 50);
    INSERT INTO player_progress_log (profile_id, recorded_at) VALUES ('a', 1), ('b', 2);
    INSERT INTO medal_progress_personal (medal_slug, profile_id, current_rank) VALUES ('kanto', 'a', 3), ('kanto', 'b', 3);
    INSERT INTO pokemon_instance (id, profile_id) VALUES (1, 'a'), (2, 'b');
    INSERT INTO tag (id, profile_id, name) VALUES (10, 'a', 'shiny'), (20, 'b', 'shiny');
    INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (1, 10), (2, 20);
    INSERT INTO pokemon_instance_max_move (pokemon_instance_id, move_slot) VALUES (1, 'slot1');
  `);

  const statements = buildProfileDeleteStatements("a");
  db.exec("PRAGMA defer_foreign_keys = true;");
  for (const { sql, params } of statements) {
    db.prepare(sql).run(...(params as never[]));
  }

  const countA = (table: string, col = "profile_id") =>
    (db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE ${col} = 'a'`).get() as { c: number }).c;

  // Every profile-scoped table with a profile_id column is emptied for 'a'.
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM profile WHERE id = 'a'").get() as { c: number }).c, 0);
  assert.equal(countA("species_personal"), 0);
  assert.equal(countA("form_personal"), 0);
  assert.equal(countA("mega_personal"), 0);
  assert.equal(countA("form_background_personal"), 0);
  assert.equal(countA("app_settings"), 0);
  assert.equal(countA("player_progress_personal"), 0);
  assert.equal(countA("player_progress_log"), 0);
  assert.equal(countA("medal_progress_personal"), 0);
  assert.equal(countA("pokemon_instance"), 0);
  assert.equal(countA("tag"), 0);
  // Join tables (no profile_id column) are cleared via the instance subquery.
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM pokemon_instance_tag WHERE pokemon_instance_id = 1").get() as { c: number }).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM pokemon_instance_max_move WHERE pokemon_instance_id = 1").get() as { c: number }).c, 0);

  // Profile B's data is completely untouched across every table.
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM profile WHERE id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT registered FROM species_personal WHERE profile_id = 'b'").get() as { registered: number }).registered, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM form_personal WHERE profile_id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM mega_personal WHERE profile_id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM form_background_personal WHERE profile_id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM app_settings WHERE profile_id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM player_progress_personal WHERE profile_id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM player_progress_log WHERE profile_id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM medal_progress_personal WHERE profile_id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM pokemon_instance WHERE profile_id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM tag WHERE profile_id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM pokemon_instance_tag WHERE pokemon_instance_id = 2").get() as { c: number }).c, 1);
});

test("buildDeleteProfileStatements flips is_current to the survivor and deletes the target in one transaction", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_DDL);
  // P is the current profile; Q is the survivor we're switching to.
  db.exec("INSERT INTO profile (id, username, is_current, created_at) VALUES ('p', 'P', 1, 0), ('q', 'Q', 0, 0);");
  db.exec("INSERT INTO species_personal (species_slug, profile_id, registered) VALUES ('bulbasaur', 'p', 1), ('bulbasaur', 'q', 1);");

  db.exec("BEGIN");
  db.exec("PRAGMA defer_foreign_keys = true");
  for (const { sql, params } of buildDeleteProfileStatements("p", "q")) {
    db.prepare(sql).run(...(params as never[]));
  }
  db.exec("COMMIT");

  assert.equal(profileCount(db), 1);
  assert.equal(currentCount(db), 1); // exactly one current, never zero
  assert.equal(currentId(db), "q"); // the survivor was promoted
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM species_personal WHERE profile_id = 'p'").get() as { c: number }).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM species_personal WHERE profile_id = 'q'").get() as { c: number }).c, 1);
});

test("flip + cascade are atomic: a failure mid-transaction rolls back the is_current flip, never leaving zero current profiles", () => {
  // This is the regression test for the two-separate-transactions bug: if the
  // is_current flip and the cascade delete were NOT one atomic unit, a failure
  // after the flip but during the delete could leave the old current row deleted
  // with no survivor promoted — zero profiles current. Folding both into one
  // transaction means any failure rolls the flip back too.
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_DDL);
  db.exec("INSERT INTO profile (id, username, is_current, created_at) VALUES ('p', 'P', 1, 0), ('q', 'Q', 0, 0);");

  // Build the real combined statement list, then inject a guaranteed-to-throw
  // statement partway through (after the flip) to simulate a cascade statement
  // failing mid-transaction.
  const statements = buildDeleteProfileStatements("p", "q");
  const flipCount = 2; // the two UPDATE profile SET is_current statements
  const withInjectedFailure = [
    ...statements.slice(0, flipCount),
    { sql: "DELETE FROM this_table_does_not_exist", params: [] },
    ...statements.slice(flipCount),
  ];

  let threw = false;
  db.exec("BEGIN");
  try {
    db.exec("PRAGMA defer_foreign_keys = true");
    for (const { sql, params } of withInjectedFailure) {
      db.prepare(sql).run(...(params as never[]));
    }
    db.exec("COMMIT");
  } catch {
    threw = true;
    db.exec("ROLLBACK");
  }

  assert.equal(threw, true);
  // The whole transaction — including the is_current flip — rolled back.
  assert.equal(profileCount(db), 2); // nothing deleted
  assert.equal(currentCount(db), 1); // still exactly one current
  assert.equal(currentId(db), "p"); // still the original current profile
});
