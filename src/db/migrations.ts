// Personal-schema migration runner. Applies migrations tracked in Drizzle's
// own `__drizzle_migrations` table, with a one-time bootstrap for devices
// that shipped before this change (at hand-rolled personal-schema v5 or v6
// — see schema.ts's old CURRENT_PERSONAL_SCHEMA_VERSION and the removed
// MIGRATIONS array, preserved in git history). Note this is v5/v6, not the
// v1.0.0 *tag*'s schema v2 — that tagged release was never actually
// distributed to any device, real or otherwise, so no migration path from
// it is needed; every real device that's ever run this app is at v5 or v6.
//
// This does NOT use drizzle-orm/sqlite-proxy/migrator's migrate() — that
// function's readMigrationFiles() reads migration files off disk via
// Node's `fs` module, which does not exist in a browser. This app runs in
// exactly that environment (Vite dev server / the Web build, via
// jeep-sqlite+sql.js — see sqlite-client.ts), not just under Node (tests,
// scripts/build-dummy-db.ts) — discovered via this project's own e2e smoke
// test, which is exactly the kind of check meant to catch this. Instead,
// each migration's SQL is embedded as a plain string constant
// (./migrations-data.ts, generated via `npm run db:generate-data` — see
// scripts/generate-migrations-data.ts) and applied with the same logic
// drizzle-orm's own migrator uses internally
// (compare each migration's journal timestamp against the latest applied
// row, apply anything newer, record it), just without any filesystem
// access.
//
// Bootstrap: a v5/v6 device has a `schema_version` table but no
// `__drizzle_migrations` table yet. On first boot under this code,
// defensively create the one table a v5 device is missing relative to v6
// (createMissingV5Tables — see its own comment), then seed
// `__drizzle_migrations` with a row matching migration 0000's own
// timestamp *before* applying anything else — this tells the runner "this
// device is already caught up through 0000", so 0000's CREATE TABLE
// statements are never replayed against tables that already exist.
// migration 0000 deliberately encodes the schema these devices actually
// have on disk (TEXT timestamps) — not the final INTEGER-timestamp shape —
// precisely so this bootstrap step can be this simple: migration 0001 (not
// skipped here) then does the real TEXT->INTEGER conversion via a
// table-rebuild, applied identically for fresh installs (a no-op over
// empty tables) and upgrading v6 devices (the real conversion). See
// src/db/migrations/0000_baseline.sql's header comment and this plan's
// Architecture note for the full reasoning — an earlier draft of this file
// tried to convert timestamp values in place via UPDATE without rebuilding
// the table, which does not work: SQLite column affinity is fixed at
// CREATE TABLE time, so a value written into a TEXT-affinity column is
// always re-stored as text regardless of what type was bound, silently
// corrupting every timestamp the first time Drizzle's timestamp_ms mode
// tried to read it back as a Date.
//
// The old `schema_version` table is left in place afterward — unread,
// harmless.

import type { SQLiteDBConnection } from "./sqlite-connection";
import { DEFAULT_PROFILE_ID, DEFAULT_PROFILE_USERNAME } from "./schema";
import { MIGRATION_SQL_BY_TAG } from "./migrations-data";
import journal from "./migrations/meta/_journal.json" with { type: "json" };

const MIGRATIONS_TABLE = "__drizzle_migrations";

interface Migration {
  tag: string;
  millis: number;
  statements: string[];
}

// Ordered by idx, matching drizzle-kit's own journal ordering — each
// migration's SQL is split on the same "--> statement-breakpoint" marker
// drizzle-kit's generated files use between statements (identical to
// drizzle-orm's own readMigrationFiles(), see node_modules/drizzle-orm/migrator.js).
const MIGRATIONS: Migration[] = journal.entries
  .slice()
  .sort((a: { idx: number }, b: { idx: number }) => a.idx - b.idx)
  .map((entry: { tag: string; when: number }) => {
    const sql = MIGRATION_SQL_BY_TAG[entry.tag];
    if (!sql) throw new Error(`No embedded SQL found for migration "${entry.tag}" — update migrations-data.ts`);
    return { tag: entry.tag, millis: entry.when, statements: sql.split("--> statement-breakpoint") };
  });

// migration 0000's own timestamp, read from the journal drizzle-kit
// generated (Task 4) rather than hand-copied — a hand-copied constant is
// exactly the kind of value that silently drifts from the real migration
// files. Its hash isn't meaningful here (nothing compares hashes, only
// `created_at`), so a fixed literal is enough — matches drizzle-orm's own
// migrator, which only uses the hash column for row uniqueness/display.
const BASELINE_ENTRY = MIGRATIONS.find((m) => m.tag === "0000_baseline")!;
const BASELINE_MIGRATION_MILLIS: number = BASELINE_ENTRY.millis;
const BASELINE_MIGRATION_HASH = "v6-bootstrap-baseline";
const BUNDLED_LATEST_MIGRATION_MILLIS: number = Math.max(...MIGRATIONS.map((m) => m.millis));

async function tableExists(db: SQLiteDBConnection, table: string): Promise<boolean> {
  const result = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return (result.values?.length ?? 0) > 0;
}

async function getOldSchemaVersion(db: SQLiteDBConnection): Promise<number | null> {
  if (!(await tableExists(db, "schema_version"))) return null;
  const result = await db.query("SELECT version FROM schema_version LIMIT 1");
  const row = result.values?.[0] as { version: number } | undefined;
  return row ? row.version : null;
}

async function ensureMigrationsTable(db: SQLiteDBConnection): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )`,
    false,
  );
}

// A real device that received a build before this migration exists is
// known to be at hand-rolled personal-schema v5 or v6 (v1.0.0's tagged
// release, schema v2, was never actually distributed to anyone — no
// earlier version needs support here). v5 is missing exactly one table
// compared to v6: player_progress_log (added by the old migration array's
// version-6 step). Migration 0001 unconditionally rebuilds that table
// (DROP TABLE + INSERT ... SELECT FROM player_progress_log), which would
// fail with "no such table" on a genuine v5 device — create it defensively
// first, matching migration 0000's exact shape for that table, so 0001's
// rebuild has something to select from regardless of which of the two
// real versions this device is actually at.
async function createMissingV5Tables(db: SQLiteDBConnection): Promise<void> {
  if (await tableExists(db, "player_progress_log")) return;
  await db.execute(
    `CREATE TABLE IF NOT EXISTS player_progress_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER DEFAULT 1 NOT NULL REFERENCES profile(id),
      recorded_at TEXT NOT NULL,
      current_level INTEGER,
      total_xp INTEGER
    )`,
    false,
  );
}

async function bootstrapDrizzleTrackingForExistingDevice(db: SQLiteDBConnection): Promise<void> {
  const oldVersion = await getOldSchemaVersion(db);
  if (oldVersion === null) return; // fresh install — nothing to bootstrap
  if (await tableExists(db, MIGRATIONS_TABLE)) return; // already bootstrapped

  await createMissingV5Tables(db);
  await ensureMigrationsTable(db);
  await db.run(`INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`, [BASELINE_MIGRATION_HASH, BASELINE_MIGRATION_MILLIS], false);
}

// Drizzle-kit only ever generates schema DDL, never seed data — the profile
// table's id=1 row (every other personal table's profile_id column defaults
// to this id, several of them via a FK into profile(id)) has to be inserted
// by app code. An upgrading v6 device already has a real profile row
// (migration 0001's table-rebuild carries it across); this only matters for
// a genuinely fresh install. Must run after migrations apply (the profile
// table doesn't exist before then) and before any other write to a
// personal table, since profile_id defaults/FKs depend on this row existing
// — runPersonalMigrations is the right place, as the last thing it does.
async function seedDefaultProfileIfMissing(db: SQLiteDBConnection): Promise<void> {
  const result = await db.query("SELECT COUNT(*) as c FROM profile");
  const row = result.values?.[0] as { c: number } | undefined;
  if ((row?.c ?? 0) > 0) return;
  await db.run(
    "INSERT INTO profile (id, username, friend_code, created_at) VALUES (?, ?, NULL, ?)",
    [DEFAULT_PROFILE_ID, DEFAULT_PROFILE_USERNAME, Date.now()],
    false,
  );
}

async function assertNotADowngrade(db: SQLiteDBConnection): Promise<void> {
  if (!(await tableExists(db, MIGRATIONS_TABLE))) return; // fresh install, or bootstrap just ran with nothing later than baseline
  const result = await db.query(`SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`);
  const row = result.values?.[0] as { created_at: number } | undefined;
  if (!row) return;
  if (row.created_at > BUNDLED_LATEST_MIGRATION_MILLIS) {
    throw new Error(
      `Personal data is at a migration newer than this app build knows about. Refusing to boot to avoid misreading it — update the app, or restore an older backup.`,
    );
  }
}

export async function runPersonalMigrations(db: SQLiteDBConnection): Promise<void> {
  await bootstrapDrizzleTrackingForExistingDevice(db);
  await assertNotADowngrade(db);

  await ensureMigrationsTable(db);
  const latestRow = (await db.query(`SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`)).values?.[0] as
    | { created_at: number }
    | undefined;
  const pending = MIGRATIONS.filter((m) => !latestRow || m.millis > latestRow.created_at);

  if (pending.length > 0) {
    await applyPendingMigrations(db, pending);
  }

  await seedDefaultProfileIfMissing(db);
}

// PRAGMA foreign_keys is a documented no-op when issued inside an active
// transaction (SQLite refuses to change enforcement mid-transaction) — the
// pending migrations below are applied inside one transaction, so
// migration 0001's own embedded `PRAGMA foreign_keys=OFF/ON` (see
// 0001_timestamps_to_epoch_ms.sql's header comment) has no effect there;
// it's correct SQL, just inert under this runner. FK enforcement must
// instead be toggled OFF here, before that transaction ever opens — every
// table 0001 rebuilds carries a REFERENCES clause into tables that don't
// exist yet on first boot (reference tables are created by
// syncReferenceData(), which runs AFTER this function returns), and
// SQLite validates a REFERENCES target's existence at INSERT time
// whenever enforcement is on, regardless of row count. Restored to ON only
// after every pending migration is applied, matching the app's normal
// enforced-FK operating state. Verified empirically: issuing this PRAGMA
// inside a transaction leaves `PRAGMA foreign_keys` reading back as
// still-enabled and a dangling-FK insert still fails.
async function applyPendingMigrations(db: SQLiteDBConnection, pending: Migration[]): Promise<void> {
  await db.run("PRAGMA foreign_keys = OFF", [], false);
  try {
    await db.beginTransaction();
    try {
      for (const migration of pending) {
        for (const statement of migration.statements) {
          await db.run(statement, [], false);
        }
        await db.run(`INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`, [migration.tag, migration.millis], false);
      }
      await db.commitTransaction();
    } catch (err) {
      await db.rollbackTransaction();
      throw err;
    }
  } finally {
    await db.run("PRAGMA foreign_keys = ON", [], false);
  }
}
