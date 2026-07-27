// Gating test for the Drizzle migration plan: replays a real shipped v1.0.0
// device (personal-schema v6, ISO-string TEXT timestamps — see
// test/fixtures/v6-personal-schema.sql) through runPersonalMigrations() and
// confirms every existing row survives and every TEXT timestamp column is
// genuinely converted to epoch-ms INTEGER, not just cosmetically readable.
//
// getDrizzleDb() (src/db/drizzle-client.ts) takes the SQLiteDBConnection as a
// parameter and holds no module-level singleton, so this file builds a fresh
// Drizzle instance directly against the fixture connection — no
// mock.module() gymnastics needed (contrast with the superseded
// .superpowers/sdd/verify-migration-bootstrap.test.ts, written against an
// earlier getDrizzleDb() that cached a connection internally).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { runPersonalMigrations } from "../src/db/migrations";
import { getDrizzleDb } from "../src/db/drizzle-client";
import { profile, speciesPersonal, pokemonInstance } from "../src/db/schema/personal";
import { eq } from "drizzle-orm";
import { nodeSqliteConnection } from "./node-sqlite-connection";

const __dirname = dirname(fileURLToPath(import.meta.url));

function v6FixtureDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(resolve(__dirname, "fixtures/v6-personal-schema.sql"), "utf8"));
  return db;
}

function v5FixtureDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(resolve(__dirname, "fixtures/v5-personal-schema.sql"), "utf8"));
  return db;
}

test("bootstrapping a real v6 device preserves every existing row and correctly converts timestamps", async () => {
  const db = v6FixtureDb();
  const maxExistingInstanceId = (db.prepare("SELECT MAX(id) as m FROM pokemon_instance").get() as { m: number }).m;

  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  // node:sqlite's .get() returns a null-prototype object, so these are
  // spread into plain objects before comparing — assert.deepEqual under
  // node:assert/strict is deepStrictEqual, which checks prototypes too.
  const afterSpecies = { ...db.prepare("SELECT species_slug, registered, xxl FROM species_personal WHERE species_slug = 'bulbasaur'").get() };
  assert.deepEqual(afterSpecies, { species_slug: "bulbasaur", registered: 1, xxl: 1 });

  const afterInstance = { ...db.prepare("SELECT form_slug, cp, shiny FROM pokemon_instance WHERE form_slug = 'bulbasaur-standard-male'").get() };
  assert.deepEqual(afterInstance, { form_slug: "bulbasaur-standard-male", cp: 1200, shiny: 1 });

  // The column's actual on-disk storage class changed, not just its display value.
  const rawType = db.prepare("SELECT typeof(updated_at) as t FROM species_personal WHERE species_slug = 'bulbasaur'").get() as { t: string };
  assert.equal(rawType.t, "integer");

  // A real Drizzle read (the same path the app uses) returns a valid Date, not Invalid Date.
  const drizzleDb = getDrizzleDb(conn);
  const [speciesRow] = await drizzleDb.select().from(speciesPersonal).where(eq(speciesPersonal.speciesSlug, "bulbasaur"));
  assert.ok(speciesRow.updatedAt instanceof Date && !Number.isNaN(speciesRow.updatedAt.getTime()), "expected a valid Date, not Invalid Date");
  assert.equal(speciesRow.updatedAt.getTime(), new Date("2026-06-15T10:30:00.000Z").getTime());

  const [instanceRow] = await drizzleDb.select().from(pokemonInstance).where(eq(pokemonInstance.formSlug, "bulbasaur-standard-male"));
  assert.equal(instanceRow.caughtAt?.getTime(), new Date("2026-06-14T18:00:00.000Z").getTime());
  assert.equal(instanceRow.recordedAt.getTime(), new Date("2026-06-15T10:31:00.000Z").getTime());

  // profile.id is TEXT as of migration 0004 (multi-account): the rebuild
  // carries the old integer id=1 across into the TEXT column as "1", but
  // Sub-project 7a Task 2's randomizeLegacyProfileId then rewrites it to a
  // real UUID unconditionally as part of runPersonalMigrations — no
  // consumer should assume id === "1" (or any other fixed sentinel) once
  // migrations have run. This fixture has exactly one profile row, so
  // selecting without a filter (or filtering on isCurrent) is enough.
  const [profileRow] = await drizzleDb.select().from(profile).where(eq(profile.isCurrent, true));
  assert.equal(profileRow.createdAt.getTime(), new Date("2026-01-01T00:00:00.000Z").getTime());

  // Drizzle's tracking table reflects all six migrations applied (0000's bootstrap row, then 0001, 0002, 0003, 0004, and 0005 applied normally).
  const migrationRows = db.prepare("SELECT COUNT(*) as c FROM __drizzle_migrations").get() as { c: number };
  assert.equal(migrationRows.c, 6);

  // A new row's id doesn't collide with any id that survived the rebuild. Note this doesn't prove
  // AUTOINCREMENT's sequence high-water mark survives a rebuild in general — with a single
  // pre-existing row, the next id is 2 regardless of whether the sequence was preserved; that would
  // only be exercised by a fixture with a gap (a previously hard-deleted row above the current max),
  // a scenario the app doesn't currently produce (pokemon_instance rows are soft-deleted via
  // `status`, never hard-deleted) — see this plan's "Known, accepted limitation" note. FK enforcement
  // is toggled off just for this insert: the
  // post-migration pokemon_instance table carries REFERENCES clauses into species/form/backgrounds
  // (reference tables the real app creates via syncReferenceData(), which runs after
  // runPersonalMigrations() and is out of scope for this test) — SQLite validates a REFERENCES
  // target's table existence at INSERT-time regardless of row/NULL values, so this insert would
  // otherwise fail on a missing reference table unrelated to what's being checked here.
  db.exec("PRAGMA foreign_keys = OFF");
  const insertResult = db.prepare("INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at) VALUES ('bulbasaur-standard-male', 1, 0, 0)").run();
  db.exec("PRAGMA foreign_keys = ON");
  assert.ok(Number(insertResult.lastInsertRowid) > maxExistingInstanceId, "new row's id should not collide with a pre-migration id");
});

test("a second boot after bootstrapping is a no-op", async () => {
  const db = v6FixtureDb();
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);
  const countAfterFirst = (db.prepare("SELECT COUNT(*) as c FROM __drizzle_migrations").get() as { c: number }).c;

  await runPersonalMigrations(conn);
  const countAfterSecond = (db.prepare("SELECT COUNT(*) as c FROM __drizzle_migrations").get() as { c: number }).c;

  assert.equal(countAfterFirst, countAfterSecond);
});

// The final whole-branch review caught a real gap: real devices are known
// to be at hand-rolled personal-schema v5 or v6 (v1.0.0's tagged release,
// schema v2, was never actually distributed) — the original gating test
// above only covered v6. A genuine v5 device is missing player_progress_log
// entirely; migration 0001 unconditionally rebuilds that table
// (DROP TABLE + INSERT ... SELECT FROM player_progress_log), which would
// throw "no such table" without createMissingV5Tables()'s defensive create.
test("bootstrapping a real v5 device (missing player_progress_log) does not crash", async () => {
  const db = v5FixtureDb();
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'player_progress_log'").get(), undefined);

  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  // Migration completed without throwing, and the table 0001's rebuild
  // needs now exists in the final (converted) shape.
  const columnInfo = db.prepare("PRAGMA table_info(player_progress_log)").all() as { name: string; type: string }[];
  const recordedAt = columnInfo.find((c) => c.name === "recorded_at");
  assert.equal(recordedAt?.type.toLowerCase(), "integer");

  // Every other v5 row survived, same as the v6 gating test asserts.
  const afterSpecies = { ...db.prepare("SELECT species_slug, registered, xxl FROM species_personal WHERE species_slug = 'bulbasaur'").get() };
  assert.deepEqual(afterSpecies, { species_slug: "bulbasaur", registered: 1, xxl: 1 });

  const migrationRows = db.prepare("SELECT COUNT(*) as c FROM __drizzle_migrations").get() as { c: number };
  assert.equal(migrationRows.c, 6);
});

// A prior review flagged a schema-parity gap: the old hand-rolled migration
// system's `ALTER TABLE ... ADD COLUMN profile_id` (pre-Drizzle) couldn't add
// a REFERENCES clause (SQLite disallows adding a foreign key via ALTER TABLE
// with a non-null default) — the v6 fixture above accurately reproduces that
// real, unenforced state (see test/fixtures/v6-personal-schema.sql's
// `profile_id INTEGER NOT NULL DEFAULT 1` columns, no REFERENCES anywhere).
// Migration 0001's table-rebuild (see its own header comment) recreates
// every one of those columns with a real `REFERENCES profile(id)` clause, as
// part of the same rebuild that does the TEXT->INTEGER timestamp conversion
// — this test confirms that rebuild actually lands enforced FK behavior for
// a device coming from that unenforced v6 state, not just a textually
// present but inert constraint.
test("bootstrapping a real v6 device (unenforced profile_id FK) results in a real, enforced FK", async () => {
  const db = v6FixtureDb();
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  // player_progress_log, not player_progress_personal: player_progress_personal's
  // current_level column carries its own separate FK into player_level (a
  // reference table syncReferenceData() creates, out of scope for this
  // migration-only test) — SQLite validates a REFERENCES target's table
  // existence at INSERT-time regardless of the bound value, so any insert
  // there fails for an unrelated reason. player_progress_log's profile_id is
  // the only FK on that table, so it isolates the check this test cares about.
  const fkList = db.prepare("PRAGMA foreign_key_list(player_progress_log)").all() as { table: string }[];
  assert.ok(
    fkList.some((fk) => fk.table === "profile"),
    "expected player_progress_log to declare a foreign key into profile after migration",
  );

  assert.throws(
    () => db.prepare("INSERT INTO player_progress_log (profile_id, recorded_at, current_level, total_xp) VALUES (999, 0, NULL, 100)").run(),
    /FOREIGN KEY constraint failed/,
    "a profile_id with no matching profile row should now be rejected",
  );
});
