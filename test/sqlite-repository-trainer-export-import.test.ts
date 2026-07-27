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

  // Regression (final whole-branch review, Finding 1): the merge must also
  // apply the "incoming uuid always wins" rule to the NAME, not just the id,
  // so profile.username and the mirrored referenced_trainer.name for the
  // same uuid agree afterward -- before this fix, profile.username stayed
  // "Ash Ketchum" (B's own old local name) while the end-of-loop
  // referenced_trainer upsert overwrote that uuid's row to "Ash" (A's
  // incoming name), leaving the two tables disagreeing about the same
  // trainer.
  const mergedProfile = repoB.getCurrentProfile();
  assert.equal(mergedProfile.username, "Ash", "the incoming (A's) name must win on merge, not B's old local name");
  const referencedRow = dbB.prepare("SELECT name, friend_code FROM referenced_trainer WHERE uuid = ?").get(mergedProfile.id) as
    | { name: string; friend_code: string | null }
    | undefined;
  assert.ok(referencedRow, "the merged uuid must have a referenced_trainer row");
  assert.equal(referencedRow!.name, "Ash", "referenced_trainer.name must also be the incoming name");
  assert.equal(referencedRow!.name, mergedProfile.username, "profile.username and referenced_trainer.name must agree for the same uuid");
});

test("applyTrainerImport: a multi-trainer bundle can promote a matching placeholder AND create a brand-new trainer in the same call", async () => {
  const dbA = new DatabaseSync(":memory:");
  dbA.exec("PRAGMA foreign_keys = ON;");
  dbA.exec(REFERENCE_SCHEMA_SQL);
  const repoA = await createSqliteRepository(undefined, nodeSqliteConnection(dbA));
  const misty = await repoA.createProfile("Misty", null);
  repoA.switchProfile(misty.id);
  repoA.setSpeciesPersonalField("psyduck", "registered", true);
  const brock = await repoA.createProfile("Brock", null);
  repoA.switchProfile(brock.id);
  repoA.setSpeciesPersonalField("geodude", "registered", true);

  const dbB = new DatabaseSync(":memory:");
  dbB.exec("PRAGMA foreign_keys = ON;");
  dbB.exec(REFERENCE_SCHEMA_SQL);
  const repoB = await createSqliteRepository(undefined, nodeSqliteConnection(dbB));
  // Give repoB a placeholder identity named "Misty" -- a referenced_trainer
  // row with no matching real profile -- via the same
  // updatePokemonInstance(originalTrainerName) path a real user hits when
  // logging a trade partner's name before that trainer has ever been
  // exported/imported. No real profile named "Brock" exists on repoB, so
  // that trainer has no local identity at all.
  const [instance] = await repoB.createPokemonInstances({ formSlug: "bulbasaur-standard-male", count: 1 });
  await repoB.updatePokemonInstance(instance.id, { originalTrainerName: "Misty" });

  const bundleFromA = buildExportBundle(repoA, [misty.id, brock.id]);
  const plan = await repoB.planTrainerImport(bundleFromA);
  const mistyEntry = plan.entries.find((e) => e.trainerName === "Misty")!;
  const brockEntry = plan.entries.find((e) => e.trainerName === "Brock")!;
  assert.equal(mistyEntry.decision.kind, "promote", "Misty must resolve against repoB's existing placeholder");
  assert.equal(brockEntry.decision.kind, "new", "Brock has no local identity at all on repoB");

  const summary = await repoB.applyTrainerImport(bundleFromA, {});
  assert.equal(summary.promoted, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.merged, 0);
  assert.equal(summary.separate, 0);

  // Both trainers' data must have actually landed: promoted Misty keeps her
  // OWN bucket (the placeholder uuid rewritten to Misty's real uuid from A),
  // and Brock's data lives in a freshly created profile of his own.
  const profiles = repoB.listProfiles();
  const promotedMisty = profiles.find((p) => p.username === "Misty");
  const createdBrock = profiles.find((p) => p.username === "Brock");
  assert.ok(promotedMisty, "the promoted Misty must now be a real profile on repoB");
  assert.ok(createdBrock, "Brock must now be a real profile on repoB");
  assert.equal(promotedMisty!.id, misty.id, "promotion must adopt the INCOMING uuid, not mint a fresh one");

  repoB.switchProfile(promotedMisty!.id);
  assert.equal(repoB.getSpeciesWithForms("psyduck").personal.registered, true, "Misty's imported data must have landed on her promoted profile");
  repoB.switchProfile(createdBrock!.id);
  assert.equal(repoB.getSpeciesWithForms("geodude").personal.registered, true, "Brock's imported data must have landed on his newly created profile");
});

test("applyTrainerImport: a mid-loop auto-merge that rewrites the CURRENT profile's own uuid still leaves the current profile pointed at the right (new) uuid afterward", async () => {
  const dbA = new DatabaseSync(":memory:");
  dbA.exec("PRAGMA foreign_keys = ON;");
  dbA.exec(REFERENCE_SCHEMA_SQL);
  const repoA = await createSqliteRepository(undefined, nodeSqliteConnection(dbA));
  const gary = repoA.getCurrentProfile();
  await repoA.renameProfile(gary.id, "Gary", "111100002222");
  repoA.setSpeciesPersonalField("pikachu", "registered", true);
  const twoOnA = await repoA.createProfile("TwoOnA", "555566667777");
  repoA.switchProfile(twoOnA.id);
  repoA.setSpeciesPersonalField("eevee", "registered", true);
  const erika = await repoA.createProfile("Erika", "333344445555");
  repoA.switchProfile(erika.id);
  repoA.setSpeciesPersonalField("oddish", "registered", true);

  const dbB = new DatabaseSync(":memory:");
  dbB.exec("PRAGMA foreign_keys = ON;");
  dbB.exec(REFERENCE_SCHEMA_SQL);
  const repoB = await createSqliteRepository(undefined, nodeSqliteConnection(dbB));
  const originalCurrentId = repoB.getCurrentProfile().id;
  // repoB's CURRENT profile shares a friend code with A's SECOND exported
  // trainer (deliberately not the first or last in the bundle) -- this is
  // the exact "mid-loop self-rewrite" case: reconcileTrainer resolves it to
  // auto-merge, and applyTrainerImport's merge branch rewrites repoB's own
  // current profile uuid to the incoming uuid mid-loop, then keeps
  // processing a THIRD, unrelated trainer afterward.
  await repoB.renameProfile(originalCurrentId, "Two", "555566667777");
  repoB.setSpeciesPersonalField("squirtle", "registered", true);

  const bundleFromA = buildExportBundle(repoA, [gary.id, twoOnA.id, erika.id]);
  // Sanity-check the ordering assumption the scenario depends on.
  assert.equal(bundleFromA.trainers[0].trainerName, "Gary");
  assert.equal(bundleFromA.trainers[1].trainerName, "TwoOnA");
  assert.equal(bundleFromA.trainers[2].trainerName, "Erika");

  const plan = await repoB.planTrainerImport(bundleFromA);
  assert.equal(plan.entries[0].decision.kind, "new");
  assert.deepEqual(plan.entries[1].decision, { kind: "auto-merge", localProfileId: originalCurrentId });
  assert.equal(plan.entries[2].decision.kind, "new");

  const summary = await repoB.applyTrainerImport(bundleFromA, {});
  assert.equal(summary.merged, 1);
  assert.equal(summary.created, 2);

  // The crux of the finding: current must end up on the INCOMING uuid from
  // trainer #2 (TwoOnA), not the OLD local uuid, and not Gary's or Erika's
  // freshly created profiles -- even though they were processed after the
  // self-rewrite happened.
  const current = repoB.getCurrentProfile();
  assert.equal(current.id, twoOnA.id, "current profile must be re-keyed to the incoming uuid");
  assert.notEqual(current.id, originalCurrentId);

  assert.equal(repoB.getSpeciesWithForms("squirtle").personal.registered, true, "the current profile's own pre-existing data must survive the uuid rewrite");
  assert.equal(repoB.getSpeciesWithForms("eevee").personal.registered, true, "the merged-in trainer's data must land on the (same, now-current) profile");

  const profiles = repoB.listProfiles();
  const garyLocal = profiles.find((p) => p.username === "Gary")!;
  const erikaLocal = profiles.find((p) => p.username === "Erika")!;
  repoB.switchProfile(garyLocal.id);
  assert.equal(repoB.getSpeciesWithForms("pikachu").personal.registered, true);
  repoB.switchProfile(erikaLocal.id);
  assert.equal(repoB.getSpeciesWithForms("oddish").personal.registered, true);
  repoB.switchProfile(current.id);
});

test("applyTrainerImport: an ask-merge-or-separate decision resolved as \"separate\" creates a genuinely new, independent profile (not merged into the same-named one)", async () => {
  const dbA = new DatabaseSync(":memory:");
  dbA.exec("PRAGMA foreign_keys = ON;");
  dbA.exec(REFERENCE_SCHEMA_SQL);
  const repoA = await createSqliteRepository(undefined, nodeSqliteConnection(dbA));
  await repoA.renameProfile(repoA.getCurrentProfile().id, "Duplicate", null);
  repoA.setSpeciesPersonalField("squirtle", "registered", true);

  const dbB = new DatabaseSync(":memory:");
  dbB.exec("PRAGMA foreign_keys = ON;");
  dbB.exec(REFERENCE_SCHEMA_SQL);
  const repoB = await createSqliteRepository(undefined, nodeSqliteConnection(dbB));
  const existingDuplicate = await repoB.createProfile("Duplicate", null);
  repoB.switchProfile(existingDuplicate.id);
  repoB.setSpeciesPersonalField("charmander", "registered", true);
  repoB.switchProfile(repoB.listProfiles().find((p) => p.id !== existingDuplicate.id)!.id);

  const bundleFromA = buildExportBundle(repoA, [repoA.getCurrentProfile().id]);
  const incomingTrainerUuid = bundleFromA.trainers[0].trainerUuid;

  const plan = await repoB.planTrainerImport(bundleFromA);
  assert.deepEqual(plan.entries[0].decision, { kind: "ask-merge-or-separate", localProfileId: existingDuplicate.id });

  const summary = await repoB.applyTrainerImport(bundleFromA, { [incomingTrainerUuid]: "separate" });
  assert.equal(summary.separate, 1);
  assert.equal(summary.merged, 0);
  assert.equal(summary.promoted, 0);
  assert.equal(summary.created, 0);

  const duplicateNamedProfiles = repoB.listProfiles().filter((p) => p.username === "Duplicate");
  assert.equal(duplicateNamedProfiles.length, 2, "a genuinely separate second 'Duplicate' profile must exist, not a merge into the first");
  const newSeparateProfile = duplicateNamedProfiles.find((p) => p.id !== existingDuplicate.id)!;
  assert.ok(newSeparateProfile, "the new profile must have its own uuid, distinct from the existing same-named one");
  assert.notEqual(newSeparateProfile.id, incomingTrainerUuid, "createProfile must mint a genuinely fresh uuid, not adopt A's uuid, when kept separate");

  repoB.switchProfile(existingDuplicate.id);
  assert.equal(repoB.getSpeciesWithForms("charmander").personal.registered, true, "the pre-existing 'Duplicate' profile's own data must be untouched");
  repoB.switchProfile(newSeparateProfile.id);
  assert.equal(repoB.getSpeciesWithForms("squirtle").personal.registered, true, "the new separate profile must carry A's imported data");
});

test("importing the same bundle twice does not duplicate specimens, and tag links survive both passes", async () => {
  const dbA = new DatabaseSync(":memory:");
  dbA.exec("PRAGMA foreign_keys = ON;");
  dbA.exec(REFERENCE_SCHEMA_SQL);
  const repoA = await createSqliteRepository(undefined, nodeSqliteConnection(dbA));
  await repoA.renameProfile(repoA.getCurrentProfile().id, "Ash", "111122223333");
  const [instance] = await repoA.createPokemonInstances({ formSlug: "bulbasaur-standard-male", count: 1 });
  const tag = await repoA.createTag("starters");
  await repoA.updatePokemonInstance(instance.id, { tagIds: [tag.id] });

  const dbB = new DatabaseSync(":memory:");
  dbB.exec("PRAGMA foreign_keys = ON;");
  dbB.exec(REFERENCE_SCHEMA_SQL);
  const repoB = await createSqliteRepository(undefined, nodeSqliteConnection(dbB));
  await repoB.renameProfile(repoB.getCurrentProfile().id, "Ash Ketchum", "111122223333");

  const bundle = buildExportBundle(repoA, [repoA.getCurrentProfile().id]);
  await repoB.applyTrainerImport(bundle, {});
  await repoB.applyTrainerImport(bundle, {}); // import the SAME bundle again

  const rows = repoB.listPokemonInstances({ status: "all" });
  assert.equal(rows.length, 1, "importing the same bundle twice must not duplicate the specimen");
  assert.equal(rows[0].tags.length, 1, "tag links must survive both import passes");
  assert.equal(rows[0].tags[0].name, "starters");
});

test("re-importing a trainer whose uuid ALREADY matches locally (no id rewrite needed) still applies the incoming name on a rename", async () => {
  // Covers the auto-merge sub-case where reconcileTrainer's uuidMatch path
  // fires (localProfileId already equals trainer.trainerUuid, so
  // applyTrainerImport's merge branch skips buildRewriteTrainerUuidStatements
  // entirely) -- this is the OTHER place the "incoming name wins" fix had to
  // land, distinct from the friend-code-match case covered above.
  const dbA = new DatabaseSync(":memory:");
  dbA.exec("PRAGMA foreign_keys = ON;");
  dbA.exec(REFERENCE_SCHEMA_SQL);
  const repoA = await createSqliteRepository(undefined, nodeSqliteConnection(dbA));
  await repoA.renameProfile(repoA.getCurrentProfile().id, "Ash", "111122223333");

  const dbB = new DatabaseSync(":memory:");
  dbB.exec("PRAGMA foreign_keys = ON;");
  dbB.exec(REFERENCE_SCHEMA_SQL);
  const repoB = await createSqliteRepository(undefined, nodeSqliteConnection(dbB));
  await repoB.renameProfile(repoB.getCurrentProfile().id, "Ash Ketchum", "111122223333");

  // First import: friend-code match, different uuid -- rewrites repoB's local
  // profile id to repoA's uuid (the if-branch).
  await repoB.applyTrainerImport(buildExportBundle(repoA, [repoA.getCurrentProfile().id]), {});
  assert.equal(repoB.getCurrentProfile().id, repoA.getCurrentProfile().id);

  // repoA renames itself, then repoB re-imports. This second import's
  // trainerUuid already equals repoB's local profile id (the uuidMatch
  // auto-merge path, no rewrite needed) -- the else-branch this test targets.
  await repoA.renameProfile(repoA.getCurrentProfile().id, "Ash Ketchum Sr.", "111122223333");
  await repoB.applyTrainerImport(buildExportBundle(repoA, [repoA.getCurrentProfile().id]), {});

  const mergedProfile = repoB.getCurrentProfile();
  assert.equal(mergedProfile.username, "Ash Ketchum Sr.", "the incoming name must win even when no uuid rewrite was needed");
  const referencedRow = dbB.prepare("SELECT name FROM referenced_trainer WHERE uuid = ?").get(mergedProfile.id) as { name: string } | undefined;
  assert.equal(referencedRow?.name, "Ash Ketchum Sr.", "referenced_trainer.name must agree with profile.username here too");
});

test("listSpeciesSummariesForProfile reads a non-current profile's data without switching to it", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const original = repo.getCurrentProfile();
  const second = await repo.createProfile("Second", null);
  repo.switchProfile(second.id);
  repo.setSpeciesPersonalField("bulbasaur", "registered", true);
  repo.switchProfile(original.id);

  const summaries = repo.listSpeciesSummariesForProfile(second.id, { search: "bulbasaur" });
  const bulbasaur = summaries.find((s) => s.species.slug === "bulbasaur");
  assert.equal(bulbasaur?.caught, true, "must reflect the SECOND profile's data");
  assert.equal(repo.getCurrentProfile().id, original.id, "must not switch the current profile");
});

test("listSpeciesSummariesForProfile throws for an unknown profileId", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);
  assert.throws(() => repo.listSpeciesSummariesForProfile("not-a-real-id"), /Unknown profile/);
});
