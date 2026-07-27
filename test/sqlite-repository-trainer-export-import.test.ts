import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { createSqliteRepository } from "../src/data/sqlite-repository";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";
import { buildRewriteTrainerUuidStatements } from "../src/data/trainer-reconciliation";
import { buildExportBundle } from "../src/features/settings/personal-data-transfer";

test("exportTrainer exports a non-current profile's data without switching to it", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const original = repo.getCurrentProfile();
  const second = await repo.createProfile("Second", "999988887777");
  repo.switchProfile(second.id);
  repo.setSpeciesPersonalField("bulbasaur", "registered", true);
  repo.switchProfile(original.id);

  // Exporting "second" while "original" is current must reflect second's own data.
  const exported = repo.exportTrainer(second.id);
  assert.equal(exported.trainerUuid, second.id);
  assert.equal(exported.trainerName, "Second");
  assert.equal(exported.trainerFriendCode, "999988887777");
  assert.equal(exported.speciesPersonal.bulbasaur?.registered, true);
  assert.equal(repo.getCurrentProfile().id, original.id, "exporting must not switch the current profile");
});

test("buildRewriteTrainerUuidStatements sweeps profile_id, original_trainer_id, and the referenced_trainer row itself", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const original = repo.getCurrentProfile();
  const newUuid = "88888888-8888-8888-8888-888888888888";
  // oldUuid is a real local profile being merged away -- created via
  // repo.createProfile (not the boot-time default profile) so it carries the
  // mirrored referenced_trainer row every real profile has, which the
  // rewrite's INSERT-from-subselect statement reads from.
  const oldUuid = (await repo.createProfile("ToMerge", null)).id;
  // A different profile's (the original boot profile's) specimen names
  // oldUuid as its original trainer.
  // createSqliteRepository seeds the real reference dataset (syncReferenceData),
  // which has no "bulbasaur-base" slug -- use a real form slug that exists in
  // src/data/reference.json instead (form_slug carries a REFERENCES form(slug)
  // constraint with foreign_keys ON).
  const [instance] = await repo.createPokemonInstances({ formSlug: "bulbasaur-standard-male", count: 1 });
  db.exec(`UPDATE pokemon_instance SET original_trainer_id = '${oldUuid}' WHERE id = ${instance.id}`);
  repo.switchProfile(original.id);

  // defer_foreign_keys only defers checks to the end of the OUTERMOST
  // transaction (see buildRewriteTrainerUuidStatements's doc comment on the
  // convention this matches) -- without an explicit BEGIN/COMMIT, each
  // statement below is its own implicit transaction and the deferred FK on
  // profile_id would still fail immediately when a row is repointed at
  // newUuid before the `profile` row itself is renamed to newUuid.
  db.exec("BEGIN;");
  db.exec("PRAGMA defer_foreign_keys = true;");
  for (const { sql, params } of buildRewriteTrainerUuidStatements(oldUuid, newUuid)) {
    db.prepare(sql).run(...(params as never[]));
  }
  db.exec("COMMIT;");

  const profileRow = db.prepare("SELECT id FROM profile WHERE id = ?").get(newUuid) as { id: string } | undefined;
  assert.ok(profileRow, "profile.id must be rewritten to the incoming uuid");
  const originalTrainerRow = db.prepare("SELECT original_trainer_id FROM pokemon_instance WHERE id = ?").get(instance.id) as { original_trainer_id: string };
  assert.equal(originalTrainerRow.original_trainer_id, newUuid, "a DIFFERENT profile's specimen referencing the old uuid must be swept too");
  const instanceOwnerRow = db.prepare("SELECT profile_id FROM pokemon_instance WHERE id = ?").get(instance.id) as { profile_id: string };
  assert.equal(instanceOwnerRow.profile_id, original.id, "the specimen's own profile_id is untouched -- proves this instance was swept via original_trainer_id, not profile_id, i.e. it really does belong to a DIFFERENT profile than oldUuid");
  const oldReferenced = db.prepare("SELECT uuid FROM referenced_trainer WHERE uuid = ?").get(oldUuid) as { uuid: string } | undefined;
  assert.equal(oldReferenced, undefined, "the old uuid's referenced_trainer row must be gone");
  const newReferenced = db.prepare("SELECT uuid FROM referenced_trainer WHERE uuid = ?").get(newUuid) as { uuid: string } | undefined;
  assert.ok(newReferenced, "the new uuid must have a referenced_trainer row");
});

test("planTrainerImport + applyTrainerImport merges two devices' data for the same trainer via matching friend codes", async () => {
  const dbA = new DatabaseSync(":memory:");
  dbA.exec("PRAGMA foreign_keys = ON;");
  dbA.exec(REFERENCE_SCHEMA_SQL);
  const repoA = await createSqliteRepository(undefined, nodeSqliteConnection(dbA));
  await repoA.renameProfile(repoA.getCurrentProfile().id, "Ash", "111122223333");
  repoA.setSpeciesPersonalField("bulbasaur", "registered", true);

  const dbB = new DatabaseSync(":memory:");
  dbB.exec("PRAGMA foreign_keys = ON;");
  dbB.exec(REFERENCE_SCHEMA_SQL);
  const repoB = await createSqliteRepository(undefined, nodeSqliteConnection(dbB));
  await repoB.renameProfile(repoB.getCurrentProfile().id, "Ash Ketchum", "111122223333");
  repoB.setSpeciesPersonalField("charmander", "registered", true);

  const bundleFromA = buildExportBundle(repoA, [repoA.getCurrentProfile().id]);
  const plan = await repoB.planTrainerImport(bundleFromA);
  assert.equal(plan.entries[0].decision.kind, "auto-merge");

  const summary = await repoB.applyTrainerImport(bundleFromA, {});
  assert.equal(summary.merged, 1);
  assert.equal(repoB.getSpeciesWithForms("bulbasaur").personal.registered, true, "B must gain A's data");
  assert.equal(repoB.getSpeciesWithForms("charmander").personal.registered, true, "B must keep its own data");
});
