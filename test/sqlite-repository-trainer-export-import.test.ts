import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { createSqliteRepository } from "../src/data/sqlite-repository";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";

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
