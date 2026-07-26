import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { loadAllProfiles } from "../src/data/sqlite-repository";
import { runPersonalMigrations } from "../src/db/migrations";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";

test("loadAllProfiles returns one isolated bucket per profile, keyed correctly to the current profile", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  const firstProfileId = (db.prepare("SELECT id FROM profile").get() as { id: string }).id;
  const secondProfileId = "22222222-2222-2222-2222-222222222222";
  db.exec(`INSERT INTO profile (id, username, is_current, created_at) VALUES ('${secondProfileId}', 'Second', 0, 0)`);
  db.exec(`INSERT INTO regions (slug, name) VALUES ('kanto', 'Kanto')`);
  db.exec(
    `INSERT INTO species (slug, dex_number, name, family_slug, gen, rarity, region_slug, has_male, has_female, can_mega_evolve, can_gigantamax) VALUES ('bulbasaur', 1, 'Bulbasaur', 'bulbasaur', 1, 'standard', 'kanto', 1, 1, 0, 0)`,
  );
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '${firstProfileId}', 1, 0)`);
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '${secondProfileId}', 0, 0)`);

  const { buckets, currentProfileId } = await loadAllProfiles(conn);

  assert.equal(currentProfileId, firstProfileId);
  assert.equal(buckets.size, 2);
  assert.equal(buckets.get(firstProfileId)!.speciesPersonal.bulbasaur.registered, true);
  assert.equal(buckets.get(secondProfileId)!.speciesPersonal.bulbasaur.registered, false);
  // Each bucket's own profile identity is correct, not both pointing at the same row.
  assert.equal(buckets.get(firstProfileId)!.profile.id, firstProfileId);
  assert.equal(buckets.get(secondProfileId)!.profile.id, secondProfileId);
});
