// Bootstraps the real on-device SQLite connection via @tauri-apps/plugin-sql.
// Tauri's plugin-sql writes straight to a real SQLite file on every platform
// it runs on (desktop and Android both) — there's no separate "web platform"
// concept anymore (see docs/superpowers/specs/2026-07-24-sub-project-6-capacitor-to-tauri-design.md):
// the app only ever runs inside a Tauri-hosted webview now, via `cargo tauri
// dev`/`cargo tauri build`, never a plain browser. getDb()/persistDb()'s
// callers (src/data/sqlite-repository.ts) don't need to know or care which
// platform they're on — persistDb() is a no-op here because there's no
// in-memory store to flush (unlike the old jeep-sqlite/IndexedDB path).

import { tauriSqliteConnection } from "./tauri-sqlite-connection";
import type { SQLiteDBConnection } from "./sqlite-connection";

let connectionPromise: Promise<SQLiteDBConnection> | null = null;

/** Opens (or returns the already-open) on-device SQLite connection. Safe to call more than once — reuses the same connection. */
export function getDb(): Promise<SQLiteDBConnection> {
  if (!connectionPromise) {
    connectionPromise = tauriSqliteConnection();
  }
  return connectionPromise;
}

/** No-op: plugin-sql writes straight to disk on every call, there's nothing to flush. Kept so sqlite-repository.ts's existing call sites don't need to change. */
export async function persistDb(): Promise<void> {}
