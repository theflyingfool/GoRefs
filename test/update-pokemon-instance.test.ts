import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runPersonalMigrations } from "../src/db/migrations";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { buildScalarUpdateStatement, buildTagDiffStatements, mergeUpdatedInstance } from "../src/data/pokemon-instance-update-sql";
import { computeIvPercent } from "../src/db/types";
import type { PokemonInstance } from "../src/db/types";
import { createSqliteRepository } from "../src/data/sqlite-repository";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

async function seededDb(): Promise<DatabaseSync> {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  // runPersonalMigrations re-enables foreign_keys at the end regardless of
  // freshDb()'s pragma (see src/db/migrations.ts) -- turn it back off before
  // inserting a row that references form_slug/profile_id tables this test
  // doesn't create.
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

function insertInstance(db: DatabaseSync): number {
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at) VALUES ('bulbasaur-standard', 1, 0, 0)",
  ).run();
  return (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
}

function runStatements(db: DatabaseSync, statements: { sql: string; params: unknown[] }[]): void {
  for (const { sql, params } of statements) {
    db.prepare(sql).run(...(params as never[]));
  }
}

test("buildScalarUpdateStatement writes nickname and IVs via the real SQL it produces", async () => {
  const db = await seededDb();
  const id = insertInstance(db);

  const statement = buildScalarUpdateStatement(id, { nickname: "Bulby", ivAttack: 10, ivDefense: 8, ivStamina: 4 }, 12345);
  assert.ok(statement);
  db.prepare(statement.sql).run(...(statement.params as never[]));

  const row = db.prepare("SELECT nickname, iv_percent, updated_at FROM pokemon_instance WHERE id = ?").get(id) as {
    nickname: string;
    iv_percent: number;
    updated_at: number;
  };
  assert.equal(row.nickname, "Bulby");
  assert.equal(row.iv_percent, 48.9);
  assert.equal(row.updated_at, 12345);
});

test("buildScalarUpdateStatement returns null for a tags-only edit (no UPDATE issued)", () => {
  const statement = buildScalarUpdateStatement(1, { tagIds: [1, 2] }, 12345);
  assert.equal(statement, null);
});

test("buildTagDiffStatements clears all tags when tagIds is empty, without a NOT IN (NULL) no-op", async () => {
  const db = await seededDb();
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'shiny-hunt')").run();
  const tag1 = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  const instanceId = insertInstance(db);
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tag1);

  const statements = buildTagDiffStatements(instanceId, []);
  // Guard against a regression back to the old single-branch
  // `NOT IN (?)` form, which becomes `NOT IN (NULL)` for an empty array and
  // silently matches zero rows.
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /^DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = \?$/);
  runStatements(db, statements);

  const links = db.prepare("SELECT tag_id FROM pokemon_instance_tag WHERE pokemon_instance_id = ?").all(instanceId);
  assert.deepEqual(links, []);
});

function fixtureInstance(overrides: Partial<PokemonInstance> = {}): PokemonInstance {
  return {
    id: 1,
    formSlug: "bulbasaur-standard",
    profileId: "1",
    status: "kept",
    recordedAt: 0,
    caughtAt: null,
    updatedAt: 0,
    cp: null,
    ivAttack: 10,
    ivDefense: 10,
    ivStamina: 10,
    ivPercent: computeIvPercent(10, 10, 10),
    shiny: false,
    lucky: false,
    shadow: false,
    purified: false,
    dynamax: false,
    receivedViaTrade: false,
    heartsEarned: null,
    currentMegaLevel: null,
    nickname: null,
    backgroundSlug: null,
    uuid: "11111111-1111-1111-1111-111111111111",
    originalTrainerName: "Trainer",
    originalTrainerId: "1",
    ...overrides,
  };
}

test("mergeUpdatedInstance recomputes ivPercent from the MERGED IVs when only one component changes, matching the real generated column", async () => {
  // Seed a real row with the same starting IVs as the in-memory fixture,
  // and apply the exact SQL updatePokemonInstance would run for an edit
  // that only changes ivDefense -- proving the fix against the real
  // GENERATED column, not just computeIvPercent's own formula.
  const db = await seededDb();
  const id = insertInstance(db);
  db.prepare("UPDATE pokemon_instance SET iv_attack = 10, iv_defense = 10, iv_stamina = 10 WHERE id = ?").run(id);

  const fields = { ivDefense: 15 };
  const statement = buildScalarUpdateStatement(id, fields, 99999);
  assert.ok(statement);
  db.prepare(statement.sql).run(...(statement.params as never[]));

  const row = db.prepare("SELECT iv_percent FROM pokemon_instance WHERE id = ?").get(id) as { iv_percent: number };

  const existing = fixtureInstance({ id, ivAttack: 10, ivDefense: 10, ivStamina: 10 });
  const merged = mergeUpdatedInstance(existing, fields, 99999);

  // The bug this guards against: before the fix, ivPercent would have been
  // left at computeIvPercent(10, 10, 10) (the stale pre-edit value) instead
  // of being recomputed from the merged ivDefense: 15.
  assert.equal(merged.ivPercent, computeIvPercent(10, 15, 10));
  assert.notEqual(merged.ivPercent, computeIvPercent(10, 10, 10));
  assert.equal(merged.ivAttack, 10);
  assert.equal(merged.ivDefense, 15);
  assert.equal(merged.ivStamina, 10);
  // And it must match what SQLite's real GENERATED column computed on disk.
  assert.equal(merged.ivPercent, row.iv_percent);
});

test("mergeUpdatedInstance leaves ivPercent unchanged when the edit doesn't touch any IV field", () => {
  const existing = fixtureInstance({ nickname: "Bulby", ivAttack: 10, ivDefense: 10, ivStamina: 10 });
  const merged = mergeUpdatedInstance(existing, { nickname: "Bulbers" }, 12345);
  assert.equal(merged.nickname, "Bulbers");
  assert.equal(merged.ivPercent, computeIvPercent(10, 10, 10));
});

test("buildTagDiffStatements replaces a non-empty tag set: removes, adds, and keeps as appropriate", async () => {
  const db = await seededDb();
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'shiny-hunt')").run();
  const tagRemoved = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'raid')").run();
  const tagKept = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'trade')").run();
  const tagAdded = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;

  const instanceId = insertInstance(db);
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tagRemoved);
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tagKept);

  const statements = buildTagDiffStatements(instanceId, [tagKept, tagAdded]);
  runStatements(db, statements);

  const links = db
    .prepare("SELECT tag_id FROM pokemon_instance_tag WHERE pokemon_instance_id = ? ORDER BY tag_id")
    .all(instanceId) as { tag_id: number }[];
  assert.deepEqual(
    links.map((l) => l.tag_id).sort((a, b) => a - b),
    [tagKept, tagAdded].sort((a, b) => a - b),
  );
});

// Exercises the REAL updatePokemonInstance/createPokemonInstances through the
// full repository (test seam described on createSqliteRepository) since the
// resolve-or-create step against referenced_trainer lives in
// sqlite-repository.ts, not in the pure SQL builders this file otherwise
// tests directly.
test("updatePokemonInstance resolves originalTrainerName against referenced_trainer, creating a placeholder if new", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  // createSqliteRepository syncs the app's real bundled reference data
  // (src/data/reference.json) into the DB at boot -- any species/form rows
  // manually inserted beforehand get deleted by that sync since they aren't
  // part of the bundle, so use a real form slug rather than fixture data.
  const repo = await createSqliteRepository(undefined, conn);

  const [firstInstance] = await repo.createPokemonInstances({ formSlug: "bulbasaur-standard-male", count: 1 });
  const instanceId = firstInstance.id;

  await repo.updatePokemonInstance(instanceId, { originalTrainerName: "Gary" });
  const row = db.prepare("SELECT original_trainer_name, original_trainer_id FROM pokemon_instance WHERE id = ?").get(instanceId) as {
    original_trainer_name: string;
    original_trainer_id: string;
  };
  assert.equal(row.original_trainer_name, "Gary");
  const referenced = db.prepare("SELECT name FROM referenced_trainer WHERE uuid = ?").get(row.original_trainer_id) as { name: string } | undefined;
  assert.equal(referenced?.name, "Gary");

  // Second specimen naming the SAME trainer must resolve to the SAME uuid, not a new placeholder.
  const secondBatch = await repo.createPokemonInstances({ formSlug: "bulbasaur-standard-male", count: 1 });
  await repo.updatePokemonInstance(secondBatch[0].id, { originalTrainerName: "Gary" });
  const secondRow = db.prepare("SELECT original_trainer_id FROM pokemon_instance WHERE id = ?").get(secondBatch[0].id) as { original_trainer_id: string };
  assert.equal(secondRow.original_trainer_id, row.original_trainer_id);
});
