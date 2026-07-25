// Thin adapter exposing just the SQLiteDBConnection surface that
// src/db/migrations.ts and src/db/reference-sync.ts actually call
// (query/execute/run/beginTransaction/commitTransaction/rollbackTransaction),
// backed by Node's built-in synchronous node:sqlite instead of the real
// @capacitor-community/sqlite plugin. Lets those two modules run unmodified
// against a throwaway fixture database in a unit test. Reuses the
// prepared-statement style already proven in scripts/build-dummy-db.ts.
//
// Not a full SQLiteDBConnection implementation — the cast below is only
// safe because the two modules under test never call anything outside this
// subset.

import type { DatabaseSync } from "node:sqlite";
import type { SQLiteDBConnection } from "../src/db/sqlite-connection";

export function nodeSqliteConnection(db: DatabaseSync): SQLiteDBConnection {
  const conn = {
    async query(statement: string, values?: unknown[]) {
      const rows = db.prepare(statement).all(...((values ?? []) as never[]));
      return { values: rows as Record<string, unknown>[] };
    },
    async run(statement: string, values?: unknown[]) {
      db.prepare(statement).run(...((values ?? []) as never[]));
      return {};
    },
    async execute(statement: string) {
      db.exec(statement);
      return {};
    },
    async beginTransaction() {
      db.exec("BEGIN");
    },
    async commitTransaction() {
      db.exec("COMMIT");
    },
    async rollbackTransaction() {
      db.exec("ROLLBACK");
    },
  };
  return conn as unknown as SQLiteDBConnection;
}
