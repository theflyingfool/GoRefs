import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";

// This test exercises loadAllProfiles + the profile-scoped write builders
// together, at the level createSqliteRepository's own logic operates on —
// not through the full Tauri-connected repository (not constructible under
// node:test), but through the same functions it calls internally.
import { createSqliteRepository, loadAllProfiles } from "../src/data/sqlite-repository";
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

// Regression test for the switchProfile aliasing bug: `state` was assigned the
// boot bucket's OWN map entry (`profileBuckets.get(currentProfileId)!`), and
// reassignStateToBucket mutates `state`'s fields in place — so the first switch
// overwrote the map entry, corrupting the original profile's bucket. The fix is
// a shallow copy so `state` is a distinct container. This test exercises the
// REAL createSqliteRepository (via the node:sqlite test seam) through a full
// switch round-trip, which is the only thing that reveals the aliasing. It fails
// without the shallow-copy fix (round-trip reports the wrong profile, the
// original's data is gone, and listProfiles returns duplicates).
test("switching to another profile and back leaves the original profile's bucket and identity intact", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const original = repo.getCurrentProfile();
  // Put a concrete, checkable row on the original profile (bulbasaur exists in
  // the bundled reference data that createSqliteRepository sync'd in).
  repo.setSpeciesPersonalField("bulbasaur", "registered", true);
  assert.equal(repo.getSpeciesWithForms("bulbasaur").personal.registered, true);

  // Create + switch to a second, blank profile.
  const second = await repo.createProfile("Second", null);
  repo.switchProfile(second.id);
  assert.equal(repo.getCurrentProfile().id, second.id);
  // The second profile is genuinely blank — this also proves `state` now points
  // at the second bucket's data, not a shared/aliased object.
  assert.equal(repo.getSpeciesWithForms("bulbasaur").personal.registered, false);

  // Switch back to the original. Without the fix, `profileBuckets.get(original)`
  // had been corrupted to the second profile's data on the first switch.
  repo.switchProfile(original.id);
  assert.equal(repo.getCurrentProfile().id, original.id, "round-trip must restore the original profile's identity");
  assert.equal(
    repo.getSpeciesWithForms("bulbasaur").personal.registered,
    true,
    "the original profile's data must survive a switch round-trip",
  );

  // listProfiles must report both profiles as distinct identities, not two
  // entries that collapsed onto the same (corrupted) bucket.
  const profiles = repo.listProfiles();
  assert.equal(profiles.length, 2);
  const ids = profiles.map((p) => p.id);
  assert.equal(new Set(ids).size, 2, "listProfiles must report two DISTINCT profiles");
  assert.ok(ids.includes(original.id));
  assert.ok(ids.includes(second.id));
});

// Exercises deleteProfile of the CURRENTLY-active profile through the real repo:
// the auto-switch (reassignStateToBucket(survivor)) followed by
// profileBuckets.delete(target). Under the aliasing bug `state` WAS the target's
// map entry, so this path was doubly fragile; under the fix `state` is distinct,
// so the delete removes the actual intended bucket and `state` cleanly repoints
// at the survivor's live data.
test("deleting the current profile auto-switches to the survivor with its data intact and leaves exactly one current", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const original = repo.getCurrentProfile();
  const survivor = await repo.createProfile("Survivor", null);
  // Put a checkable row on the survivor so we can prove state repoints at ITS data.
  repo.switchProfile(survivor.id);
  repo.setSpeciesPersonalField("bulbasaur", "registered", true);
  repo.switchProfile(original.id);

  // Delete the current (original) profile.
  await repo.deleteProfile(original.id);

  // state auto-switched to the survivor, showing the survivor's real data.
  assert.equal(repo.getCurrentProfile().id, survivor.id);
  assert.equal(repo.getSpeciesWithForms("bulbasaur").personal.registered, true);

  // The deleted profile is gone from the in-memory map and the DB.
  const listed = repo.listProfiles();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, survivor.id);
  const dbProfiles = db.prepare("SELECT id, is_current FROM profile").all() as { id: string; is_current: number }[];
  assert.equal(dbProfiles.length, 1);
  assert.equal(dbProfiles[0].id, survivor.id);
  // Exactly one profile is current in the DB, and it's the survivor.
  const current = db.prepare("SELECT COUNT(*) as c FROM profile WHERE is_current = 1").get() as { c: number };
  assert.equal(current.c, 1);
  assert.equal((db.prepare("SELECT id FROM profile WHERE is_current = 1").get() as { id: string }).id, survivor.id);
});

// Regression test for the playerProgress in-memory-coherence gap: playerProgress
// is a single value REASSIGNED wholesale on `state` (not mutated in place like
// the collections), so after the shallow-copy of `state`, the profile's bucket
// in profileBuckets kept a stale playerProgress unless onPlayerProgressChanged
// wrote the new value back. Symptom: edit level on A, switch to B, switch back
// to A -> the in-memory Stats display silently reverts to A's pre-edit value
// (the DB is correct; this is display staleness). Fails without the write-back.
test("player progress set on a profile survives a switch away and back", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const original = repo.getCurrentProfile();
  repo.setPlayerProgress(42, 123456);
  assert.equal(repo.getPlayerProgress()?.currentLevel, 42);
  assert.equal(repo.getPlayerProgress()?.totalXp, 123456);

  const second = await repo.createProfile("Second", null);
  repo.switchProfile(second.id);
  assert.equal(repo.getPlayerProgress(), undefined); // freshly-created profile is blank

  repo.switchProfile(original.id);
  assert.equal(repo.getPlayerProgress()?.currentLevel, 42, "player level set on A must survive a switch round-trip");
  assert.equal(repo.getPlayerProgress()?.totalXp, 123456, "player XP set on A must survive a switch round-trip");
});

test("createProfile and renameProfile keep referenced_trainer mirrored", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const created = await repo.createProfile("Misty", "111122223333");
  let row = db.prepare("SELECT name, friend_code FROM referenced_trainer WHERE uuid = ?").get(created.id) as { name: string; friend_code: string | null };
  assert.equal(row.name, "Misty");
  assert.equal(row.friend_code, "111122223333");

  await repo.renameProfile(created.id, "Misty Waterflower", null);
  row = db.prepare("SELECT name, friend_code FROM referenced_trainer WHERE uuid = ?").get(created.id) as { name: string; friend_code: string | null };
  assert.equal(row.name, "Misty Waterflower");
  assert.equal(row.friend_code, null);
});

test("createProfile promotes a matching referenced_trainer placeholder instead of minting a new uuid", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const placeholderUuid = "22222222-2222-2222-2222-222222222222";
  db.exec(`INSERT INTO referenced_trainer (uuid, name, friend_code) VALUES ('${placeholderUuid}', 'Steve', NULL)`);

  const created = await repo.createProfile("Steve", null);
  assert.equal(created.id, placeholderUuid, "must reuse the placeholder's uuid, not mint a new one");

  const profiles = repo.listProfiles();
  assert.ok(profiles.some((p) => p.id === placeholderUuid));
});

test("createProfile mints a fresh uuid when the name matches an existing REAL profile", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const first = await repo.createProfile("Ash", null);
  const second = await repo.createProfile("Ash", null);
  assert.notEqual(first.id, second.id, "two real profiles sharing a name must stay distinct identities");
});
