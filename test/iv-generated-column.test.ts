import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { runPersonalMigrations } from "../src/db/migrations";
import { computeIvPercent } from "../src/db/types";
import { nodeSqliteConnection } from "./node-sqlite-connection";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

test("pokemon_instance.iv_percent is computed from iv_attack/iv_defense/iv_stamina", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  db.exec("PRAGMA foreign_keys = OFF"); // form_slug/profile_id/background_slug reference tables this test doesn't create
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at, iv_attack, iv_defense, iv_stamina) VALUES ('bulbasaur-standard', 1, 0, 0, 15, 15, 15)",
  ).run();
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at, iv_attack, iv_defense, iv_stamina) VALUES ('bulbasaur-standard', 1, 0, 0, 0, 0, 0)",
  ).run();
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at, iv_attack, iv_defense, iv_stamina) VALUES ('bulbasaur-standard', 1, 0, 0, 10, 8, 4)",
  ).run();
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at, iv_attack, iv_defense, iv_stamina) VALUES ('bulbasaur-standard', 1, 0, 0, NULL, NULL, NULL)",
  ).run();

  const rows = db.prepare("SELECT iv_attack, iv_defense, iv_stamina, iv_percent FROM pokemon_instance ORDER BY id").all() as {
    iv_attack: number | null;
    iv_defense: number | null;
    iv_stamina: number | null;
    iv_percent: number | null;
  }[];

  assert.equal(rows[0].iv_percent, 100);
  assert.equal(rows[1].iv_percent, 0);
  assert.equal(rows[2].iv_percent, 48.9); // (10+8+4)*100/45 = 48.888... -> rounds to 48.9
  assert.equal(rows[3].iv_percent, null);
});

// Regression guard for the "computed, no drift" promise: computeIvPercent
// (used for the in-memory cache and the Log-a-catch live preview, both of
// which need a value before a DB round-trip is possible) must keep agreeing
// with the SQL generated column's rounding, not just happen to agree today.
// A future "simplification" (e.g. Math.floor instead of Math.round) would
// pass every other test in this file since they only assert the SQL side.
test("computeIvPercent matches the SQL generated column's rounding exactly", () => {
  assert.equal(computeIvPercent(15, 15, 15), 100);
  assert.equal(computeIvPercent(0, 0, 0), 0);
  assert.equal(computeIvPercent(10, 8, 4), 48.9); // (10+8+4)*100/45 = 48.888... -> rounds to 48.9, same as the SQL test above
  assert.equal(computeIvPercent(null, 15, 15), null);
  assert.equal(computeIvPercent(15, null, 15), null);
  assert.equal(computeIvPercent(15, 15, null), null);
});

test("inserting an out-of-range IV component is rejected by the CHECK constraint", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  db.exec("PRAGMA foreign_keys = OFF");
  assert.throws(() => {
    db.prepare(
      "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at, iv_attack, iv_defense, iv_stamina) VALUES ('bulbasaur-standard', 1, 0, 0, 16, 0, 0)",
    ).run();
  }, /CHECK constraint failed/);
});
