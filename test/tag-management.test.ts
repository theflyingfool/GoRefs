import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runPersonalMigrations } from "../src/db/migrations";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { createSqliteRepository } from "../src/data/sqlite-repository";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";
import { buildRenameTagStatement, buildDeleteTagStatements, computeTagUsageCounts } from "../src/data/tag-management-sql";
import type { Tag, PokemonInstanceTag } from "../src/db/types";

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
  // inserting a row that references a form_slug this test doesn't create.
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

function insertTag(db: DatabaseSync, name: string): number {
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, ?)").run(name);
  return (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
}

function insertInstance(db: DatabaseSync): number {
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at, uuid, original_trainer_name) VALUES ('bulbasaur-standard', 1, 0, 0, 'test-uuid', 'Trainer')",
  ).run();
  return (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
}

function runStatements(db: DatabaseSync, statements: { sql: string; params: unknown[] }[]): void {
  for (const { sql, params } of statements) {
    db.prepare(sql).run(...(params as never[]));
  }
}

test("buildRenameTagStatement renames a tag via the real SQL it produces", async () => {
  const db = await seededDb();
  const id = insertTag(db, "old-name");

  const statement = buildRenameTagStatement(id, "new-name");
  db.prepare(statement.sql).run(...(statement.params as never[]));

  const row = db.prepare("SELECT name FROM tag WHERE id = ?").get(id) as { name: string };
  assert.equal(row.name, "new-name");
});

test("buildRenameTagStatement leaves other tags untouched", async () => {
  const db = await seededDb();
  const id = insertTag(db, "shiny-hunt");
  const otherId = insertTag(db, "raid");

  const statement = buildRenameTagStatement(id, "shiny-hunt-2");
  db.prepare(statement.sql).run(...(statement.params as never[]));

  const other = db.prepare("SELECT name FROM tag WHERE id = ?").get(otherId) as { name: string };
  assert.equal(other.name, "raid");
});

test("buildDeleteTagStatements removes a tag and its pokemon_instance_tag links, with foreign_keys ON", async () => {
  const db = await seededDb();
  const tagId = insertTag(db, "shiny-hunt");
  const instanceId = insertInstance(db);
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tagId);

  const statements = buildDeleteTagStatements(tagId);
  // Guard against a regression back to deleting the tag row before its
  // pokemon_instance_tag links -- pokemon_instance_tag.tag_id REFERENCES
  // tag(id) with no ON DELETE CASCADE (see src/db/migrations/0000_baseline.sql),
  // so that ordering would throw a FOREIGN KEY constraint failure once
  // foreign keys are enforced (they are, below).
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /^DELETE FROM pokemon_instance_tag WHERE tag_id = \?$/);
  assert.match(statements[1].sql, /^DELETE FROM tag WHERE id = \?$/);

  db.exec("PRAGMA foreign_keys = ON");
  assert.doesNotThrow(() => runStatements(db, statements));

  const tagRow = db.prepare("SELECT * FROM tag WHERE id = ?").get(tagId);
  assert.equal(tagRow, undefined);
  const linkRow = db.prepare("SELECT * FROM pokemon_instance_tag WHERE tag_id = ?").get(tagId);
  assert.equal(linkRow, undefined);
});

test("buildDeleteTagStatements leaves other tags and their links untouched", async () => {
  const db = await seededDb();
  const tagId = insertTag(db, "shiny-hunt");
  const keptTagId = insertTag(db, "raid");
  const instanceId = insertInstance(db);
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tagId);
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, keptTagId);

  db.exec("PRAGMA foreign_keys = ON");
  runStatements(db, buildDeleteTagStatements(tagId));

  const keptTagRow = db.prepare("SELECT * FROM tag WHERE id = ?").get(keptTagId);
  assert.ok(keptTagRow);
  const keptLinkRow = db.prepare("SELECT * FROM pokemon_instance_tag WHERE tag_id = ?").get(keptTagId);
  assert.ok(keptLinkRow);
});

test("deleting a tag's row before its pokemon_instance_tag links throws with foreign_keys ON", async () => {
  // Documents WHY buildDeleteTagStatements orders the DELETEs the way it
  // does -- pokemon_instance_tag.tag_id REFERENCES tag(id) with no ON DELETE
  // CASCADE (see src/db/migrations/0000_baseline.sql).
  const db = await seededDb();
  const tagId = insertTag(db, "shiny-hunt");
  const instanceId = insertInstance(db);
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tagId);

  db.exec("PRAGMA foreign_keys = ON");
  assert.throws(() => db.prepare("DELETE FROM tag WHERE id = ?").run(tagId), /FOREIGN KEY constraint failed/);
});

test("computeTagUsageCounts counts links per tag and sorts alphabetically by name", () => {
  const tags: Tag[] = [
    { id: 1, profileId: "1", name: "shiny-hunt" },
    { id: 2, profileId: "1", name: "raid" },
    { id: 3, profileId: "1", name: "trade" },
  ];
  const links: PokemonInstanceTag[] = [
    { pokemonInstanceId: 10, tagId: 1 },
    { pokemonInstanceId: 11, tagId: 1 },
    { pokemonInstanceId: 12, tagId: 2 },
  ];

  const result = computeTagUsageCounts(tags, links);

  assert.deepEqual(
    result.map((r) => [r.tag.name, r.count]),
    [
      ["raid", 1],
      ["shiny-hunt", 2],
      ["trade", 0],
    ],
  );
});

// Task 6: tags moved from a per-profile cache to a device-wide shared list
// (design doc §3.3) -- these two tests exercise that through the real
// createSqliteRepository, not just the SQL builders above.
test("tags are visible across profiles, not scoped to the profile that created them", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const tag = await repo.createTag("shiny-candidates");
  const second = await repo.createProfile("Second", null);
  repo.switchProfile(second.id);

  const tagsOnSecond = repo.listTags();
  assert.ok(tagsOnSecond.some((t) => t.id === tag.id), "a tag created under the first profile must be visible after switching");
});

test("creating a tag with a name that already exists (any profile) returns the existing tag, never a duplicate", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const first = await repo.createTag("shiny-candidates");
  const second = await repo.createProfile("Second", null);
  repo.switchProfile(second.id);
  const duplicate = await repo.createTag("shiny-candidates");

  assert.equal(duplicate.id, first.id, "createTag must dedupe by name against the shared list regardless of current profile");
  assert.equal(repo.listTags().filter((t) => t.name === "shiny-candidates").length, 1);
});
