import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { runPersonalMigrations } from "../src/db/migrations";
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
  const profileRow = db.prepare("SELECT id, username FROM profile").get() as { id: number; username: string } | undefined;
  assert.equal(profileRow?.id, 1, "expected the default profile row to be seeded on a fresh install");
  assert.equal(profileRow?.username, "Trainer");
});

test("runPersonalMigrations is a no-op replay for a device already at the current migration", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  // A fresh install applies all four migrations (0000, then 0001's
  // timestamp rebuild, 0002's iv_percent generated-column rebuild, and
  // 0003's dynamax/received_via_trade rebuild — all no-ops over the empty
  // tables 0000 just created) — expect 4 rows, not 1. Adjust this count if
  // a later task adds migration 0004+.
  const countAfterFirst = (db.prepare("SELECT COUNT(*) as c FROM __drizzle_migrations").get() as { c: number }).c;
  assert.equal(countAfterFirst, 4);

  await runPersonalMigrations(nodeSqliteConnection(db));
  const countAfterSecond = (db.prepare("SELECT COUNT(*) as c FROM __drizzle_migrations").get() as { c: number }).c;
  assert.equal(countAfterSecond, countAfterFirst, "second run should not insert another migration row");
});
