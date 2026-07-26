import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";

// This test exercises loadAllProfiles + the profile-scoped write builders
// together, at the level createSqliteRepository's own logic operates on —
// not through the full Tauri-connected repository (not constructible under
// node:test), but through the same functions it calls internally.
import { loadAllProfiles } from "../src/data/sqlite-repository";
import { buildProfileDeleteStatements } from "../src/data/profile-management-sql";
import { buildSpeciesPersonalUpsert } from "../src/data/profile-scoped-write-sql";
import { runPersonalMigrations } from "../src/db/migrations";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";

test("two profiles' species_personal writes stay isolated after loading both", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);
  const firstId = (db.prepare("SELECT id FROM profile").get() as { id: string }).id;
  const secondId = "33333333-3333-3333-3333-333333333333";
  db.exec(`INSERT INTO profile (id, username, is_current, created_at) VALUES ('${secondId}', 'Second', 0, 0)`);
  db.exec(`INSERT INTO regions (slug, name) VALUES ('kanto', 'Kanto')`);
  db.exec(
    `INSERT INTO species (slug, dex_number, name, family_slug, gen, rarity, region_slug, has_male, has_female, can_mega_evolve, can_gigantamax) VALUES ('bulbasaur', 1, 'Bulbasaur', 'bulbasaur', 1, 'standard', 'kanto', 1, 1, 0, 0)`,
  );

  const first = buildSpeciesPersonalUpsert(firstId, "bulbasaur", { registered: true, xxl: false, xxs: false, purified: false, updatedAt: 1 });
  const second = buildSpeciesPersonalUpsert(secondId, "bulbasaur", { registered: false, xxl: false, xxs: false, purified: false, updatedAt: 2 });
  db.prepare(first.sql).run(...(first.params as never[]));
  db.prepare(second.sql).run(...(second.params as never[]));

  const { buckets } = await loadAllProfiles(conn);
  assert.equal(buckets.get(firstId)!.speciesPersonal.bulbasaur.registered, true);
  assert.equal(buckets.get(secondId)!.speciesPersonal.bulbasaur.registered, false);
});

test("deleting a profile removes exactly its own species_personal row", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);
  const firstId = (db.prepare("SELECT id FROM profile").get() as { id: string }).id;
  const secondId = "44444444-4444-4444-4444-444444444444";
  db.exec(`INSERT INTO profile (id, username, is_current, created_at) VALUES ('${secondId}', 'Second', 0, 0)`);

  db.exec("PRAGMA defer_foreign_keys = true;");
  for (const { sql, params } of buildProfileDeleteStatements(secondId)) {
    db.prepare(sql).run(...(params as never[]));
  }
  const remaining = db.prepare("SELECT id FROM profile").all() as { id: string }[];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, firstId);
});
