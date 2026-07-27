// Pure decision logic for "is this incoming trainer someone we already
// know?" -- see docs/superpowers/specs/2026-07-26-sub-project-7b-identity-and-merge-design.md
// section 4.3. Deliberately has no I/O: the caller (sqlite-repository.ts's
// planTrainerImport, or createProfile's promotion check) supplies the
// already-loaded local profiles/referenced_trainer rows, and this function
// returns a decision the caller executes (or, for "ask", surfaces to the
// user before calling back in with the answer).

import type { Profile, ReferencedTrainer } from "../db/types";
import type { SqlStatement } from "./profile-scoped-write-sql";

export interface TrainerCandidate {
  uuid: string;
  name: string;
  friendCode: string | null;
}

export type ReconciliationDecision =
  | { kind: "new" }
  | { kind: "promote"; placeholderUuid: string }
  | { kind: "auto-merge"; localProfileId: string }
  | { kind: "definitely-separate" }
  | { kind: "ask-merge-or-separate"; localProfileId: string };

export function reconcileTrainer(
  candidate: TrainerCandidate,
  localProfiles: Profile[],
  localReferencedTrainers: ReferencedTrainer[],
): ReconciliationDecision {
  // 0. Identical uuid: uuids are minted once and never reused, so a local
  // profile whose id equals the incoming uuid is definitively the SAME
  // trainer -- no ambiguity, no need to fall through to the name/friend-code
  // heuristics below (which exist precisely because those are the only
  // signals available when uuids DON'T match, e.g. two independent devices
  // for the same real-world trainer). This also covers the legacy-import
  // synthesis in personal-data-transfer.ts's wrapLegacyExportAsBundle, which
  // sets the synthetic trainer's uuid to the current profile's own id
  // specifically to land here and reproduce pre-7b "always merge into
  // current" behavior -- without this rule, a current profile with no
  // friend code set (the common case: DEFAULT_PROFILE_USERNAME profiles are
  // created with friend_code = null) would fall through to
  // ask-merge-or-separate/definitely-new instead of merging.
  const uuidMatch = localProfiles.find((p) => p.id === candidate.uuid);
  if (uuidMatch) return { kind: "auto-merge", localProfileId: uuidMatch.id };

  // 1. Friend code, both sides present: definitive, no name check needed.
  if (candidate.friendCode) {
    const friendCodeMatch = localProfiles.find((p) => p.friendCode && p.friendCode === candidate.friendCode);
    if (friendCodeMatch) return { kind: "auto-merge", localProfileId: friendCodeMatch.id };
    const friendCodeConflict = localProfiles.find((p) => p.friendCode && p.friendCode !== candidate.friendCode && p.username === candidate.name);
    if (friendCodeConflict) return { kind: "definitely-separate" };
  }

  // 2. Name match against the complete registry (real profiles + placeholders).
  // `referenced_trainer` allows duplicate names (its PK is uuid, not name), so
  // more than one row can share candidate.name -- e.g. a real profile named
  // "Steve" coexisting with an unrelated placeholder also named "Steve". A
  // plain unordered `.find()` could land on either one, so a genuine
  // placeholder might never get promoted just because array order happened
  // to surface the real-profile match first. Instead: collect every
  // same-name match, then specifically look for a placeholder among them
  // (a uuid with no corresponding `localProfiles` entry) before falling back
  // to treating a same-name real profile as the match.
  const nameMatches = localReferencedTrainers.filter((t) => t.name === candidate.name);
  if (nameMatches.length === 0) return { kind: "new" };

  const placeholderMatch = nameMatches.find((t) => !localProfiles.some((p) => p.id === t.uuid));
  if (placeholderMatch) return { kind: "promote", placeholderUuid: placeholderMatch.uuid };

  const nameMatch = nameMatches[0];
  const matchedProfile = localProfiles.find((p) => p.id === nameMatch.uuid);
  if (!matchedProfile) return { kind: "promote", placeholderUuid: nameMatch.uuid };

  // A real profile matched by name: if both sides carry a friend code and
  // they differ, that's decisive even though we already checked friend
  // codes above (this covers the case where the name-matched profile's
  // friend code differs from the candidate's, which step 1 doesn't reach
  // when there's no local profile whose friend code equals the candidate's).
  if (candidate.friendCode && matchedProfile.friendCode && candidate.friendCode !== matchedProfile.friendCode) {
    return { kind: "definitely-separate" };
  }
  return { kind: "ask-merge-or-separate", localProfileId: matchedProfile.id };
}

// Sweeps every reference to `oldUuid` (a locally-minted uuid -- either a
// placeholder being promoted, or a local profile being merged into an
// imported one) onto `newUuid` (the INCOMING uuid, which always wins -- see
// design spec section 4.3). Covers every profile-scoped table's profile_id
// (same table list as profile-management-sql.ts's buildProfileDeleteStatements,
// since these are the same tables that could carry oldUuid), PLUS every
// pokemon_instance.original_trainer_id across the WHOLE device (not scoped to
// oldUuid's own rows -- a DIFFERENT profile's specimen may have named oldUuid's
// trainer as its original trainer), PLUS the referenced_trainer row itself.
export function buildRewriteTrainerUuidStatements(oldUuid: string, newUuid: string): SqlStatement[] {
  const profileScopedTables = [
    "pokemon_instance",
    "species_personal",
    "form_personal",
    "mega_personal",
    "form_background_personal",
    "app_settings",
    "player_progress_personal",
    "player_progress_log",
    "medal_progress_personal",
  ];
  return [
    ...profileScopedTables.map((table) => ({
      sql: `UPDATE ${table} SET profile_id = ? WHERE profile_id = ?`,
      params: [newUuid, oldUuid],
    })),
    { sql: "UPDATE profile SET id = ? WHERE id = ?", params: [newUuid, oldUuid] },
    { sql: "UPDATE pokemon_instance SET original_trainer_id = ? WHERE original_trainer_id = ?", params: [newUuid, oldUuid] },
    {
      sql: "INSERT INTO referenced_trainer (uuid, name, friend_code) VALUES (?, (SELECT name FROM referenced_trainer WHERE uuid = ?), (SELECT friend_code FROM referenced_trainer WHERE uuid = ?)) ON CONFLICT(uuid) DO NOTHING",
      params: [newUuid, oldUuid, oldUuid],
    },
    { sql: "DELETE FROM referenced_trainer WHERE uuid = ?", params: [oldUuid] },
  ];
}
