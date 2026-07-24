// The real backend: everything reads from/writes through a genuine
// on-device @capacitor-community/sqlite database — real native SQLite on
// the shipped Android APK, jeep-sqlite (sql.js + IndexedDB) when running in
// a browser via `npm run dev` (see src/db/sqlite-client.ts; same SQL either
// way, `Capacitor.getPlatform()` picks the backend).
//
// Reads are served from an in-memory cache (src/data/in-memory-store.ts)
// loaded once at startup. This keeps the Repository interface synchronous
// (no ripple of async/loading-state
// changes through every UI call site) at the cost of one async boot step in
// main.ts before the first render. Writes update the cache immediately (so
// the UI reflects them synchronously) and queue a SQL write-through plus a
// saveToStore() call (required on Web for IndexedDB persistence) behind the
// scenes.

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
import { runPersonalMigrations } from "../db/migrations";
import { resolveInstanceAchievementField } from "../db/cascades";
import { applyDexAchievementBackfillIfNeeded, DEX_ACHIEVEMENT_BACKFILL_KEY } from "./dex-achievement-backfill";
import { buildScalarUpdateStatement, buildTagDiffStatements, mergeUpdatedInstance } from "./pokemon-instance-update-sql";
import { buildRenameTagStatement, buildDeleteTagStatements, computeTagUsageCounts } from "./tag-management-sql";
import { syncReferenceData } from "../db/reference-sync";
import { getCompletionStatsSql } from "./completion-stats-sql";
import referenceDataJson from "./reference.json";
import { createInMemoryRepository, type PersonalState } from "./in-memory-store";
import {
  EXCLUDE_REGIONAL_SETTING_KEY,
  type ImportResult,
  type NewPokemonInstanceBatch,
  type Repository,
  type TagCount,
  type UpdatePokemonInstanceFields,
} from "./repository";

const referenceData = referenceDataJson as unknown as ReferenceData;

const FORM_PERSONAL_COLUMNS = [...FORM_PERSONAL_BOOLEAN_FIELDS.map((f) => FORM_PERSONAL_FIELD_COLUMNS[f]), "best_shiny", "best_non_shiny", "best_lucky", "updated_at"];

function upsertFormPersonalSql(): string {
  const columns = ["form_slug", ...FORM_PERSONAL_COLUMNS];
  const placeholders = columns.map(() => "?").join(", ");
  const updates = FORM_PERSONAL_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
  return `INSERT INTO form_personal (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(form_slug) DO UPDATE SET ${updates}`;
}

function formPersonalValues(fp: FormPersonal): unknown[] {
  const values: unknown[] = [fp.formSlug];
  for (const field of FORM_PERSONAL_BOOLEAN_FIELDS) values.push(fp[field] ? 1 : 0);
  values.push(fp.bestShiny, fp.bestNonShiny, fp.bestLucky, fp.updatedAt);
  return values;
}

async function loadPersonalState(db: Awaited<ReturnType<typeof getDb>>): Promise<PersonalState> {
  const speciesPersonal: Record<string, SpeciesPersonal> = {};
  for (const row of (await db.query("SELECT * FROM species_personal")).values ?? []) {
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
  for (const row of (await db.query("SELECT * FROM form_personal")).values ?? []) {
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
  for (const row of (await db.query("SELECT * FROM app_settings")).values ?? []) {
    appSettings[row.key] = row.value;
  }

  const megaPersonal: Record<string, MegaPersonal> = {};
  for (const row of (await db.query("SELECT * FROM mega_personal")).values ?? []) {
    megaPersonal[row.mega_variant_slug] = {
      megaVariantSlug: row.mega_variant_slug,
      evolved: !!row.evolved,
      shinyEvolved: !!row.shiny_evolved,
      updatedAt: row.updated_at,
    };
  }

  const formBackgroundPersonal: FormBackgroundPersonal[] = [];
  for (const row of (await db.query("SELECT * FROM form_background_personal")).values ?? []) {
    formBackgroundPersonal.push({
      formSlug: row.form_slug,
      achievementField: row.achievement_field,
      backgroundSlug: row.background_slug,
      updatedAt: row.updated_at,
    });
  }

  const medalProgress: Record<string, MedalProgressPersonal> = {};
  for (const row of (await db.query("SELECT * FROM medal_progress_personal")).values ?? []) {
    medalProgress[row.medal_slug] = {
      medalSlug: row.medal_slug,
      profileId: row.profile_id,
      currentRank: row.current_rank,
      currentCount: row.current_count,
      updatedAt: row.updated_at,
    };
  }

  const pokemonInstances: PokemonInstance[] = [];
  for (const row of (await db.query("SELECT * FROM pokemon_instance")).values ?? []) {
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
    });
  }

  const tags: Tag[] = [];
  for (const row of (await db.query("SELECT * FROM tag")).values ?? []) {
    tags.push({ id: row.id, profileId: row.profile_id, name: row.name });
  }

  const pokemonInstanceTags: PokemonInstanceTag[] = [];
  for (const row of (await db.query("SELECT * FROM pokemon_instance_tag")).values ?? []) {
    pokemonInstanceTags.push({ pokemonInstanceId: row.pokemon_instance_id, tagId: row.tag_id });
  }

  let playerProgress: PlayerProgressPersonal | undefined;
  const playerProgressRow = (await db.query("SELECT * FROM player_progress_personal")).values?.[0];
  if (playerProgressRow) {
    playerProgress = {
      profileId: playerProgressRow.profile_id,
      currentLevel: playerProgressRow.current_level ?? null,
      totalXp: playerProgressRow.total_xp ?? null,
      updatedAt: playerProgressRow.updated_at,
    };
  }

  const playerProgressLog: PlayerProgressLogEntry[] = [];
  for (const row of (await db.query("SELECT * FROM player_progress_log ORDER BY recorded_at ASC")).values ?? []) {
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
  const profileRow = (await db.query("SELECT * FROM profile")).values![0];
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
    tags,
    pokemonInstanceTags,
    playerProgress,
    playerProgressLog,
    profile,
  };
}

export async function createSqliteRepository(onWriteFailure?: (message: string, retry: () => Promise<void>) => void): Promise<Repository> {
  const db = await getDb();
  await runPersonalMigrations(db);
  await syncReferenceData(db, referenceData);
  const state = await loadPersonalState(db);

  // Backfill any app-setting defaults the DB doesn't have a value for yet —
  // covers both a brand-new install (nothing set at all) and an existing
  // install that predates a newly-added default key. Never overwrites a
  // value the user (or a previous default) already set.
  for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
    if (state.appSettings[key] !== undefined) continue;
    state.appSettings[key] = value;
    await db.run("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
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

  // When > 0, a bulk operation is in flight (see runBulk below). The
  // personal-changed hooks below fire synchronously — one per row — while the
  // in-memory bulk method loops, so each reads this flag at enqueue time and,
  // if inside a bulk, (a) skips its own per-statement transaction (runBulk
  // wraps the whole batch in ONE explicit transaction instead — and the
  // plugin's default per-statement BEGIN would error nested inside that) and
  // (b) skips its per-row persistDb, leaving runBulk to do a single flush at
  // the end. Outside a bulk, behavior is unchanged: per-statement transaction
  // + a persist flush per edit.
  let bulkDepth = 0;

  const repo = createInMemoryRepository(referenceData, state, {
    onSpeciesPersonalChanged(speciesSlug, personal) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        await db.run(
          `INSERT INTO species_personal (species_slug, registered, xxl, xxs, purified, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(species_slug) DO UPDATE SET registered = excluded.registered, xxl = excluded.xxl, xxs = excluded.xxs, purified = excluded.purified, updated_at = excluded.updated_at`,
          [speciesSlug, personal.registered ? 1 : 0, personal.xxl ? 1 : 0, personal.xxs ? 1 : 0, personal.purified ? 1 : 0, personal.updatedAt],
          !inBulk,
        );
        if (!inBulk) await persistDb();
      });
    },
    onFormPersonalChanged(_formSlug, personal) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        await db.run(upsertFormPersonalSql(), formPersonalValues(personal), !inBulk);
        if (!inBulk) await persistDb();
      });
    },
    onAppSettingChanged(key, value) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        await db.run(
          "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          [key, value],
          !inBulk,
        );
        if (!inBulk) await persistDb();
      });
    },
    onMegaPersonalChanged(megaVariantSlug, personal) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        await db.run(
          `INSERT INTO mega_personal (mega_variant_slug, evolved, shiny_evolved, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(mega_variant_slug) DO UPDATE SET evolved = excluded.evolved, shiny_evolved = excluded.shiny_evolved, updated_at = excluded.updated_at`,
          [megaVariantSlug, personal.evolved ? 1 : 0, personal.shinyEvolved ? 1 : 0, personal.updatedAt],
          !inBulk,
        );
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
        await db.run(
          "INSERT OR IGNORE INTO form_background_personal (form_slug, achievement_field, background_slug, updated_at) VALUES (?, ?, ?, ?)",
          [row.formSlug, row.achievementField, row.backgroundSlug, row.updatedAt],
          !inBulk,
        );
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
    onProfileChanged(profile) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        await db.run("UPDATE profile SET username = ?, friend_code = ? WHERE id = ?", [profile.username, profile.friendCode, profile.id], !inBulk);
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
  });

  // Runs a batched in-memory apply (which fires N onXChanged hooks
  // synchronously, each enqueuing a transaction-less row write with persist
  // suppressed — see bulkDepth above) wrapped in a single SQL transaction and
  // followed by exactly ONE persistDb() IndexedDB flush, instead of N. Awaits
  // the queue so callers can rely on the writes having landed.
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

  return {
    ...repo,
    // Overrides the in-memory-store default with real parameterized SQL
    // (CLAUDE.md explicitly asks for this, not just an in-memory scan) — the
    // in-memory version stays as the dummy backend's implementation. Flushes
    // the write queue first so a stat computed right after a toggle can't
    // read a connection that's still mid-write.
    async getCompletionStats(scope, lenses) {
      await writeQueue;
      return getCompletionStatsSql(db, scope, lenses, state.appSettings[EXCLUDE_REGIONAL_SETTING_KEY] === "1");
    },
    // Overrides the in-memory-store default to (a) run the whole merge as
    // one SQL transaction via runBulk, so a failure partway through can't
    // leave some rows merged and others not, and (b) wait for the writes it
    // just queued to actually land in SQLite + IndexedDB — callers that
    // reload the page right after importing need the real backing store
    // updated first, not just the in-memory cache.
    async importPersonalData(data) {
      let result: ImportResult | undefined;
      await runBulk(async () => {
        result = await repo.importPersonalData(data);
      });
      return result!;
    },
    // Bulk overrides: run the shared in-memory cascade path (repo.bulkSet*)
    // but collapse its N per-row IndexedDB flushes into one transaction + one
    // persist via runBulk.
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
    // last_insert_rowid() is the portable way to get it back across all
    // three SQLite bindings this app runs on (native Capacitor, jeep-sqlite
    // web, node:sqlite in tests) — plugin-specific `run()` result shapes
    // aren't consistent enough to rely on directly.
    async createPokemonInstances(batch: NewPokemonInstanceBatch): Promise<PokemonInstance[]> {
      const now = Date.now();
      const created: PokemonInstance[] = [];
      const tagLinks: PokemonInstanceTag[] = [];
      enqueueWrite(async () => {
        await db.beginTransaction();
        for (let i = 0; i < batch.count; i++) {
          await db.run(
            `INSERT INTO pokemon_instance (form_slug, profile_id, status, recorded_at, caught_at, updated_at, cp, iv_attack, iv_defense, iv_stamina, shiny, lucky, shadow, purified, dynamax, received_via_trade, nickname, background_slug)
             VALUES (?, ?, 'kept', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    async createTag(name: string): Promise<Tag> {
      const existing = state.tags.find((t) => t.name === name);
      if (existing) return existing;
      let created: Tag | undefined;
      enqueueWrite(async () => {
        await db.run("INSERT INTO tag (profile_id, name) VALUES (?, ?)", [state.profile.id, name], true);
        const idRow = (await db.query("SELECT last_insert_rowid() AS id")).values?.[0] as { id: number } | undefined;
        created = { id: idRow!.id, profileId: state.profile.id, name };
        await persistDb();
      });
      await writeQueue;
      state.tags.push(created!);
      return created!;
    },
    // Not part of createInMemoryRepository's shared object (see its Omit<>) —
    // pure in-memory computation over already-loaded state, but excluded
    // from the dummy backend's shared implementation to keep all three tag-
    // management methods (this one, renameTag, deleteTag) together. Logic
    // lives in the extracted computeTagUsageCounts (see tag-management-sql.ts)
    // so it's directly unit-testable.
    getTagUsageCounts(): TagCount[] {
      return computeTagUsageCounts(state.tags, state.pokemonInstanceTags);
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
      const idx = state.tags.findIndex((t) => t.id === id);
      if (idx !== -1) state.tags[idx] = { ...state.tags[idx], name };
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
      state.tags = state.tags.filter((t) => t.id !== id);
      state.pokemonInstanceTags = state.pokemonInstanceTags.filter((l) => l.tagId !== id);
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
      const scalarUpdate = buildScalarUpdateStatement(id, fields, now);
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
          state.pokemonInstances[idx] = mergeUpdatedInstance(state.pokemonInstances[idx], fields, now);
        }
      } else {
        const idx = state.pokemonInstances.findIndex((i) => i.id === id);
        if (idx !== -1) {
          state.pokemonInstances[idx] = { ...state.pokemonInstances[idx], ...fields } as PokemonInstance;
        }
      }
      if (fields.tagIds !== undefined) {
        state.pokemonInstanceTags = state.pokemonInstanceTags.filter((t) => t.pokemonInstanceId !== id);
        state.pokemonInstanceTags.push(...fields.tagIds.map((tagId) => ({ pokemonInstanceId: id, tagId })));
      }
    },
    // Reads straight from the module-level reference.json import, same
    // pattern species/forms/types use elsewhere in this file — backgrounds
    // are read-only reference data, no personal-data table involved.
    listBackgrounds() {
      return referenceData.backgrounds.map((b) => ({ slug: b.slug, name: b.name }));
    },
  };
}
