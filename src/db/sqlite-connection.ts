// The subset of @capacitor-community/sqlite's SQLiteDBConnection interface
// that this project's DB layer (migrations.ts, reference-sync.ts,
// drizzle-client.ts, completion-stats-sql.ts, boot-rescue-read.ts) actually
// calls. Kept here (rather than importing the real @capacitor-community/sqlite
// package) so any SQLite backend — Tauri's plugin-sql (tauri-sqlite-connection.ts)
// or node:sqlite (test/node-sqlite-connection.ts) — can be adapted to this
// same shape without depending on the Capacitor package.

export interface SQLiteDBConnection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(statement: string, values?: unknown[]): Promise<{ values?: any[] }>;
  run(statement: string, values?: unknown[], transaction?: boolean): Promise<{ changes?: { changes?: number; lastId?: number } }>;
  execute(statements: string, transaction?: boolean): Promise<{ changes?: { changes?: number } }>;
  beginTransaction(): Promise<{ changes?: { changes?: number } }>;
  commitTransaction(): Promise<{ changes?: { changes?: number } }>;
  rollbackTransaction(): Promise<{ changes?: { changes?: number } }>;
}
