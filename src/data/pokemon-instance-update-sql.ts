// Extracted out of sqlite-repository.ts's updatePokemonInstance so the exact
// SQL it produces can be exercised directly in a node:test file against a
// real DatabaseSync connection. sqlite-repository.ts can't be imported from
// a plain Node test: it transitively pulls in src/db/sqlite-client.ts's
// browser-only jeep-sqlite loader, which throws at import time outside a DOM
// environment. This file deliberately imports nothing from sqlite-client.ts
// (or anything else Capacitor/jeep-sqlite-related) so it stays
// test-importable in isolation.
import type { PokemonInstance } from "../db/types";
import { computeIvPercent } from "../db/types";
import type { UpdatePokemonInstanceFields } from "./repository";

export interface SqlStatement {
  sql: string;
  params: unknown[];
}

/**
 * Merges a scalar edit into the in-memory cache's copy of an instance the
 * same way sqlite-repository.ts's updatePokemonInstance does, extracted so
 * the merge-then-recompute logic can be exercised directly in a plain
 * node:test file (no jeep-sqlite import chain).
 *
 * ivPercent is a SQL GENERATED column -- SQLite recomputes it on disk from
 * iv_attack/iv_defense/iv_stamina automatically when the scalar UPDATE
 * lands, but the in-memory cache has no such mechanism. If `fields` only
 * touches one (or zero) of the three IV components, the merged instance's
 * OTHER IV values -- not just the ones present in `fields` -- are what
 * `computeIvPercent` must be given, or the recomputed ivPercent silently
 * uses the wrong inputs.
 */
export function mergeUpdatedInstance(existing: PokemonInstance, fields: UpdatePokemonInstanceFields, now: number): PokemonInstance {
  const merged = { ...existing, ...fields, updatedAt: now } as PokemonInstance;
  merged.ivPercent = computeIvPercent(merged.ivAttack, merged.ivDefense, merged.ivStamina);
  return merged;
}

// Column name each scalar UpdatePokemonInstanceFields key writes to.
const SCALAR_COLUMN_BY_FIELD: Record<string, string> = {
  nickname: "nickname",
  cp: "cp",
  ivAttack: "iv_attack",
  ivDefense: "iv_defense",
  ivStamina: "iv_stamina",
  shiny: "shiny",
  lucky: "lucky",
  shadow: "shadow",
  purified: "purified",
  dynamax: "dynamax",
  receivedViaTrade: "received_via_trade",
  heartsEarned: "hearts_earned",
  currentMegaLevel: "current_mega_level",
  backgroundSlug: "background_slug",
  originalTrainerName: "original_trainer_name",
  // originalTrainerId is not part of UpdatePokemonInstanceFields directly --
  // sqlite-repository.ts's updatePokemonInstance resolves it (against
  // referenced_trainer, creating a placeholder row if needed) BEFORE calling
  // buildScalarUpdateStatement, then passes it in alongside the rest of
  // `fields` as an extra key. See that function's own comment.
  originalTrainerId: "original_trainer_id",
};

/**
 * Builds the dynamic-column-list UPDATE for the scalar (non-tag) fields
 * present in `fields`. Returns null if none of the scalar fields are
 * present (a tags-only edit), since there is then nothing to UPDATE.
 */
export function buildScalarUpdateStatement(id: number, fields: UpdatePokemonInstanceFields, now: number): SqlStatement | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(SCALAR_COLUMN_BY_FIELD)) {
    if (!(field in fields)) continue;
    const raw = (fields as Record<string, unknown>)[field];
    sets.push(`${column} = ?`);
    values.push(typeof raw === "boolean" ? (raw ? 1 : 0) : raw);
  }
  if (sets.length === 0) return null;
  return {
    sql: `UPDATE pokemon_instance SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
    params: [...values, now, id],
  };
}

/**
 * Builds the statement(s) needed to replace an instance's tag set with
 * `tagIds`. Split into its own empty-array branch because
 * `tag_id NOT IN (?)` with an empty parameter list becomes `NOT IN (NULL)`
 * in SQLite, which is never true for any row -- so a plain single-branch
 * NOT IN would silently fail to clear all tags when the new set is empty.
 */
export function buildTagDiffStatements(instanceId: number, tagIds: number[]): SqlStatement[] {
  if (tagIds.length === 0) {
    return [{ sql: "DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ?", params: [instanceId] }];
  }
  const placeholders = tagIds.map(() => "?").join(",");
  const statements: SqlStatement[] = [
    {
      sql: `DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ? AND tag_id NOT IN (${placeholders})`,
      params: [instanceId, ...tagIds],
    },
  ];
  for (const tagId of tagIds) {
    statements.push({
      sql: "INSERT OR IGNORE INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)",
      params: [instanceId, tagId],
    });
  }
  return statements;
}
