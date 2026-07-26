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
