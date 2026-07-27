// The real backend: everything reads from/writes through a genuine
// on-device SQLite database via @tauri-apps/plugin-sql — real native SQLite
// on both Android and desktop, same connection object either way, no
// platform dispatch (see src/db/sqlite-client.ts).
//
// Reads are served from an in-memory cache (src/data/in-memory-store.ts)
// loaded once at startup. This keeps the Repository interface synchronous
// (no ripple of async/loading-state
// changes through every UI call site) at the cost of one async boot step in
// main.ts before the first render. Writes update the cache immediately (so
// the UI reflects them synchronously) and queue a SQL write-through behind
// the scenes; the persistDb() call alongside it is a no-op today (plugin-sql
// writes straight to disk on every call — kept only so call sites don't need
// to change).

import type { ReferenceData } from "../db/reference-data";
import { DEFAULT_APP_SETTINGS } from "../db/defaults";
import {
  FORM_PERSONAL_BOOLEAN_FIELDS,
  FORM_PERSONAL_FIELD_COLUMNS,
  type FormBackgroundPersonal,
  type FormPersonal,
  type MedalProgressPersonal,
  type MegaPersonal,
  type PlayerProgressLogEntry,
  type PlayerProgressPersonal,
  type PokemonInstance,
  type PokemonInstanceTag,
  type Profile,
  type SpeciesPersonal,
  type Tag,
  computeIvPercent,
} from "../db/types";
import { getDb, persistDb } from "../db/sqlite-client";
import { buildSpeciesPersonalUpsert, buildFormPersonalUpsert, buildMegaPersonalUpsert, buildAppSettingUpsert, buildFormBackgroundPersonalInsert } from "./profile-scoped-write-sql";
import { runPersonalMigrations } from "../db/migrations";
import { CURRENT_PERSONAL_SCHEMA_VERSION } from "../db/schema";
import { resolveInstanceAchievementField } from "../db/cascades";
import { applyDexAchievementBackfillIfNeeded, DEX_ACHIEVEMENT_BACKFILL_KEY } from "./dex-achievement-backfill";
import { buildScalarUpdateStatement, buildTagDiffStatements, mergeUpdatedInstance } from "./pokemon-instance-update-sql";
import { buildRenameTagStatement, buildDeleteTagStatements, computeTagUsageCounts } from "./tag-management-sql";
import { buildDeleteProfileStatements } from "./profile-management-sql";
import { buildReferencedTrainerUpsert, findReferencedTrainerByName, listReferencedTrainers } from "./referenced-trainer-sql";
import { syncReferenceData } from "../db/reference-sync";
import { getCompletionStatsSql } from "./completion-stats-sql";
import referenceDataJson from "./reference.json";
import { createInMemoryRepository, type PersonalState } from "./in-memory-store";
import { reconcileTrainer, buildRewriteTrainerUuidStatements } from "./trainer-reconciliation";
import {
  EXCLUDE_REGIONAL_SETTING_KEY,
  type ExportBundle,
  type ImportResult,
  type NewPokemonInstanceBatch,
  type PersonalDataExport,
  type Repository,
  type SpeciesFilter,
  type SpeciesSummary,
  type TagCount,
  type TrainerExport,
  type TrainerImportPlan,
  type TrainerImportSummary,
  type UpdatePokemonInstanceFields,
} from "./repository";

const referenceData = referenceDataJson as unknown as ReferenceData;

async function loadOneProfileState(db: Awaited<ReturnType<typeof getDb>>, profileId: string): Promise<PersonalState> {
  const speciesPersonal: Record<string, SpeciesPersonal> = {};
  for (const row of (await db.query("SELECT * FROM species_personal WHERE profile_id = ?", [profileId])).values ?? []) {
    speciesPersonal[row.species_slug] = {
      speciesSlug: row.species_slug,
      registered: !!row.registered,
      xxl: !!row.xxl,
      xxs: !!row.xxs,
      purified: !!row.purified,
      updatedAt: row.updated_at,
    };
  }

  const formPersonal: Record<string, FormPersonal> = {};
  for (const row of (await db.query("SELECT * FROM form_personal WHERE profile_id = ?", [profileId])).values ?? []) {
    const fp = {
      formSlug: row.form_slug,
      bestShiny: row.best_shiny ?? null,
      bestNonShiny: row.best_non_shiny ?? null,
      bestLucky: row.best_lucky ?? null,
      updatedAt: row.updated_at,
    } as FormPersonal;
    for (const field of FORM_PERSONAL_BOOLEAN_FIELDS) {
      fp[field] = !!row[FORM_PERSONAL_FIELD_COLUMNS[field]];
    }
    formPersonal[row.form_slug] = fp;
  }

  const appSettings: Record<string, string> = {};
  for (const row of (await db.query("SELECT * FROM app_settings WHERE profile_id = ?", [profileId])).values ?? []) {
    appSettings[row.key] = row.value;
  }

  const megaPersonal: Record<string, MegaPersonal> = {};
  for (const row of (await db.query("SELECT * FROM mega_personal WHERE profile_id = ?", [profileId])).values ?? []) {
    megaPersonal[row.mega_variant_slug] = {
      megaVariantSlug: row.mega_variant_slug,
      evolved: !!row.evolved,
      shinyEvolved: !!row.shiny_evolved,
      updatedAt: row.updated_at,
    };
  }

  const formBackgroundPersonal: FormBackgroundPersonal[] = [];
  for (const row of (await db.query("SELECT * FROM form_background_personal WHERE profile_id = ?", [profileId])).values ?? []) {
    formBackgroundPersonal.push({
      formSlug: row.form_slug,
      profileId: row.profile_id,
      achievementField: row.achievement_field,
      backgroundSlug: row.background_slug,
      updatedAt: row.updated_at,
    });
  }

  const medalProgress: Record<string, MedalProgressPersonal> = {};
  for (const row of (await db.query("SELECT * FROM medal_progress_personal WHERE profile_id = ?", [profileId])).values ?? []) {
    medalProgress[row.medal_slug] = {
      medalSlug: row.medal_slug,
      profileId: row.profile_id,
      currentRank: row.current_rank,
      currentCount: row.current_count,
      updatedAt: row.updated_at,
    };
  }

  const pokemonInstances: PokemonInstance[] = [];
  for (const row of (await db.query("SELECT * FROM pokemon_instance WHERE profile_id = ?", [profileId])).values ?? []) {
    pokemonInstances.push({
      id: row.id,
      formSlug: row.form_slug,
      profileId: row.profile_id,
      status: row.status,
      recordedAt: row.recorded_at,
      caughtAt: row.caught_at ?? null,
      updatedAt: row.updated_at,
      cp: row.cp ?? null,
      ivAttack: row.iv_attack ?? null,
      ivDefense: row.iv_defense ?? null,
      ivStamina: row.iv_stamina ?? null,
      ivPercent: row.iv_percent ?? null,
      shiny: !!row.shiny,
      lucky: !!row.lucky,
      shadow: !!row.shadow,
      purified: !!row.purified,
      dynamax: !!row.dynamax,
      receivedViaTrade: !!row.received_via_trade,
      heartsEarned: row.hearts_earned ?? null,
      currentMegaLevel: row.current_mega_level ?? null,
      nickname: row.nickname ?? null,
      backgroundSlug: row.background_slug ?? null,
      uuid: row.uuid,
      originalTrainerName: row.original_trainer_name,
      originalTrainerId: row.original_trainer_id ?? null,
    });
  }

  const pokemonInstanceTags: PokemonInstanceTag[] = [];
  for (const row of (
    await db.query(
      "SELECT pit.* FROM pokemon_instance_tag pit JOIN pokemon_instance pi ON pi.id = pit.pokemon_instance_id WHERE pi.profile_id = ?",
      [profileId],
    )
  ).values ?? []) {
    pokemonInstanceTags.push({ pokemonInstanceId: row.pokemon_instance_id, tagId: row.tag_id });
  }

  let playerProgress: PlayerProgressPersonal | undefined;
  const playerProgressRow = (await db.query("SELECT * FROM player_progress_personal WHERE profile_id = ?", [profileId])).values?.[0];
  if (playerProgressRow) {
    playerProgress = {
      profileId: playerProgressRow.profile_id,
      currentLevel: playerProgressRow.current_level ?? null,
      totalXp: playerProgressRow.total_xp ?? null,
      updatedAt: playerProgressRow.updated_at,
    };
  }

  const playerProgressLog: PlayerProgressLogEntry[] = [];
  for (const row of (await db.query("SELECT * FROM player_progress_log WHERE profile_id = ? ORDER BY recorded_at ASC", [profileId])).values ?? []) {
    playerProgressLog.push({
      id: row.id,
      profileId: row.profile_id,
      recordedAt: row.recorded_at,
      currentLevel: row.current_level ?? null,
      totalXp: row.total_xp ?? null,
    });
  }

  // Always exactly one row, seeded by runPersonalMigrations — its id isn't
  // guaranteed to be DEFAULT_PROFILE_ID on a device that's been upgraded
  // since before that constant existed, so every write site below reads
  // the real id from this row instead of assuming DEFAULT_PROFILE_ID.
  const profileRow = (await db.query("SELECT * FROM profile WHERE id = ?", [profileId])).values![0];
  const profile: Profile = {
    id: profileRow.id,
    username: profileRow.username,
    friendCode: profileRow.friend_code ?? null,
    createdAt: profileRow.created_at,
  };

  return {
    speciesPersonal,
    formPersonal,
    appSettings,
    megaPersonal,
    formBackgroundPersonal,
    medalProgress,
    pokemonInstances,
    pokemonInstanceTags,
    playerProgress,
    playerProgressLog,
    profile,
  };
}

export async function loadAllProfiles(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<{ buckets: Map<string, PersonalState>; currentProfileId: string }> {
  const profileRows = (await db.query("SELECT id, is_current FROM profile")).values ?? [];
  const buckets = new Map<string, PersonalState>();
  let currentProfileId: string | undefined;
  for (const row of profileRows) {
    const state = await loadOneProfileState(db, row.id as string);
    buckets.set(row.id as string, state);
    if (row.is_current) currentProfileId = row.id as string;
  }
  if (!currentProfileId) throw new Error("No profile has is_current set — this should be impossible after runPersonalMigrations.");
  return { buckets, currentProfileId };
}

export async function createSqliteRepository(
  onWriteFailure?: (message: string, retry: () => Promise<void>) => void,
  // Test seam only: lets a unit test construct the FULL repository against a
  // node:sqlite-backed connection (see test/node-sqlite-connection.ts) instead
  // of the Tauri-only getDb(). Production callers (main.ts) never pass this, so
  // behavior on-device is unchanged. Exists so switchProfile/profileBuckets
  // round-trips can be exercised through the real code path in a test.
  dbOverride?: Awaited<ReturnType<typeof getDb>>,
): Promise<Repository> {
  const db = dbOverride ?? (await getDb());
  await runPersonalMigrations(db);
  await syncReferenceData(db, referenceData);
  const { buckets: profileBuckets, currentProfileId } = await loadAllProfiles(db);
  // Tags are device-wide (task 6 / design doc §3.3), not part of any
  // profile's PersonalState bucket — loaded once here rather than per
  // profile in loadOneProfileState. `let`, not `const`: create/rename/delete
  // reassign this binding wholesale (`sharedTags = ...`) rather than mutating
  // in place, and createInMemoryRepository's `getSharedTags` closure below
  // always reads the current binding, so every consumer (in this file and in
  // in-memory-store.ts) stays in sync across a reassignment.
  let sharedTags: Tag[] = (await db.query("SELECT id, profile_id, name FROM tag", [])).values?.map((row) => {
    const r = row as Record<string, unknown>;
    return { id: r.id as number, profileId: r.profile_id as string, name: r.name as string };
  }) ?? [];
  // The device-wide trainer-identity registry (real profiles + placeholders
  // -- see design doc §4.2), same "load once, keep in sync on every write"
  // discipline as sharedTags above. Kept fresh at createProfile/renameProfile/
  // updatePokemonInstance's resolve-or-create path (each upserts one row in
  // place) and refreshed wholesale from the DB at the end of
  // applyTrainerImport (which touches this table through several different
  // code paths -- buildRewriteTrainerUuidStatements' internal INSERT/DELETE,
  // the promote branch's fresh INSERT -- a full re-read there is simpler and
  // just as correct as surgically patching every one of those sites).
  let sharedReferencedTrainers = await listReferencedTrainers(db);
  // SHALLOW COPY — critical. `state` must be its own stable container, NOT the
  // map's own bucket object. switchProfile()/reassignStateToBucket() mutate
  // `state`'s fields in place (every closure in this file captured `state` by
  // reference); if `state` WERE the boot bucket's map entry, the first switch
  // would overwrite that entry's fields to point at the target profile's data,
  // silently corrupting the map (profile A's bucket would vanish, replaced by
  // B's data — then editing "A" would write to B's rows on disk, permanently).
  // The spread makes `state` distinct while its field pointers still alias the
  // boot bucket's objects, so pre-switch edits stay in sync with that bucket.
  const state: PersonalState = { ...profileBuckets.get(currentProfileId)! };

  // Backfill any app-setting defaults a profile's row doesn't have a value
  // for yet — covers a brand-new install (nothing set at all), an existing
  // install that predates a newly-added default key, AND a freshly-created
  // second profile (app_settings is per-profile now — Task 8 seeds these
  // too at creation time, this loop is the boot-time safety net for
  // whichever profile is current). Never overwrites a value already set.
  for (const [profileId, bucket] of profileBuckets) {
    for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
      if (bucket.appSettings[key] !== undefined) continue;
      bucket.appSettings[key] = value;
      const { sql, params } = buildAppSettingUpsert(profileId, key, value);
      await db.run(sql, params);
    }
  }
  await persistDb();

  // Serializes writes onto one promise chain so rapid consecutive toggles
  // can't interleave against the same connection; logs rather than throws
  // since a failed write-through shouldn't crash the UI (the in-memory
  // cache — what the UI actually reads — is already updated by this point).
  // A failure also gets surfaced to the caller-supplied onWriteFailure hook
  // (this module doesn't know about DOM/UI — see write-failure-banner.ts,
  // wired up in main.ts) with a `retry` that re-runs the exact same `fn`,
  // bypassing the queue (which has already moved on by the time a user
  // clicks Retry).
  let writeQueue: Promise<void> = Promise.resolve();
  function enqueueWrite(fn: () => Promise<void>): void {
    writeQueue = writeQueue.then(fn).catch((err) => {
      console.error("SQLite write-through failed:", err);
      onWriteFailure?.(err instanceof Error ? err.message : String(err), fn);
    });
  }

  // Like enqueueWrite, but returns a promise that reflects fn's REAL outcome —
  // resolves only on a genuine commit, rejects on failure — so the caller can
  // observe it and skip its own in-memory cache mutation on a rollback. Crucially,
  // writeQueue ITSELF stays non-rejecting (the callback never rethrows), so this
  // never breaks the unrelated writes that await writeQueue (runBulk,
  // getCompletionStats, importPersonalData, ...). This is the serialization
  // primitive the profile-CRUD methods need: enqueueWrite's fire-and-forget
  // .catch swallows failures, which would let them mutate their caches (or return
  // a "created" profile) for a write that actually rolled back. Placing fn on the
  // same writeQueue chain also preserves full serialization — no queued write can
  // open a transaction inside fn's begin→commit window.
  function enqueueSerialized(fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      writeQueue = writeQueue.then(async () => {
        try {
          await fn();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  // When > 0, a bulk operation is in flight (see runBulk below). The
  // personal-changed hooks below fire synchronously — one per row — while the
  // in-memory bulk method loops, so each reads this flag at enqueue time and,
  // if inside a bulk, (a) skips its own per-statement transaction (runBulk
  // wraps the whole batch in ONE explicit transaction instead — and the
  // plugin's default per-statement BEGIN would error nested inside that) and
  // (b) skips its per-row persistDb call — a no-op today (there's no more
  // IndexedDB; Tauri's SQLite plugin writes straight to disk on every call),
  // kept only so runBulk's transaction batching (one SQL transaction instead
  // of N) still reads as a single logical unit. Outside a bulk, behavior is
  // unchanged: per-statement transaction + a persistDb() call per edit.
  let bulkDepth = 0;

  // Every hook below that writes a row scoped by profile_id captures
  // `state.profile.id` SYNCHRONOUSLY, in the hook body itself (not inside
  // the enqueueWrite closure) — the hook fires synchronously from
  // in-memory-store.ts's apply*() functions, at the exact moment the edit
  // happens, before any later profile switch could change what
  // `state.profile.id` means. Capturing it inside enqueueWrite's deferred
  // closure instead would bind the WRONG profile if a switch happens between
  // the edit and the write actually flushing.
  const repo = createInMemoryRepository(referenceData, state, {
    onSpeciesPersonalChanged(speciesSlug, personal) {
      const inBulk = bulkDepth > 0;
      const profileId = state.profile.id;
      enqueueWrite(async () => {
        const { sql, params } = buildSpeciesPersonalUpsert(profileId, speciesSlug, personal);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
    onFormPersonalChanged(_formSlug, personal) {
      const inBulk = bulkDepth > 0;
      const profileId = state.profile.id;
      enqueueWrite(async () => {
        const { sql, params } = buildFormPersonalUpsert(profileId, personal);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
    onAppSettingChanged(key, value) {
      const inBulk = bulkDepth > 0;
      const profileId = state.profile.id;
      enqueueWrite(async () => {
        const { sql, params } = buildAppSettingUpsert(profileId, key, value);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
    onMegaPersonalChanged(megaVariantSlug, personal) {
      const inBulk = bulkDepth > 0;
      const profileId = state.profile.id;
      enqueueWrite(async () => {
        const { sql, params } = buildMegaPersonalUpsert(profileId, megaVariantSlug, personal);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
    // Only ever called from within importPersonalData's runBulk wrapper below
    // (bulkDepth > 0) — form_background_personal has no per-row setter yet,
    // only import can add to it, always as a brand-new row (composite PK, no
    // update-in-place case, so plain INSERT OR IGNORE is enough).
    onFormBackgroundPersonalAdded(row) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        const { sql, params } = buildFormBackgroundPersonalInsert(row);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
    onMedalProgressChanged(medalSlug, progress) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        await db.run(
          `INSERT INTO medal_progress_personal (medal_slug, profile_id, current_rank, current_count, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(medal_slug, profile_id) DO UPDATE SET current_rank = excluded.current_rank, current_count = excluded.current_count, updated_at = excluded.updated_at`,
          [medalSlug, progress.profileId, progress.currentRank, progress.currentCount, progress.updatedAt],
          !inBulk,
        );
        if (!inBulk) await persistDb();
      });
    },
    onPlayerProgressChanged(progress) {
      const inBulk = bulkDepth > 0;
      // Keep the profile's bucket in sync with `state`. Unlike every other
      // PersonalState field (collections mutated IN PLACE, so `state` and the
      // bucket share the same inner object even after the shallow-copy of
      // `state` at construction), playerProgress is a single value that
      // applyPlayerProgress/import REASSIGN wholesale on `state` only — the
      // bucket's own field would otherwise stay stale, and switching away and
      // back would revert the in-memory Stats display to the pre-edit value
      // (DB is already correct; this is purely in-memory coherence). Writing it
      // back here covers both call sites, which both fire this hook right after
      // reassigning state.playerProgress. progress.profileId is the current,
      // live profile (captured synchronously at edit time), so it's always in
      // the map.
      profileBuckets.get(progress.profileId)!.playerProgress = progress;
      enqueueWrite(async () => {
        await db.run(
          `INSERT INTO player_progress_personal (profile_id, current_level, total_xp, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(profile_id) DO UPDATE SET current_level = excluded.current_level, total_xp = excluded.total_xp, updated_at = excluded.updated_at`,
          [progress.profileId, progress.currentLevel, progress.totalXp, progress.updatedAt],
          !inBulk,
        );
        if (!inBulk) await persistDb();
      });
    },
    onPlayerProgressLogAppended(entry) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        await db.run(
          "INSERT INTO player_progress_log (profile_id, recorded_at, current_level, total_xp) VALUES (?, ?, ?, ?)",
          [entry.profileId, entry.recordedAt, entry.currentLevel, entry.totalXp],
          !inBulk,
        );
        if (!inBulk) await persistDb();
      });
    },
    onPokemonInstanceStatusChanged(instance) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        await db.run("UPDATE pokemon_instance SET status = ?, updated_at = ? WHERE id = ?", [instance.status, instance.updatedAt, instance.id], !inBulk);
        if (!inBulk) await persistDb();
      });
    },
  }, () => sharedTags);

  // Runs a batched in-memory apply (which fires N onXChanged hooks
  // synchronously, each enqueuing a transaction-less row write with persist
  // suppressed — see bulkDepth above) wrapped in a single SQL transaction,
  // followed by one persistDb() call (a no-op today — there's no more
  // IndexedDB — kept as a marker of "the batch is done" rather than for any
  // flush it performs). The real win is still real: one SQL transaction
  // instead of N. Awaits the queue so callers can rely on the writes having
  // landed.
  async function runBulk(applyBatch: () => Promise<void>): Promise<void> {
    bulkDepth++;
    enqueueWrite(async () => {
      await db.beginTransaction();
    });
    try {
      await applyBatch();
    } finally {
      bulkDepth--;
    }
    enqueueWrite(async () => {
      await db.commitTransaction();
      await persistDb();
    });
    await writeQueue;
  }

  // One-time backfill (see applyDexAchievementBackfillIfNeeded above for the
  // gating/loop logic itself, extracted for direct testability). Wrapped in
  // runBulk here so the SQL side lands as one transaction + one persist
  // flush instead of N. NOTE: the authoritative marker check lives inside
  // applyDexAchievementBackfillIfNeeded (and is covered by
  // test/dex-achievement-backfill.test.ts) -- this outer check is only a
  // boot-time optimization to skip opening an empty transaction on every
  // startup after the first. Do not remove the inner check; this outer one
  // is not itself under test (it's part of createSqliteRepository, which
  // needs a live getDb() no test suite provides).
  if (state.appSettings[DEX_ACHIEVEMENT_BACKFILL_KEY] !== "1") {
    await runBulk(async () => {
      applyDexAchievementBackfillIfNeeded(state, repo);
    });
  }

  // ---- Profile CRUD (Sub-project 7a, Task 8) --------------------------------
  // Not part of createInMemoryRepository's shared object (see its Omit<>). These
  // operate on profileBuckets (the Map<profileId, PersonalState> loaded at boot)
  // and on the single shared `state` object every other method in this file
  // reads/writes. switchProfile is the load-bearing one: it reassigns every one
  // of `state`'s fields to point at the target bucket's live objects (never
  // clones them), so all existing closures that captured `state` keep working
  // and instantly see the switched-to profile's data.
  function listProfiles(): Profile[] {
    return [...profileBuckets.values()].map((bucket) => bucket.profile);
  }

  function getCurrentProfile(): Profile {
    return state.profile;
  }

  async function createProfile(username: string, friendCode: string | null): Promise<Profile> {
    // Promote a placeholder (referenced_trainer row with no matching real
    // profile) instead of minting a fresh uuid -- if this name was ever
    // referenced as an original trainer or seen in an import before being
    // fully created, this device already has an identity for it. Real
    // profiles never collide here in practice (profile.id values are UUIDs),
    // so "already a real profile" can only mean two people manually chose
    // the same display name -- that's the "treat as separate" case: fall
    // through to minting a new uuid exactly as before.
    //
    // `referenced_trainer` allows duplicate names (its PK is uuid, not
    // name), so a plain unordered by-name lookup (findReferencedTrainerByName)
    // could land on either row when a real profile and an unrelated
    // placeholder happen to share this name -- same hazard reconcileTrainer's
    // doc comment describes, and the same fix: collect every same-name
    // match and specifically prefer a placeholder among them.
    const nameMatches = (await listReferencedTrainers(db)).filter((t) => t.name === username);
    const existingReferenced = nameMatches.find((t) => !profileBuckets.has(t.uuid));
    const newProfile: Profile = {
      id: existingReferenced ? existingReferenced.uuid : crypto.randomUUID(),
      username,
      friendCode,
      createdAt: Date.now(),
    };
    // Structurally identical to a bucket loadOneProfileState would return for a
    // brand-new (empty) profile — every collection is a FRESH literal (no alias
    // to another profile's arrays/objects), playerProgress undefined, log empty.
    const newBucket: PersonalState = {
      speciesPersonal: {},
      formPersonal: {},
      appSettings: {},
      megaPersonal: {},
      formBackgroundPersonal: [],
      medalProgress: {},
      pokemonInstances: [],
      pokemonInstanceTags: [],
      playerProgress: undefined,
      playerProgressLog: [],
      profile: newProfile,
    };
    for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
      newBucket.appSettings[key] = value;
    }
    // Route through enqueueSerialized (not enqueueWrite): the INSERT can never
    // open its transaction on top of an in-flight queued write ("transaction
    // within a transaction"), AND a failed+rolled-back INSERT rejects here rather
    // than being swallowed — so we never register a phantom in-memory bucket for
    // a profile whose DB row doesn't exist. Profile row + its default app_settings
    // land atomically in one transaction; the bucket is registered only after a
    // confirmed commit.
    await enqueueSerialized(async () => {
      await db.beginTransaction();
      try {
        await db.run("INSERT INTO profile (id, username, friend_code, is_current, created_at) VALUES (?, ?, ?, 0, ?)", [
          newProfile.id,
          newProfile.username,
          newProfile.friendCode,
          newProfile.createdAt,
        ], false);
        for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
          const { sql, params } = buildAppSettingUpsert(newProfile.id, key, value);
          await db.run(sql, params, false);
        }
        const referencedUpsert = buildReferencedTrainerUpsert({ uuid: newProfile.id, name: newProfile.username, friendCode: newProfile.friendCode });
        await db.run(referencedUpsert.sql, referencedUpsert.params, false);
        await db.commitTransaction();
      } catch (err) {
        await db.rollbackTransaction();
        throw err;
      }
      await persistDb();
    });
    profileBuckets.set(newProfile.id, newBucket);
    sharedReferencedTrainers = existingReferenced
      ? sharedReferencedTrainers.map((t) => (t.uuid === newProfile.id ? { uuid: newProfile.id, name: newProfile.username, friendCode: newProfile.friendCode } : t))
      : [...sharedReferencedTrainers, { uuid: newProfile.id, name: newProfile.username, friendCode: newProfile.friendCode }];
    return newProfile;
  }

  // Point the single shared `state` object's fields at a bucket's live objects.
  // Reassign EVERY field of PersonalState (keep this exhaustive against
  // in-memory-store.ts's PersonalState interface — a missed field would leak the
  // old profile's data into the new profile's view). Never clones — the whole
  // "instant switch" design depends on `state` aliasing the bucket's objects.
  function reassignStateToBucket(bucket: PersonalState): void {
    state.speciesPersonal = bucket.speciesPersonal;
    state.formPersonal = bucket.formPersonal;
    state.appSettings = bucket.appSettings;
    state.megaPersonal = bucket.megaPersonal;
    state.formBackgroundPersonal = bucket.formBackgroundPersonal;
    state.medalProgress = bucket.medalProgress;
    state.pokemonInstances = bucket.pokemonInstances;
    state.pokemonInstanceTags = bucket.pokemonInstanceTags;
    state.playerProgress = bucket.playerProgress;
    state.playerProgressLog = bucket.playerProgressLog;
    state.profile = bucket.profile;
  }

  function switchProfile(profileId: string): void {
    const bucket = profileBuckets.get(profileId);
    if (!bucket) throw new Error(`Unknown profile: ${profileId}`);
    reassignStateToBucket(bucket);
    enqueueWrite(async () => {
      await db.beginTransaction();
      try {
        await db.run("UPDATE profile SET is_current = 0 WHERE is_current = 1", [], false);
        await db.run("UPDATE profile SET is_current = 1 WHERE id = ?", [profileId], false);
        await db.commitTransaction();
      } catch (err) {
        await db.rollbackTransaction();
        throw err;
      }
      await persistDb();
    });
  }

  async function renameProfile(profileId: string, username: string, friendCode: string | null): Promise<void> {
    const bucket = profileBuckets.get(profileId);
    if (!bucket) throw new Error(`Unknown profile: ${profileId}`);
    const updated: Profile = { ...bucket.profile, username, friendCode };
    // Route through enqueueSerialized (not enqueueWrite): serializes behind any
    // in-flight queued write AND rejects on a rolled-back UPDATE rather than
    // swallowing it, so the in-memory profile isn't renamed for a DB write that
    // didn't land. Cache update happens only after a confirmed commit.
    await enqueueSerialized(async () => {
      await db.beginTransaction();
      try {
        await db.run("UPDATE profile SET username = ?, friend_code = ? WHERE id = ?", [username, friendCode, profileId], false);
        const referencedUpsert = buildReferencedTrainerUpsert({ uuid: profileId, name: username, friendCode });
        await db.run(referencedUpsert.sql, referencedUpsert.params, false);
        await db.commitTransaction();
      } catch (err) {
        await db.rollbackTransaction();
        throw err;
      }
      await persistDb();
    });
    bucket.profile = updated;
    if (profileId === state.profile.id) state.profile = updated;
    sharedReferencedTrainers = sharedReferencedTrainers.some((t) => t.uuid === profileId)
      ? sharedReferencedTrainers.map((t) => (t.uuid === profileId ? { uuid: profileId, name: username, friendCode } : t))
      : [...sharedReferencedTrainers, { uuid: profileId, name: username, friendCode }];
  }

  async function deleteProfile(profileId: string): Promise<void> {
    if (profileBuckets.size <= 1) throw new Error("Cannot delete the only remaining profile.");
    if (!profileBuckets.has(profileId)) throw new Error(`Unknown profile: ${profileId}`);

    const deletingCurrent = profileId === state.profile.id;
    // When deleting the current profile, pick a survivor to become current. Its
    // is_current flip is folded into the SAME transaction as the cascade below
    // (see buildDeleteProfileStatements) so the two are atomic: a failure rolls
    // back BOTH, and we can never end with the old current row deleted while no
    // survivor was promoted (zero-profiles-current — the invariant this whole
    // sub-project protects).
    const survivorId = deletingCurrent ? [...profileBuckets.keys()].find((id) => id !== profileId)! : null;
    const survivorBucket = survivorId ? profileBuckets.get(survivorId)! : undefined;

    // Run the combined transaction through enqueueSerialized: it stays on the
    // SAME writeQueue chain every other write uses (so no queued toggle-write can
    // open a transaction inside this one's begin→commit window — the "transaction
    // within a transaction" race), while the returned promise reflects the REAL
    // commit/rollback outcome. `await` therefore throws to deleteProfile's caller
    // on failure — unlike enqueueWrite's swallow-everything path — so a
    // rolled-back delete never proceeds to mutate in-memory state below. Because
    // the flip is folded into this same atomic transaction (see
    // buildDeleteProfileStatements), a failure rolls back the flip too: we can
    // never end with the old current row deleted and no survivor promoted.
    await enqueueSerialized(async () => {
      await db.beginTransaction();
      try {
        await db.run("PRAGMA defer_foreign_keys = true", [], false);
        for (const { sql, params } of buildDeleteProfileStatements(profileId, survivorId)) {
          await db.run(sql, params, false);
        }
        await db.commitTransaction();
      } catch (err) {
        await db.rollbackTransaction();
        throw err;
      }
      await persistDb();
    });

    // Confirmed committed: now reconcile the in-memory caches. The auto-switch's
    // state reassignment happens here (after the flip has actually landed), not
    // synchronously up front — so a rolled-back delete never leaves `state`
    // pointing at a profile the DB didn't actually switch to.
    if (deletingCurrent && survivorBucket) reassignStateToBucket(survivorBucket);
    profileBuckets.delete(profileId);
  }

  // Tags are device-wide (task 6 / design doc §3.3) — read/write
  // `sharedTags`, not any per-profile bucket field. `state.profile.id` is
  // still recorded on the INSERT as an informational "who created this"
  // value; it's no longer used for scoping or uniqueness. Pulled out as a
  // standalone function (rather than defined inline in the returned object,
  // as it originally was) so applyTrainerImport's tag-merge loop below can
  // call it directly, same as it already does for createProfile.
  async function createTag(name: string): Promise<Tag> {
    const existing = sharedTags.find((t) => t.name === name);
    if (existing) return existing;
    let created: Tag | undefined;
    enqueueWrite(async () => {
      await db.run("INSERT INTO tag (profile_id, name) VALUES (?, ?)", [state.profile.id, name], true);
      const idRow = (await db.query("SELECT last_insert_rowid() AS id")).values?.[0] as { id: number } | undefined;
      created = { id: idRow!.id, profileId: state.profile.id, name };
      await persistDb();
    });
    await writeQueue;
    sharedTags = [...sharedTags, created!];
    return created!;
  }

  // Pre-resolves a batch of tag names to their (possibly newly-created) ids
  // BEFORE any SQL transaction is open. createTag hardcodes its own
  // per-statement transaction (`db.run(..., true)` above) -- calling it from
  // inside runBulk's already-open transaction would throw "transaction
  // within a transaction", so every tag a specimen merge might need must be
  // resolved here, outside runBulk, first.
  async function resolveTagNameToIdMap(tagNames: Set<string>): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (const tagName of tagNames) {
      const tag = await createTag(tagName);
      map.set(tagName, tag.id);
    }
    return map;
  }

  // The real merge-by-uuid rule (design spec §3.1, "closing gap 1 directly"):
  // a specimen present on both sides keeps whichever row's updatedAt is
  // newer, whole-row (same rule in-memory-store.ts's importPersonalData
  // already uses for every other personal table); a specimen new to this
  // device gets inserted with its own uuid intact. Tag links move with
  // whichever side's row won -- replaced wholesale, not merged link-by-link,
  // same "whole row, not field by field" reasoning. MUST be called from
  // inside an already-open transaction (runBulk) -- see resolveTagNameToIdMap
  // above for why tag creation itself is NOT done here.
  async function mergePokemonInstancesTx(
    data: PersonalDataExport,
    targetProfileId: string,
    tagNameToId: Map<string, number>,
  ): Promise<void> {
    for (const incoming of data.pokemonInstances ?? []) {
      const existingRow = (await db.query("SELECT id, updated_at FROM pokemon_instance WHERE uuid = ?", [incoming.uuid])).values?.[0] as
        | { id: number; updated_at: number }
        | undefined;

      let localId: number;
      if (existingRow) {
        if (existingRow.updated_at >= incoming.updatedAt) continue; // local wins -- row AND its tag links stay as-is
        localId = existingRow.id;
        await db.run(
          `UPDATE pokemon_instance SET form_slug = ?, profile_id = ?, status = ?, recorded_at = ?, caught_at = ?, updated_at = ?, cp = ?, iv_attack = ?, iv_defense = ?, iv_stamina = ?, shiny = ?, lucky = ?, shadow = ?, purified = ?, dynamax = ?, received_via_trade = ?, hearts_earned = ?, current_mega_level = ?, nickname = ?, background_slug = ?, original_trainer_name = ?, original_trainer_id = ? WHERE id = ?`,
          [
            incoming.formSlug, targetProfileId, incoming.status, incoming.recordedAt, incoming.caughtAt, incoming.updatedAt,
            incoming.cp, incoming.ivAttack, incoming.ivDefense, incoming.ivStamina, incoming.shiny ? 1 : 0, incoming.lucky ? 1 : 0,
            incoming.shadow ? 1 : 0, incoming.purified ? 1 : 0, incoming.dynamax ? 1 : 0, incoming.receivedViaTrade ? 1 : 0,
            incoming.heartsEarned, incoming.currentMegaLevel, incoming.nickname, incoming.backgroundSlug,
            incoming.originalTrainerName, incoming.originalTrainerId, localId,
          ],
          false,
        );
      } else {
        await db.run(
          `INSERT INTO pokemon_instance (form_slug, profile_id, status, recorded_at, caught_at, updated_at, cp, iv_attack, iv_defense, iv_stamina, shiny, lucky, shadow, purified, dynamax, received_via_trade, hearts_earned, current_mega_level, nickname, background_slug, uuid, original_trainer_name, original_trainer_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            incoming.formSlug, targetProfileId, incoming.status, incoming.recordedAt, incoming.caughtAt, incoming.updatedAt,
            incoming.cp, incoming.ivAttack, incoming.ivDefense, incoming.ivStamina, incoming.shiny ? 1 : 0, incoming.lucky ? 1 : 0,
            incoming.shadow ? 1 : 0, incoming.purified ? 1 : 0, incoming.dynamax ? 1 : 0, incoming.receivedViaTrade ? 1 : 0,
            incoming.heartsEarned, incoming.currentMegaLevel, incoming.nickname, incoming.backgroundSlug,
            incoming.uuid, incoming.originalTrainerName, incoming.originalTrainerId,
          ],
          false,
        );
        const idRow = (await db.query("SELECT last_insert_rowid() AS id")).values?.[0] as { id: number } | undefined;
        localId = idRow!.id;
      }

      await db.run("DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ?", [localId], false);
      const tagNames = (data.pokemonInstanceTagNames ?? []).filter((t) => t.instanceUuid === incoming.uuid).map((t) => t.tagName);
      for (const tagName of tagNames) {
        const tagId = tagNameToId.get(tagName);
        if (tagId === undefined) continue;
        await db.run("INSERT OR IGNORE INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)", [localId, tagId], false);
      }
    }
  }

  // Post-commit cache sync for whichever profile was the merge target --
  // re-reads pokemon_instance/pokemon_instance_tag from SQL rather than
  // trying to incrementally patch the in-memory arrays to match every
  // insert/update/delete mergePokemonInstancesTx just did. Updates BOTH
  // `state` (if it's still pointed at this profile) and this profile's
  // profileBuckets entry (so the merged data survives a later profile
  // switch away and back, even if `state` gets reassigned elsewhere before
  // that switch happens -- see applyTrainerImport's own restore-at-the-end).
  async function refreshPokemonInstanceCache(targetProfileId: string): Promise<void> {
    const pokemonInstances: PokemonInstance[] = [];
    for (const row of (await db.query("SELECT * FROM pokemon_instance WHERE profile_id = ?", [targetProfileId])).values ?? []) {
      pokemonInstances.push({
        id: row.id,
        formSlug: row.form_slug,
        profileId: row.profile_id,
        status: row.status,
        recordedAt: row.recorded_at,
        caughtAt: row.caught_at ?? null,
        updatedAt: row.updated_at,
        cp: row.cp ?? null,
        ivAttack: row.iv_attack ?? null,
        ivDefense: row.iv_defense ?? null,
        ivStamina: row.iv_stamina ?? null,
        ivPercent: row.iv_percent ?? null,
        shiny: !!row.shiny,
        lucky: !!row.lucky,
        shadow: !!row.shadow,
        purified: !!row.purified,
        dynamax: !!row.dynamax,
        receivedViaTrade: !!row.received_via_trade,
        heartsEarned: row.hearts_earned ?? null,
        currentMegaLevel: row.current_mega_level ?? null,
        nickname: row.nickname ?? null,
        backgroundSlug: row.background_slug ?? null,
        uuid: row.uuid,
        originalTrainerName: row.original_trainer_name,
        originalTrainerId: row.original_trainer_id ?? null,
      });
    }
    const pokemonInstanceTags: PokemonInstanceTag[] = [];
    for (const row of (
      await db.query(
        "SELECT pit.* FROM pokemon_instance_tag pit JOIN pokemon_instance pi ON pi.id = pit.pokemon_instance_id WHERE pi.profile_id = ?",
        [targetProfileId],
      )
    ).values ?? []) {
      pokemonInstanceTags.push({ pokemonInstanceId: row.pokemon_instance_id, tagId: row.tag_id });
    }

    const bucket = profileBuckets.get(targetProfileId);
    if (bucket) {
      bucket.pokemonInstances = pokemonInstances;
      bucket.pokemonInstanceTags = pokemonInstanceTags;
    }
    if (state.profile.id === targetProfileId) {
      state.pokemonInstances = pokemonInstances;
      state.pokemonInstanceTags = pokemonInstanceTags;
    }
  }

  // ---- Trainer import/export (Sub-project 7b, Task 9) ------------------------

  // The "run importPersonalData's existing per-row merge against a specific,
  // possibly-non-current bucket" primitive every applyTrainerImport branch
  // needs. Temporarily points the shared `state` object at targetState (via
  // reassignStateToBucket, same mechanism switchProfile uses) so the shared
  // in-memory-store merge logic -- which always reads/writes `state` -- lands
  // in the right bucket, then runs the merge as one SQL transaction via
  // runBulk. Deliberately does NOT try to restore `state` itself afterward:
  // that's applyTrainerImport's job, once, after every trainer in the bundle
  // has been processed -- see its own doc comment for why restoring per-call
  // here would restore the wrong profile on a multi-trainer bundle.
  async function mergeTrainerExportIntoBucket(trainer: TrainerExport, targetState: PersonalState, targetProfileId: string): Promise<void> {
    const wasCurrent = state.profile.id === targetProfileId;
    if (!wasCurrent) reassignStateToBucket(targetState);
    // Tag ids resolved OUTSIDE runBulk -- see resolveTagNameToIdMap's doc
    // comment for why createTag can't run inside runBulk's open transaction.
    const tagNameToId = await resolveTagNameToIdMap(new Set((trainer.pokemonInstanceTagNames ?? []).map((t) => t.tagName)));
    await runBulk(async () => {
      await repo.importPersonalData(trainer);
      await mergePokemonInstancesTx(trainer, targetProfileId, tagNameToId);
    });
    await refreshPokemonInstanceCache(targetProfileId);
  }

  async function planTrainerImport(bundle: ExportBundle): Promise<TrainerImportPlan> {
    const localProfiles = listProfiles();
    const localReferencedTrainers = await listReferencedTrainers(db);
    return {
      entries: bundle.trainers.map((trainer) => ({
        trainerUuid: trainer.trainerUuid,
        trainerName: trainer.trainerName,
        decision: reconcileTrainer(
          { uuid: trainer.trainerUuid, name: trainer.trainerName, friendCode: trainer.trainerFriendCode },
          localProfiles,
          localReferencedTrainers,
        ),
      })),
    };
  }

  async function applyTrainerImport(bundle: ExportBundle, resolutions: Record<string, "merge" | "separate">): Promise<TrainerImportSummary> {
    const summary: TrainerImportSummary = { merged: 0, promoted: 0, created: 0, separate: 0 };
    const localProfiles = listProfiles();
    const localReferencedTrainers = await listReferencedTrainers(db);
    // The true "current before this whole call began" profile id -- restored
    // at the very end, not left on whichever trainer was merged last. `let`,
    // not `const`: if the merge branch below rewrites THIS profile's own
    // uuid to the incoming trainer's uuid (re-keying its bucket), this needs
    // to track that rename so the restore at the end still finds the bucket.
    let originalCurrentProfileId = state.profile.id;

    for (const trainer of bundle.trainers) {
      const decision = reconcileTrainer(
        { uuid: trainer.trainerUuid, name: trainer.trainerName, friendCode: trainer.trainerFriendCode },
        localProfiles,
        localReferencedTrainers,
      );
      const resolvedKind =
        decision.kind === "ask-merge-or-separate" ? (resolutions[trainer.trainerUuid] ?? "separate") : decision.kind;

      if (resolvedKind === "new" || resolvedKind === "definitely-separate" || resolvedKind === "separate") {
        const created = await createProfile(trainer.trainerName, trainer.trainerFriendCode);
        const targetState = profileBuckets.get(created.id)!;
        await mergeTrainerExportIntoBucket(trainer, targetState, created.id);
        // "new" (no local identity matched at all) counts as created; both
        // definitely-separate (friend-code mismatch) and a user's explicit
        // "separate" answer to an ask-merge-or-separate prompt count as kept
        // separate -- distinct outcomes the UI's summary message reports
        // differently (see TrainerImportSummary/SettingsPage.vue).
        if (resolvedKind === "new") summary.created++;
        else summary.separate++;
        continue;
      }

      if (decision.kind === "promote") {
        await enqueueSerialized(async () => {
          await db.beginTransaction();
          try {
            await db.run("PRAGMA defer_foreign_keys = true", [], false);
            for (const { sql, params } of buildRewriteTrainerUuidStatements(decision.placeholderUuid, trainer.trainerUuid)) {
              await db.run(sql, params, false);
            }
            await db.run("INSERT INTO profile (id, username, friend_code, is_current, created_at) VALUES (?, ?, ?, 0, ?)", [
              trainer.trainerUuid,
              trainer.trainerName,
              trainer.trainerFriendCode,
              Date.now(),
            ], false);
            const referencedUpsert = buildReferencedTrainerUpsert({ uuid: trainer.trainerUuid, name: trainer.trainerName, friendCode: trainer.trainerFriendCode });
            await db.run(referencedUpsert.sql, referencedUpsert.params, false);
            await db.commitTransaction();
          } catch (err) {
            await db.rollbackTransaction();
            throw err;
          }
          await persistDb();
        });
        const { buckets } = await loadAllProfiles(db);
        const targetState = buckets.get(trainer.trainerUuid)!;
        profileBuckets.set(trainer.trainerUuid, targetState);
        await mergeTrainerExportIntoBucket(trainer, targetState, trainer.trainerUuid);
        summary.promoted++;
        continue;
      }

      // "auto-merge", or "merge"-resolved "ask-merge-or-separate":
      const localProfileId = decision.kind === "auto-merge" || decision.kind === "ask-merge-or-separate" ? decision.localProfileId : trainer.trainerUuid;
      if (localProfileId !== trainer.trainerUuid) {
        await enqueueSerialized(async () => {
          await db.beginTransaction();
          try {
            await db.run("PRAGMA defer_foreign_keys = true", [], false);
            for (const { sql, params } of buildRewriteTrainerUuidStatements(localProfileId, trainer.trainerUuid)) {
              await db.run(sql, params, false);
            }
            // Per the design's "incoming uuid always wins" rule (see
            // sub-project 7b design doc S:4.3), the incoming name/friendCode
            // wins too on merge -- otherwise profile.username would keep the
            // OLD local name while the referenced_trainer upsert at the end
            // of this function overwrites that same uuid's mirrored row with
            // the NEW incoming name, leaving the two tables disagreeing about
            // the same trainer (violates the referenced_trainer mirror
            // invariant in S:4.2).
            await db.run("UPDATE profile SET username = ?, friend_code = ? WHERE id = ?", [
              trainer.trainerName,
              trainer.trainerFriendCode,
              trainer.trainerUuid,
            ], false);
            await db.commitTransaction();
          } catch (err) {
            await db.rollbackTransaction();
            throw err;
          }
          await persistDb();
        });
        const bucket = profileBuckets.get(localProfileId)!;
        profileBuckets.delete(localProfileId);
        bucket.profile = { ...bucket.profile, id: trainer.trainerUuid, username: trainer.trainerName, friendCode: trainer.trainerFriendCode };
        profileBuckets.set(trainer.trainerUuid, bucket);
        if (state.profile.id === localProfileId) state.profile = bucket.profile;
        // The current profile's own uuid was just rewritten -- track the
        // rename so the restore at the end of this function still finds the
        // right bucket (see this function's opening comment).
        if (originalCurrentProfileId === localProfileId) originalCurrentProfileId = trainer.trainerUuid;
      } else {
        // uuid already matches (decision.kind === "auto-merge" via the
        // uuid-match path in reconcileTrainer) -- no id rewrite needed, but
        // the incoming name/friendCode can still differ from the local copy
        // (e.g. re-importing after renaming on the source device), so the
        // same "incoming wins" update is still required to keep profile in
        // sync with the referenced_trainer upsert at the end of this
        // function.
        await enqueueSerialized(async () => {
          await db.run("UPDATE profile SET username = ?, friend_code = ? WHERE id = ?", [
            trainer.trainerName,
            trainer.trainerFriendCode,
            trainer.trainerUuid,
          ], true);
        });
        const bucket = profileBuckets.get(trainer.trainerUuid)!;
        bucket.profile = { ...bucket.profile, username: trainer.trainerName, friendCode: trainer.trainerFriendCode };
        if (state.profile.id === trainer.trainerUuid) state.profile = bucket.profile;
      }
      const targetState = profileBuckets.get(trainer.trainerUuid)!;
      await mergeTrainerExportIntoBucket(trainer, targetState, trainer.trainerUuid);
      summary.merged++;
    }

    for (const referenced of bundle.trainers.flatMap((t) => t.referencedTrainers)) {
      const upsert = buildReferencedTrainerUpsert(referenced);
      await db.run(upsert.sql, upsert.params, true);
    }
    for (const tagRow of bundle.tags) {
      const exists = sharedTags.some((t) => t.name === tagRow.name);
      if (!exists) await createTag(tagRow.name);
    }
    await persistDb();

    // Restore whichever profile was actually current before this call began
    // -- see this function's opening comment. Not just a matter of tidiness:
    // every other Repository method implicitly reads/writes `state`'s
    // profile, so leaving it pointed at the last-merged trainer after a
    // multi-trainer import would silently redirect the user's next edit to
    // the wrong trainer's data.
    const originalBucket = profileBuckets.get(originalCurrentProfileId);
    if (originalBucket && state.profile.id !== originalCurrentProfileId) reassignStateToBucket(originalBucket);

    // This table was touched through several different code paths above
    // (buildRewriteTrainerUuidStatements' internal referenced_trainer
    // INSERT/DELETE, the promote branch's fresh INSERT, the referencedTrainers
    // upsert loop) -- a full re-read from the DB is simpler and just as
    // correct as surgically patching sharedReferencedTrainers at every one of
    // those sites (same reasoning as this binding's declaration comment).
    sharedReferencedTrainers = await listReferencedTrainers(db);

    return summary;
  }

  return {
    ...repo,
    // Overrides the in-memory-store default with real parameterized SQL
    // (CLAUDE.md explicitly asks for this, not just an in-memory scan) — the
    // in-memory version stays as the dummy backend's implementation. Flushes
    // the write queue first so a stat computed right after a toggle can't
    // read a connection that's still mid-write.
    async getCompletionStats(scope, lenses) {
      await writeQueue;
      return getCompletionStatsSql(db, state.profile.id, scope, lenses, state.appSettings[EXCLUDE_REGIONAL_SETTING_KEY] === "1");
    },
    // Overrides the in-memory-store default to (a) run the whole merge as
    // one SQL transaction via runBulk, so a failure partway through can't
    // leave some rows merged and others not, (b) wait for the writes it
    // just queued to actually land in SQLite — callers that reload the page
    // right after importing need the real backing store updated first, not
    // just the in-memory cache, and (c) actually merge pokemon_instance (and
    // its tag links) by uuid — the real merge rule design spec §3.1 calls
    // "closing gap 1 directly" — via mergePokemonInstancesTx, since
    // in-memory-store.ts's importPersonalData deliberately leaves specimens
    // alone (see its own comment for why: a genuinely new specimen needs a
    // real INSERT's AUTOINCREMENT id back before the in-memory cache can be
    // updated). mergeTrainerExportIntoBucket below runs the identical
    // specimen-merge path for the trainer-bundle import flow, since that
    // flow calls `repo.importPersonalData` (the un-overridden base) directly
    // rather than through this override.
    async importPersonalData(data) {
      let result: ImportResult | undefined;
      const targetProfileId = state.profile.id;
      // Tag ids resolved OUTSIDE runBulk -- see resolveTagNameToIdMap's doc
      // comment for why createTag can't run inside runBulk's open transaction.
      const tagNameToId = await resolveTagNameToIdMap(new Set((data.pokemonInstanceTagNames ?? []).map((t) => t.tagName)));
      await runBulk(async () => {
        result = await repo.importPersonalData(data);
        await mergePokemonInstancesTx(data, targetProfileId, tagNameToId);
      });
      await refreshPokemonInstanceCache(targetProfileId);
      return result!;
    },
    // Bulk overrides: run the shared in-memory cascade path (repo.bulkSet*)
    // but collapse its N per-row writes into one SQL transaction via runBulk,
    // instead of N separate ones.
    async bulkSetFormPersonalField(formSlugs, field, value) {
      await runBulk(() => repo.bulkSetFormPersonalField(formSlugs, field, value));
    },
    async bulkSetSpeciesPersonalField(speciesSlugs, field, value) {
      await runBulk(() => repo.bulkSetSpeciesPersonalField(speciesSlugs, field, value));
    },
    // Not part of createInMemoryRepository's shared object (see its Omit<>) —
    // both need a real AUTOINCREMENT id back from SQLite before the
    // in-memory cache can be updated, which the shared hook-fires-after
    // in-memory-mutation pattern the rest of this file uses can't provide.
    // last_insert_rowid() is the portable way to get it back across both
    // SQLite bindings this app runs on (@tauri-apps/plugin-sql on-device,
    // node:sqlite in tests) — plugin-specific `run()` result shapes aren't
    // consistent enough to rely on directly.
    async createPokemonInstances(batch: NewPokemonInstanceBatch): Promise<PokemonInstance[]> {
      const now = Date.now();
      const created: PokemonInstance[] = [];
      const tagLinks: PokemonInstanceTag[] = [];
      enqueueWrite(async () => {
        await db.beginTransaction();
        for (let i = 0; i < batch.count; i++) {
          const uuid = crypto.randomUUID();
          await db.run(
            `INSERT INTO pokemon_instance (form_slug, profile_id, status, recorded_at, caught_at, updated_at, cp, iv_attack, iv_defense, iv_stamina, shiny, lucky, shadow, purified, dynamax, received_via_trade, nickname, background_slug, uuid, original_trainer_name, original_trainer_id)
             VALUES (?, ?, 'kept', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              batch.formSlug,
              state.profile.id,
              now,
              batch.caughtAt ?? null,
              now,
              batch.cp ?? null,
              batch.ivAttack ?? null,
              batch.ivDefense ?? null,
              batch.ivStamina ?? null,
              batch.shiny ? 1 : 0,
              batch.lucky ? 1 : 0,
              batch.shadow ? 1 : 0,
              batch.purified ? 1 : 0,
              batch.dynamax ? 1 : 0,
              batch.receivedViaTrade ? 1 : 0,
              batch.nickname ?? null,
              batch.backgroundSlug ?? null,
              uuid,
              state.profile.username,
              state.profile.id,
            ],
            false,
          );
          const idRow = (await db.query("SELECT last_insert_rowid() AS id")).values?.[0] as { id: number } | undefined;
          const id = idRow!.id;
          created.push({
            id,
            formSlug: batch.formSlug,
            profileId: state.profile.id,
            status: "kept",
            recordedAt: now,
            caughtAt: batch.caughtAt ?? null,
            updatedAt: now,
            cp: batch.cp ?? null,
            ivAttack: batch.ivAttack ?? null,
            ivDefense: batch.ivDefense ?? null,
            ivStamina: batch.ivStamina ?? null,
            ivPercent: computeIvPercent(batch.ivAttack ?? null, batch.ivDefense ?? null, batch.ivStamina ?? null),
            shiny: !!batch.shiny,
            lucky: !!batch.lucky,
            shadow: !!batch.shadow,
            purified: !!batch.purified,
            dynamax: !!batch.dynamax,
            receivedViaTrade: !!batch.receivedViaTrade,
            heartsEarned: null,
            currentMegaLevel: null,
            nickname: batch.nickname ?? null,
            backgroundSlug: batch.backgroundSlug ?? null,
            uuid,
            originalTrainerName: state.profile.username,
            originalTrainerId: state.profile.id,
          });
          for (const tagId of batch.tagIds ?? []) {
            await db.run("INSERT OR IGNORE INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)", [id, tagId], false);
            tagLinks.push({ pokemonInstanceId: id, tagId });
          }
        }
        await db.commitTransaction();
        await persistDb();
      });
      await writeQueue;
      // Only mutate the in-memory cache after the transaction above has
      // actually committed — if it throws, writeQueue's own catch handler
      // surfaces the failure and this line is never reached, so the cache
      // never shows rows the real DB doesn't have.
      state.pokemonInstances.push(...created);
      state.pokemonInstanceTags.push(...tagLinks);
      for (const instance of created) {
        repo.setFormPersonalField(instance.formSlug, resolveInstanceAchievementField(instance), true);
      }
      return created;
    },
    createTag,
    // Not part of createInMemoryRepository's shared object (see its Omit<>) —
    // pure in-memory computation over already-loaded state, but excluded
    // from the dummy backend's shared implementation to keep all three tag-
    // management methods (this one, renameTag, deleteTag) together. Logic
    // lives in the extracted computeTagUsageCounts (see tag-management-sql.ts)
    // so it's directly unit-testable.
    getTagUsageCounts(): TagCount[] {
      return computeTagUsageCounts(sharedTags, state.pokemonInstanceTags);
    },
    // Not part of createInMemoryRepository's shared object (see its Omit<>) —
    // uses the extracted buildRenameTagStatement (see tag-management-sql.ts)
    // so the exact SQL is coverable by a real-SQLite test.
    async renameTag(id: number, name: string): Promise<void> {
      const statement = buildRenameTagStatement(id, name);
      enqueueWrite(async () => {
        await db.run(statement.sql, statement.params, true);
        await persistDb();
      });
      await writeQueue;
      sharedTags = sharedTags.map((t) => (t.id === id ? { ...t, name } : t));
    },
    // Not part of createInMemoryRepository's shared object (see its Omit<>) —
    // uses the extracted buildDeleteTagStatements (see tag-management-sql.ts),
    // which orders the DELETEs so pokemon_instance_tag's links are removed
    // before the tag row itself (no ON DELETE CASCADE on that FK).
    async deleteTag(id: number): Promise<void> {
      const statements = buildDeleteTagStatements(id);
      enqueueWrite(async () => {
        await db.beginTransaction();
        for (const statement of statements) {
          await db.run(statement.sql, statement.params, false);
        }
        await db.commitTransaction();
        await persistDb();
      });
      await writeQueue;
      sharedTags = sharedTags.filter((t) => t.id !== id);
      // In-place mutation, not reassignment -- `state.pokemonInstanceTags`
      // aliases the SAME array as this profile's profileBuckets entry (see
      // `state`'s "SHALLOW COPY" declaration comment above); reassigning the
      // field here would only repoint state's own copy, leaving the bucket's
      // (and any other alias's) array stale. Tags are device-wide, so every
      // OTHER profile's bucket also needs this tag's links dropped -- loop
      // over all of them, not just the current one.
      for (const bucket of profileBuckets.values()) {
        const kept = bucket.pokemonInstanceTags.filter((l) => l.tagId !== id);
        bucket.pokemonInstanceTags.length = 0;
        bucket.pokemonInstanceTags.push(...kept);
      }
    },
    // Not part of createInMemoryRepository's shared object (see its Omit<>) —
    // this is a dynamic-column-list UPDATE against real SQL, which the
    // in-memory engine has no equivalent for; the dummy backend mutates
    // state.pokemonInstances directly instead (see in-memory-store.ts).
    //
    // Known asymmetry (not a bug, undecided): createPokemonInstances runs
    // resolveInstanceAchievementField -> setFormPersonalField after logging
    // a catch, so a newly-caught shiny/lucky/100%-IV specimen immediately
    // updates the Dex achievement flags. Editing an existing specimen here
    // to *become* shiny, or editing its IVs up to 100%, does NOT re-run
    // that cascade. Whether edits should also trigger it is a product
    // decision outside this fix's scope -- flagging so a future reader
    // isn't surprised by the gap.
    async updatePokemonInstance(id: number, fields: UpdatePokemonInstanceFields): Promise<void> {
      const now = Date.now();

      // originalTrainerName is free-typed on the edit form, but the column
      // that actually gets written (original_trainer_id) is a soft link
      // resolved against referenced_trainer -- a new name mints a fresh
      // placeholder row there rather than leaving the specimen's link
      // dangling. This has to happen BEFORE buildScalarUpdateStatement is
      // called, since the resolved id needs to ride along in the same
      // dynamic-column-list object it builds from (see
      // pokemon-instance-update-sql.ts's SCALAR_COLUMN_BY_FIELD).
      let originalTrainerId: string | null | undefined;
      if (fields.originalTrainerName !== undefined) {
        const existing = await findReferencedTrainerByName(db, fields.originalTrainerName);
        if (existing) {
          originalTrainerId = existing.uuid;
        } else {
          originalTrainerId = crypto.randomUUID();
          const upsert = buildReferencedTrainerUpsert({ uuid: originalTrainerId, name: fields.originalTrainerName, friendCode: null });
          sharedReferencedTrainers = [...sharedReferencedTrainers, { uuid: originalTrainerId, name: fields.originalTrainerName, friendCode: null }];
          enqueueWrite(async () => {
            await db.run(upsert.sql, upsert.params, true);
            await persistDb();
          });
        }
      }
      const scalarFields: UpdatePokemonInstanceFields & { originalTrainerId?: string | null } =
        fields.originalTrainerName !== undefined ? { ...fields, originalTrainerId } : fields;

      const scalarUpdate = buildScalarUpdateStatement(id, scalarFields, now);
      const tagStatements = fields.tagIds !== undefined ? buildTagDiffStatements(id, fields.tagIds) : [];

      enqueueWrite(async () => {
        await db.beginTransaction();
        if (scalarUpdate) {
          await db.run(scalarUpdate.sql, scalarUpdate.params, false);
        }
        for (const statement of tagStatements) {
          await db.run(statement.sql, statement.params, false);
        }
        await db.commitTransaction();
        await persistDb();
      });
      await writeQueue;

      // Cache's updatedAt only bumps when the DB's updated_at column did --
      // i.e. when there was at least one scalar field to write. A tags-only
      // edit never touches pokemon_instance's updated_at, so the cache
      // shouldn't claim it did either.
      if (scalarUpdate) {
        const idx = state.pokemonInstances.findIndex((i) => i.id === id);
        if (idx !== -1) {
          // See mergeUpdatedInstance's own doc comment (pokemon-instance-
          // update-sql.ts) for why ivPercent needs a manual recompute here
          // from the merged IV values, not just the ones present in `fields`.
          // scalarFields (not `fields`) so a resolved originalTrainerId rides
          // along into the cache the same way it did into the DB row --
          // otherwise the cache would show the new original_trainer_name
          // paired with the stale original_trainer_id until next reload.
          state.pokemonInstances[idx] = mergeUpdatedInstance(state.pokemonInstances[idx], scalarFields, now);
        }
      } else {
        const idx = state.pokemonInstances.findIndex((i) => i.id === id);
        if (idx !== -1) {
          state.pokemonInstances[idx] = { ...state.pokemonInstances[idx], ...fields } as PokemonInstance;
        }
      }
      if (fields.tagIds !== undefined) {
        // In-place mutation, not reassignment -- see deleteTag's identical
        // note above for why: `state.pokemonInstanceTags` aliases the SAME
        // array as this profile's profileBuckets entry, and reassigning the
        // field would only repoint state's own copy, leaving the bucket
        // (read directly by exportTrainer, bypassing `state` entirely) stale.
        const kept = state.pokemonInstanceTags.filter((t) => t.pokemonInstanceId !== id);
        state.pokemonInstanceTags.length = 0;
        state.pokemonInstanceTags.push(...kept, ...fields.tagIds.map((tagId) => ({ pokemonInstanceId: id, tagId })));
      }
    },
    // Reads straight from the module-level reference.json import, same
    // pattern species/forms/types use elsewhere in this file — backgrounds
    // are read-only reference data, no personal-data table involved.
    listBackgrounds() {
      return referenceData.backgrounds.map((b) => ({ slug: b.slug, name: b.name }));
    },
    listProfiles,
    getCurrentProfile,
    createProfile,
    switchProfile,
    renameProfile,
    deleteProfile,
    // Reads from profileBuckets directly (not the live `state`) so it works
    // for ANY local profile -- including one that isn't current -- without
    // switching to it first. `tags` is intentionally omitted from the
    // returned TrainerExport: tags are device-wide (Task 6), not part of
    // any profile's PersonalState bucket, so there's nothing per-trainer to
    // put here -- callers get the device's tag list from ExportBundle.tags
    // instead (populated once in Task 9's bundle builder).
    exportTrainer(profileId: string): TrainerExport {
      const bucket = profileBuckets.get(profileId);
      if (!bucket) throw new Error(`Unknown profile: ${profileId}`);
      return {
        exportedAt: new Date().toISOString(),
        schemaVersion: CURRENT_PERSONAL_SCHEMA_VERSION,
        speciesPersonal: { ...bucket.speciesPersonal },
        formPersonal: { ...bucket.formPersonal },
        appSettings: { ...bucket.appSettings },
        megaPersonal: { ...bucket.megaPersonal },
        formBackgroundPersonal: [...bucket.formBackgroundPersonal],
        medalProgress: { ...bucket.medalProgress },
        pokemonInstances: [...bucket.pokemonInstances],
        pokemonInstanceTagNames: bucket.pokemonInstanceTags
          .map((link) => {
            const instance = bucket.pokemonInstances.find((i) => i.id === link.pokemonInstanceId);
            const tag = sharedTags.find((t) => t.id === link.tagId);
            return instance && tag ? { instanceUuid: instance.uuid, tagName: tag.name } : undefined;
          })
          .filter((x): x is { instanceUuid: string; tagName: string } => x !== undefined),
        playerProgress: bucket.playerProgress,
        playerProgressLog: [...bucket.playerProgressLog],
        trainerUuid: bucket.profile.id,
        trainerName: bucket.profile.username,
        trainerFriendCode: bucket.profile.friendCode,
        referencedTrainers: [], // filled in by the caller building the ExportBundle -- see buildExportBundle, which fetches the device-wide list ONCE and attaches it to every trainer rather than re-querying per trainer.
      };
    },
    listSpeciesSummariesForProfile(profileId: string, filter?: SpeciesFilter): SpeciesSummary[] {
      const bucket = profileBuckets.get(profileId);
      if (!bucket) throw new Error(`Unknown profile: ${profileId}`);
      return repo.computeSpeciesSummariesForBucket(bucket, filter);
    },
    // Synchronous cached read (mirrors sharedTags) -- see sharedReferencedTrainers's
    // declaration comment above for how it's kept fresh.
    listReferencedTrainers() {
      return sharedReferencedTrainers;
    },
    planTrainerImport,
    applyTrainerImport,
  };
}
