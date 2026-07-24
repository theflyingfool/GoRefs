import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runPersonalMigrations } from "../src/db/migrations";
import { nodeSqliteConnection } from "./node-sqlite-connection";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

test("updating an instance's nickname and IVs persists via raw SQL", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  // runPersonalMigrations re-enables foreign_keys at the end regardless of
  // freshDb()'s pragma (see src/db/migrations.ts) -- turn it back off before
  // inserting a row that references form_slug/profile_id tables this test
  // doesn't create.
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at) VALUES ('bulbasaur-standard', 1, 0, 0)",
  ).run();
  const id = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;

  db.prepare("UPDATE pokemon_instance SET nickname = ?, iv_attack = ?, iv_defense = ?, iv_stamina = ? WHERE id = ?").run(
    "Bulby",
    10,
    8,
    4,
    id,
  );

  const row = db.prepare("SELECT nickname, iv_percent FROM pokemon_instance WHERE id = ?").get(id) as {
    nickname: string;
    iv_percent: number;
  };
  assert.equal(row.nickname, "Bulby");
  assert.equal(row.iv_percent, 48.9);
});

test("replacing an instance's tag set adds new links and removes old ones", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'shiny-hunt')").run();
  const tag1 = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'raid')").run();
  const tag2 = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at) VALUES ('bulbasaur-standard', 1, 0, 0)",
  ).run();
  const instanceId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tag1);

  // Simulates updatePokemonInstance's tag-diff: remove links not in the new
  // set, insert links not already present.
  const newTagIds = [tag2];
  db.prepare("DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ? AND tag_id NOT IN (?)").run(instanceId, newTagIds[0]);
  db.prepare("INSERT OR IGNORE INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tag2);

  const links = db.prepare("SELECT tag_id FROM pokemon_instance_tag WHERE pokemon_instance_id = ?").all(instanceId) as {
    tag_id: number;
  }[];
  assert.deepEqual(
    links.map((l) => l.tag_id),
    [tag2],
  );
});
