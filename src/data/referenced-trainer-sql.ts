// referenced_trainer is the complete trainer-identity registry (every real
// profile mirrored, plus placeholders) -- see
// docs/superpowers/specs/2026-07-26-sub-project-7b-identity-and-merge-design.md
// section 4. Pure SQL-builder functions for the upsert, plus thin read
// helpers, so both are directly testable against a real node:sqlite
// DatabaseSync -- same reasoning as profile-management-sql.ts.

import type { SqlStatement } from "./profile-scoped-write-sql";
import type { ReferencedTrainer } from "../db/types";
import type { SQLiteDBConnection } from "../db/sqlite-connection";

export function buildReferencedTrainerUpsert(trainer: ReferencedTrainer): SqlStatement {
  return {
    sql: `INSERT INTO referenced_trainer (uuid, name, friend_code) VALUES (?, ?, ?)
          ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, friend_code = excluded.friend_code`,
    params: [trainer.uuid, trainer.name, trainer.friendCode],
  };
}

function rowToReferencedTrainer(row: Record<string, unknown>): ReferencedTrainer {
  return { uuid: row.uuid as string, name: row.name as string, friendCode: (row.friend_code as string | null) ?? null };
}

export async function findReferencedTrainerByUuid(db: SQLiteDBConnection, uuid: string): Promise<ReferencedTrainer | undefined> {
  const result = await db.query("SELECT uuid, name, friend_code FROM referenced_trainer WHERE uuid = ?", [uuid]);
  const row = result.values?.[0] as Record<string, unknown> | undefined;
  return row ? rowToReferencedTrainer(row) : undefined;
}

export async function findReferencedTrainerByName(db: SQLiteDBConnection, name: string): Promise<ReferencedTrainer | undefined> {
  const result = await db.query("SELECT uuid, name, friend_code FROM referenced_trainer WHERE name = ?", [name]);
  const row = result.values?.[0] as Record<string, unknown> | undefined;
  return row ? rowToReferencedTrainer(row) : undefined;
}

export async function listReferencedTrainers(db: SQLiteDBConnection): Promise<ReferencedTrainer[]> {
  const result = await db.query("SELECT uuid, name, friend_code FROM referenced_trainer", []);
  return ((result.values ?? []) as Record<string, unknown>[]).map(rowToReferencedTrainer);
}
