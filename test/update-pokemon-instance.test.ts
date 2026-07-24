import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runPersonalMigrations } from "../src/db/migrations";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { buildScalarUpdateStatement, buildTagDiffStatements } from "../src/data/pokemon-instance-update-sql";

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
