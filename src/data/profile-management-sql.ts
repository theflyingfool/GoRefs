// Pure SQL-builder functions for profile CRUD's cascade-delete — extracted
// for direct testability against a real node:sqlite DatabaseSync, same
// reasoning as src/data/profile-scoped-write-sql.ts. Statements are
// returned in an order that's FK-safe only when run with
// `PRAGMA defer_foreign_keys = true` inside a transaction, matching
// reference-sync.ts's established pattern — pokemon_instance_tag/
// pokemon_instance_max_move reference pokemon_instance.id, and are deleted
// via a subquery scoped to this profile's own instances, not their own
// profile_id column (they don't have one).
//
// The table list here must stay exhaustive against every profile-scoped
// personal table in src/db/schema/personal.ts (verified: the 10 tables with
// a profile_id column + the 2 pokemon_instance-scoped join tables + the
// profile row itself). Global tables (app_meta, personal_data_quarantine)
// are intentionally NOT here — they aren't per-profile.

import type { SqlStatement } from "./profile-scoped-write-sql";

export function buildProfileDeleteStatements(profileId: string): SqlStatement[] {
  return [
    {
      sql: "DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id IN (SELECT id FROM pokemon_instance WHERE profile_id = ?)",
      params: [profileId],
    },
    {
      sql: "DELETE FROM pokemon_instance_max_move WHERE pokemon_instance_id IN (SELECT id FROM pokemon_instance WHERE profile_id = ?)",
      params: [profileId],
    },
    { sql: "DELETE FROM pokemon_instance WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM tag WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM species_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM form_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM mega_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM form_background_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM app_settings WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM player_progress_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM player_progress_log WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM medal_progress_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM profile WHERE id = ?", params: [profileId] },
  ];
}

// The FULL statement sequence for deleting a profile as ONE atomic unit. When
// `switchToProfileId` is non-null (i.e. the profile being deleted is the current
// one), the is_current flip to the survivor is prepended to the SAME statement
// list as the cascade delete, so a caller that runs them in a single transaction
// gets all-or-nothing semantics: if any statement fails and the transaction rolls
// back, the is_current flip rolls back too. This is what prevents the
// "flip succeeds, cascade deletes the old is_current row, zero profiles current"
// invariant break that a two-separate-transactions approach is vulnerable to.
//
// FK-safety (deferred) is the caller's responsibility: run these inside a
// transaction with `PRAGMA defer_foreign_keys = true` already set, same as
// buildProfileDeleteStatements. The flip statements are FK-neutral (they only
// touch profile.is_current), so their position at the front doesn't matter for FK
// ordering — only for atomicity.
export function buildDeleteProfileStatements(profileId: string, switchToProfileId: string | null): SqlStatement[] {
  const statements: SqlStatement[] = [];
  if (switchToProfileId !== null) {
    statements.push(
      { sql: "UPDATE profile SET is_current = 0 WHERE is_current = 1", params: [] },
      { sql: "UPDATE profile SET is_current = 1 WHERE id = ?", params: [switchToProfileId] },
    );
  }
  statements.push(...buildProfileDeleteStatements(profileId));
  return statements;
}
