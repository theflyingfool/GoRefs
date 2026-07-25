// Adapter exposing the SQLiteDBConnection surface (src/db/sqlite-connection.ts)
// that src/db/migrations.ts and src/db/reference-sync.ts call, backed by
// @tauri-apps/plugin-sql's Database class. Mirrors test/node-sqlite-connection.ts's
// role for unit tests — this is the real one, used by src/db/sqlite-client.ts.
//
// plugin-sql's Database has no begin/commit/rollback methods of its own;
// SQLite treats those as plain SQL statements, so they're sent through
// execute() same as any other DDL/DML.

import Database from "@tauri-apps/plugin-sql";
import type { SQLiteDBConnection } from "./sqlite-connection";

const DB_PATH = "sqlite:gobuddy.db";

export async function tauriSqliteConnection(): Promise<SQLiteDBConnection> {
  const db = await Database.load(DB_PATH);

  return {
    async query(statement, values) {
      const rows = await db.select<Record<string, unknown>[]>(statement, values ?? []);
      return { values: rows };
    },
    async run(statement, values) {
      const result = await db.execute(statement, values ?? []);
      return { changes: { changes: result.rowsAffected, lastId: result.lastInsertId } };
    },
    async execute(statements) {
      const result = await db.execute(statements);
      return { changes: { changes: result.rowsAffected } };
    },
    async beginTransaction() {
      await db.execute("BEGIN");
      return {};
    },
    async commitTransaction() {
      await db.execute("COMMIT");
      return {};
    },
    async rollbackTransaction() {
      await db.execute("ROLLBACK");
      return {};
    },
  };
}
