import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { runPersonalMigrations } from "../src/db/migrations";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";
import { nodeSqliteConnection } from "./node-sqlite-connection";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
}

test("runPersonalMigrations on a brand-new database creates every personal table", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));

  for (const table of [
    "species_personal",
    "form_personal",
    "app_settings",
    "mega_personal",
    "form_background_personal",
    "personal_data_quarantine",
    "profile",
    "pokemon_instance",
    "tag",
  ]) {
    assert.ok(tableExists(db, table), `expected ${table} to exist on a fresh install`);
  }
  assert.ok(tableExists(db, "__drizzle_migrations"), "expected Drizzle's tracking table to exist");

  // Drizzle-kit only generates schema DDL, never seed data — the default
  // profile row (every other personal table's profile_id column either
  // defaults to it or has a REFERENCES FK into it) has to come from app
  // code (see seedDefaultProfileIfMissing in migrations.ts). Asserted
  // directly here, not just indirectly via an FK failure elsewhere.
  const profileRow = db.prepare("SELECT id, username FROM profile").get() as { id: string; username: string } | undefined;
  assert.match(
    profileRow?.id ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "expected the default profile row to be seeded with a real UUID on a fresh install",
  );
  assert.equal(profileRow?.username, "Trainer");

  // referenced_trainer's invariant (every real profile has a mirrored row)
  // must hold from the very first boot, not just for profiles created later
  // via createProfile/renameProfile -- the default profile is seeded by
  // migrations.ts directly, a separate code path that must maintain the
  // same invariant.
  const referencedRow = db.prepare("SELECT uuid, name FROM referenced_trainer WHERE uuid = ?").get(profileRow?.id) as
    | { uuid: string; name: string }
    | undefined;
  assert.ok(referencedRow, "the boot-seeded default profile must have a mirrored referenced_trainer row");
  assert.equal(referencedRow?.name, "Trainer");
});

test("runPersonalMigrations is a no-op replay for a device already at the current migration", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  // A fresh install applies all six migrations (0000, then 0001's
  // timestamp rebuild, 0002's iv_percent generated-column rebuild, 0003's
  // dynamax/received_via_trade rebuild, 0004's multi-account PK-widen +
  // profile_id-retype rebuild, and 0005's identity/merge-gap rebuild — all
  // no-ops over the empty tables 0000 just created) — expect 6 rows, not 1.
  // Adjust this count if a later task adds migration 0006+.
  const countAfterFirst = (db.prepare("SELECT COUNT(*) as c FROM __drizzle_migrations").get() as { c: number }).c;
  assert.equal(countAfterFirst, 6);

  await runPersonalMigrations(nodeSqliteConnection(db));
  const countAfterSecond = (db.prepare("SELECT COUNT(*) as c FROM __drizzle_migrations").get() as { c: number }).c;
  assert.equal(countAfterSecond, countAfterFirst, "second run should not insert another migration row");
});

test("migration 0005 backfills pokemon_instance identity fields and creates referenced_trainer", async () => {
  // The brief's originally-specified version of this test ran
  // runPersonalMigrations against an EMPTY fresh database and then inserted
  // a pokemon_instance row (with uuid/original_trainer_name already
  // supplied) directly -- that never actually exercises migration 0005's
  // backfill UPDATE statements or the referenced_trainer <- profile seed
  // INSERT, both of which only have real work to do against pre-existing
  // rows. It also asserted referenced_trainer.name against a value
  // ("Tester") that only ever lands in original_trainer_name, never in
  // referenced_trainer.name (which mirrors profile.username). Replaced with
  // a genuine upgrade-path test: build the exact on-disk shape a device
  // already caught up through migration 0004 has (profile.id already a real
  // UUID -- Sub-project 7a's randomizeLegacyProfileId, untouched by this
  // task, is deliberately not exercised here so this test stays scoped to
  // 0005's own backfill logic), seed __drizzle_migrations with a row at
  // 0004's own journal timestamp (so only 0005 is "pending"), and insert two
  // pre-existing pokemon_instance rows using the OLD column set (no uuid/
  // original_trainer_name/original_trainer_id, one with the old 'released'
  // status value) before running the real migration chain.
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const profileId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  // 0004_empty_vapor's own journal timestamp -- see
  // src/db/migrations/meta/_journal.json. Marking __drizzle_migrations as
  // caught up through exactly this migration makes only 0005 "pending".
  const migration0004Millis = 1785024042576;
  db.exec(`
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC);
    INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('0004_empty_vapor', ${migration0004Millis});
    CREATE TABLE profile (id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL, friend_code TEXT, is_current INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO profile (id, username, is_current, created_at) VALUES ('${profileId}', 'Tester', 1, 0);
    CREATE TABLE pokemon_instance (
      id INTEGER PRIMARY KEY AUTOINCREMENT, form_slug TEXT NOT NULL, profile_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'kept',
      recorded_at INTEGER NOT NULL, caught_at INTEGER, updated_at INTEGER NOT NULL, cp INTEGER,
      iv_attack INTEGER, iv_defense INTEGER, iv_stamina INTEGER,
      iv_percent REAL GENERATED ALWAYS AS (CASE WHEN iv_attack IS NOT NULL AND iv_defense IS NOT NULL AND iv_stamina IS NOT NULL THEN ROUND((iv_attack + iv_defense + iv_stamina) * 100.0 / 45, 1) ELSE NULL END) VIRTUAL,
      shiny INTEGER NOT NULL DEFAULT 0, lucky INTEGER NOT NULL DEFAULT 0, shadow INTEGER NOT NULL DEFAULT 0, purified INTEGER NOT NULL DEFAULT 0,
      dynamax INTEGER NOT NULL DEFAULT 0, received_via_trade INTEGER NOT NULL DEFAULT 0,
      hearts_earned INTEGER, current_mega_level INTEGER, nickname TEXT, background_slug TEXT
    );
    INSERT INTO pokemon_instance (form_slug, profile_id, status, recorded_at, updated_at) VALUES ('bulbasaur-base', '${profileId}', 'kept', 0, 0);
    INSERT INTO pokemon_instance (form_slug, profile_id, status, recorded_at, updated_at) VALUES ('bulbasaur-base', '${profileId}', 'released', 0, 0);
    CREATE TABLE tag (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE UNIQUE INDEX tag_profile_id_name_unique ON tag (profile_id, name);
    CREATE TABLE pokemon_instance_tag (pokemon_instance_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (pokemon_instance_id, tag_id));
  `);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  const instanceRows = db.prepare("SELECT uuid, original_trainer_name, original_trainer_id, status FROM pokemon_instance ORDER BY id").all() as {
    uuid: string;
    original_trainer_name: string;
    original_trainer_id: string | null;
    status: string;
  }[];
  assert.equal(instanceRows.length, 2);
  const uuids = new Set<string>();
  for (const row of instanceRows) {
    assert.match(row.uuid, /^[0-9a-f]{32}$/, "expected a backfilled random uuid, not the placeholder");
    uuids.add(row.uuid);
    assert.equal(row.original_trainer_name, "Tester", "expected the backfill to pull this row's own profile's username");
    assert.equal(row.original_trainer_id, profileId, "expected the backfill to point original_trainer_id at this row's own profile");
  }
  assert.equal(uuids.size, 2, "expected two existing rows to get two DISTINCT backfilled uuids, not colliding placeholders (the uuid unique index must be created AFTER the backfill)");
  assert.equal(instanceRows[1].status, "transferred", "expected the old 'released' status value to be renamed to 'transferred'");

  const referenced = db.prepare("SELECT uuid, name FROM referenced_trainer WHERE uuid = ?").get(profileId) as { uuid: string; name: string } | undefined;
  assert.ok(referenced, "profile must have a mirrored referenced_trainer row");
  assert.equal(referenced!.name, "Tester");
});
