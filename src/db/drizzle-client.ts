// Wraps a given SQLiteDBConnection (see sqlite-client.ts for how the real
// app obtains one — same connection object, no change to the native/web
// platform split) in Drizzle's sqlite-proxy driver, so Drizzle's query
// builder and migrator can run against it.
//
// Takes the connection as a parameter rather than fetching sqlite-client.ts's
// own singleton internally, for two reasons: (1) it lets tests inject a
// fixture SQLiteDBConnection (e.g. test/node-sqlite-connection.ts) without
// ever touching sqlite-client.ts, which statically imports jeep-sqlite/loader
// at module load time — a Web-only dependency that fails to resolve outright
// under Node/tsx, breaking every test that transitively imported this file
// when an earlier version called sqlite-client.ts's getDb() internally; (2)
// an earlier version's own module-level singleton (keyed by first call) also
// meant a real app connection, once fetched, stayed cached across every
// later call regardless of which connection the caller actually intended —
// harmless in production (there's only ever one real connection) but a
// footgun that required heavy module-mocking to work around in tests
// (see Task 6's history). No caching here at all now — call this once per
// connection you already have; drizzle() itself is cheap to construct.

import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import type { SQLiteDBConnection } from "./sqlite-connection";

export function getDrizzleDb(conn: SQLiteDBConnection): SqliteRemoteDatabase {
  return drizzle(async (sqlText, params, method) => {
    if (method === "run") {
      await conn.run(sqlText, params, false);
      return { rows: [] };
    }
    const result = await conn.query(sqlText, params);
    const rows = (result.values ?? []) as Record<string, unknown>[];
    // drizzle-orm's sqlite-proxy driver decodes every non-"run" method
    // ("all", "get", "values") the same way: SQLiteSession's
    // mapResultRow() reads each column positionally (`row[columnIndex]`)
    // — see node_modules/drizzle-orm/utils.js — so `rows` must always be
    // arrays of column values in SELECT order, never keyed objects.
    // Only special-casing "values" here (as an earlier version of this
    // file did) left "all"/"get" handing back conn.query()'s raw
    // { column: value } objects, which silently decoded to
    // undefined/Invalid Date for every field once real .select() calls
    // started running through this path — caught by Task 6's
    // migration-runner verification, not by anything that exercised
    // .select() at the time this file was written.
    return { rows: rows.map((r) => Object.values(r)) };
  });
}
