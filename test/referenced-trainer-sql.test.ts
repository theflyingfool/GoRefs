import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { runPersonalMigrations } from "../src/db/migrations";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";
import { buildReferencedTrainerUpsert, findReferencedTrainerByUuid, findReferencedTrainerByName } from "../src/data/referenced-trainer-sql";

test("buildReferencedTrainerUpsert inserts then updates on the same uuid", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  const uuid = "11111111-1111-1111-1111-111111111111";
  const insert = buildReferencedTrainerUpsert({ uuid, name: "Ash", friendCode: null });
  db.prepare(insert.sql).run(...(insert.params as never[]));
  let found = await findReferencedTrainerByUuid(conn, uuid);
  assert.equal(found?.name, "Ash");

  const update = buildReferencedTrainerUpsert({ uuid, name: "Ash Ketchum", friendCode: "123456789012" });
  db.prepare(update.sql).run(...(update.params as never[]));
  found = await findReferencedTrainerByUuid(conn, uuid);
  assert.equal(found?.name, "Ash Ketchum");
  assert.equal(found?.friendCode, "123456789012");

  const byName = await findReferencedTrainerByName(conn, "Ash Ketchum");
  assert.equal(byName?.uuid, uuid);
});
