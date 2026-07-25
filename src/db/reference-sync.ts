// Reference-table refresh: on every startup, wipes and reloads only the
// reference tables (species/form/etc.) from the bundled src/data/reference.json
// asset if its content has changed since the last run — personal tables are
// never touched here except for the slug-rename remap below. Mirrors
// CLAUDE.md's "wholesale replaceable reference tables, upsert by slug" design.
//
// Runs after runPersonalMigrations() — it depends on app_settings existing to
// store the last-synced version marker.
//
// The "has it changed" check compares against REFERENCE_DATA_VERSION, a hash
// baked into src/data/reference-version.ts at build time (see
// scripts/ingest/build-reference.ts) rather than computed here — a runtime
// JSON.stringify + hash of the full multi-thousand-row reference dataset ran
// on every single boot even when nothing had changed, purely to answer a
// question the build already knows the answer to.

import type { SQLiteDBConnection } from "./sqlite-connection";
import { REFERENCE_SCHEMA_SQL } from "./schema";
import type { ReferenceData } from "./reference-data";
import { SLUG_RENAMES } from "./slug-renames";
import { getDrizzleDb } from "./drizzle-client";
import { REFERENCE_DATA_VERSION } from "../data/reference-version";
import {
  backgrounds,
  communityDay,
  communityDayBonus,
  communityDayEventMove,
  communityDaySpecies,
  form,
  formMove,
  formTypes,
  friendshipLevel,
  medal,
  medalTier,
  megaVariant,
  move,
  playerLevel,
  playerLevelReward,
  pvpRankRequirement,
  pvpRankReward,
  raidBoss,
  raidBossWeatherBoost,
  regions,
  species,
  speciesEvolution,
  typeEffectiveness,
  types,
  weatherBoost,
} from "./schema/reference";

const VERSION_SETTING_KEY = "reference_data_version";

async function getStoredReferenceVersion(db: SQLiteDBConnection): Promise<string | null> {
  const result = await db.query("SELECT value FROM app_settings WHERE key = ?", [VERSION_SETTING_KEY]);
  const row = result.values?.[0] as { value: string } | undefined;
  return row?.value ?? null;
}

async function applySlugRenames(db: SQLiteDBConnection): Promise<void> {
  for (const rename of SLUG_RENAMES) {
    if (rename.table === "species_personal") {
      await db.run("UPDATE species_personal SET species_slug = ? WHERE species_slug = ?", [rename.to, rename.from], false);
    } else if (rename.table === "form_personal") {
      await db.run("UPDATE form_personal SET form_slug = ? WHERE form_slug = ?", [rename.to, rename.from], false);
    } else {
      await db.run("UPDATE form_background_personal SET form_slug = ? WHERE form_slug = ?", [rename.to, rename.from], false);
    }
  }
}

// Moves any row that fails `isValid` into personal_data_quarantine (see
// schema.ts) instead of leaving it in place for the deferred FK check at
// COMMIT to trip over — a real orphan (a slug reference-sync can't resolve,
// not covered by a SLUG_RENAMES entry) would otherwise fail the *entire*
// sync transaction, rolling back a legitimate reference-data update just
// because one stale personal row exists. One DELETE per orphaned row rather
// than a bulk "WHERE slug NOT IN (...)" — form_personal alone can have
// thousands of valid slugs, past SQLite's default bound parameter limit.
async function quarantineOrphans(
  db: SQLiteDBConnection,
  table: string,
  pkColumns: string[],
  isValid: (row: Record<string, unknown>) => boolean,
): Promise<void> {
  const result = await db.query(`SELECT * FROM ${table}`);
  const now = Date.now();
  for (const row of (result.values ?? []) as Record<string, unknown>[]) {
    if (isValid(row)) continue;
    await db.run(
      "INSERT INTO personal_data_quarantine (source_table, slug, payload_json, quarantined_at) VALUES (?, ?, ?, ?)",
      [table, String(row[pkColumns[0]]), JSON.stringify(row), now],
      false,
    );
    const whereClause = pkColumns.map((c) => `${c} = ?`).join(" AND ");
    await db.run(`DELETE FROM ${table} WHERE ${whereClause}`, pkColumns.map((c) => row[c]), false);
  }
}

// Splits a row array into fixed-size slices for batched inserts. Needed
// because a single `.values([...])` call binds one SQL parameter per cell,
// and older SQLite builds (pre-3.32, still the default on some Android
// toolchains) cap bound parameters at 999 — comfortably exceeded by this
// app's largest reference tables (e.g. form_move: ~10k rows) if inserted in
// one shot. 90 rows keeps every table (max 11 columns, e.g. species/form)
// safely under that limit (990 params) with margin to spare, regardless of
// which SQLite build a given device actually ships.
const INSERT_CHUNK_SIZE = 90;

function chunk<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

// `version` defaults to the build-time-baked REFERENCE_DATA_VERSION (the
// real app never passes this explicitly) — tests override it with their own
// fixture-specific version strings so they can exercise real change
// detection between two different in-memory ReferenceData objects, which a
// single fixed build-time constant can't distinguish on its own.
export async function syncReferenceData(db: SQLiteDBConnection, referenceData: ReferenceData, version: string = REFERENCE_DATA_VERSION): Promise<void> {
  await db.execute(REFERENCE_SCHEMA_SQL);

  const newVersion = version;
  const storedVersion = await getStoredReferenceVersion(db);
  if (storedVersion === newVersion) return;

  const drizzleDb = getDrizzleDb(db);

  await db.beginTransaction();
  try {
    // Defer foreign-key enforcement to COMMIT. Personal tables
    // (species_personal, form_personal, …) hold FKs into the reference
    // tables we're about to drop/recreate; without deferral, the implicit
    // row-delete of a DROP TABLE (or a DELETE FROM) trips "FOREIGN KEY
    // constraint failed" the moment any personal data references a reference
    // row — which is every returning user the first time an app update
    // changes reference.json. Because we re-insert the same slugs below, the
    // constraints are satisfied again by commit time. Resets automatically
    // at the end of the transaction.
    await db.run("PRAGMA defer_foreign_keys = true", [], false);

    // Renames must land before the old form rows disappear below, or the
    // personal rows they'd otherwise remap would just get orphaned instead.
    await applySlugRenames(db);

    // Quarantine any personal row a rename didn't account for — must run
    // after renames land (so a just-renamed row reads as valid, not
    // orphaned) and before the DROP TABLE below (so these rows are gone
    // before the deferred FK check at COMMIT would otherwise trip on them).
    const speciesSlugs = new Set(referenceData.species.map((s) => s.slug));
    const formSlugs = new Set(referenceData.forms.map((f) => f.slug));
    const backgroundSlugs = new Set(referenceData.backgrounds.map((bg) => bg.slug));
    const megaVariantSlugs = new Set(referenceData.megaVariants.map((m) => m.slug));
    await quarantineOrphans(db, "species_personal", ["species_slug"], (row) => speciesSlugs.has(row.species_slug as string));
    await quarantineOrphans(db, "form_personal", ["form_slug"], (row) => formSlugs.has(row.form_slug as string));
    await quarantineOrphans(
      db,
      "form_background_personal",
      ["form_slug", "achievement_field", "background_slug"],
      (row) => formSlugs.has(row.form_slug as string) && backgroundSlugs.has(row.background_slug as string),
    );
    await quarantineOrphans(db, "mega_personal", ["mega_variant_slug"], (row) => megaVariantSlugs.has(row.mega_variant_slug as string));

    // Drop (not just delete-from) in FK-safe order (children before
    // parents), then recreate from REFERENCE_SCHEMA_SQL below. A plain
    // DELETE FROM would leave a stale table object in place if a reference
    // table's *column shape* changed (a column added/removed/renamed) since
    // the last sync — CREATE TABLE IF NOT EXISTS at the top of this
    // function is a no-op against an already-existing table, so the old
    // columns would silently stick around forever on any device that had
    // already initialized its DB before the shape changed. Dropping and
    // recreating makes every future DDL change to these tables safe by
    // default, not just this one. `transaction: false` on every statement
    // below — we're already inside the manual begin/commit above and don't
    // want each call opening its own.
    for (const table of [
      "form_move",
      "raid_boss_weather_boost",
      "raid_boss",
      "community_day_event_move",
      "community_day_species",
      "community_day_bonus",
      "community_day",
      "species_evolution",
      "move",
      "type_effectiveness",
      "weather_boost",
      "player_level_reward",
      "player_level",
      "medal_tier",
      "medal",
      "friendship_level",
      "pvp_rank_reward",
      "pvp_rank_requirement",
      "form_types",
      "mega_variant",
      "form",
      "species",
      "backgrounds",
      "types",
      "regions",
    ]) {
      await db.run(`DROP TABLE IF EXISTS ${table}`, [], false);
    }
    await db.execute(REFERENCE_SCHEMA_SQL, false);

    for (const rows of chunk(referenceData.regions.map((r) => ({ slug: r.slug, name: r.name })), INSERT_CHUNK_SIZE)) {
      await drizzleDb.insert(regions).values(rows).run();
    }
    for (const rows of chunk(referenceData.types.map((t) => ({ slug: t.slug, name: t.name })), INSERT_CHUNK_SIZE)) {
      await drizzleDb.insert(types).values(rows).run();
    }
    for (const rows of chunk(referenceData.backgrounds.map((bg) => ({ slug: bg.slug, name: bg.name })), INSERT_CHUNK_SIZE)) {
      await drizzleDb.insert(backgrounds).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.species.map((s) => ({
        slug: s.slug,
        dexNumber: s.dexNumber,
        name: s.name,
        familySlug: s.familySlug,
        gen: s.gen,
        rarity: s.rarity,
        regionSlug: s.regionSlug,
        hasMale: s.hasMale,
        hasFemale: s.hasFemale,
        canMegaEvolve: s.canMegaEvolve,
        canGigantamax: s.canGigantamax,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(species).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.forms.map((f) => ({
        slug: f.slug,
        speciesSlug: f.speciesSlug,
        formName: f.formName,
        costumeName: f.costumeName,
        gender: f.gender,
        evolves: f.evolves,
        shinyAvailable: f.shinyAvailable,
        shadowAvailable: f.shadowAvailable,
        dynamaxAvailable: f.dynamaxAvailable,
        regionalExclusive: f.regionalExclusive,
        imageRef: f.imageRef,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(form).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.formTypes.map((ft) => ({ formSlug: ft.formSlug, typeSlug: ft.typeSlug })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(formTypes).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.megaVariants.map((m) => ({ slug: m.slug, speciesSlug: m.speciesSlug, variant: m.variant })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(megaVariant).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.moves.map((mv) => ({
        slug: mv.slug,
        name: mv.name,
        category: mv.category,
        typeSlug: mv.typeSlug,
        power: mv.power,
        energyDelta: mv.energyDelta,
        durationMs: mv.durationMs,
        pvpPower: mv.pvpPower,
        pvpEnergyDelta: mv.pvpEnergyDelta,
        pvpTurns: mv.pvpTurns,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(move).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.formMoves.map((fm) => ({ formSlug: fm.formSlug, moveSlug: fm.moveSlug, isElite: fm.isElite })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(formMove).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.speciesEvolutions.map((se) => ({
        fromSpeciesSlug: se.fromSpeciesSlug,
        toSpeciesSlug: se.toSpeciesSlug,
        candyRequired: se.candyRequired,
        itemRequired: se.itemRequired,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(speciesEvolution).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.typeEffectiveness.map((te) => ({
        attackingTypeSlug: te.attackingTypeSlug,
        defendingTypeSlug: te.defendingTypeSlug,
        multiplier: te.multiplier,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(typeEffectiveness).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.weatherBoosts.map((wb) => ({ weather: wb.weather, typeSlug: wb.typeSlug })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(weatherBoost).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.playerLevels.map((pl) => ({ level: pl.level, cumulativeXp: pl.cumulativeXp })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(playerLevel).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.playerLevelRewards.map((plr) => ({
        level: plr.level,
        sortOrder: plr.sortOrder,
        itemName: plr.itemName,
        amount: plr.amount,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(playerLevelReward).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.medals.map((md) => ({
        slug: md.slug,
        name: md.name,
        description: md.description,
        isEventMedal: md.isEventMedal,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(medal).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.medalTiers.map((mt) => ({ medalSlug: mt.medalSlug, rank: mt.rank, target: mt.target })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(medalTier).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.friendshipLevels.map((fl) => ({
        level: fl.level,
        name: fl.name,
        pointsRequired: fl.pointsRequired,
        xpReward: fl.xpReward,
        attackBonus: fl.attackBonus,
        tradingDiscount: fl.tradingDiscount,
        raidBallBonus: fl.raidBallBonus,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(friendshipLevel).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.pvpRankRewards.map((pr) => ({
        leagueRank: pr.leagueRank,
        track: pr.track,
        sortOrder: pr.sortOrder,
        rewardType: pr.rewardType,
        itemName: pr.itemName,
        amount: pr.amount,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(pvpRankReward).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.pvpRankRequirements.map((rq) => ({
        rank: rq.rank,
        additionalBattlesRequired: rq.additionalBattlesRequired,
        additionalBattleWinsRequired: rq.additionalBattleWinsRequired,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(pvpRankRequirement).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.raidBosses.map((rb) => ({
        tier: rb.tier,
        formSlug: rb.formSlug,
        minCp: rb.minCp,
        maxCp: rb.maxCp,
        minBoostedCp: rb.minBoostedCp,
        maxBoostedCp: rb.maxBoostedCp,
        possibleShiny: rb.possibleShiny,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(raidBoss).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.raidBossWeatherBoosts.map((rw) => ({ tier: rw.tier, formSlug: rw.formSlug, weather: rw.weather })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(raidBossWeatherBoost).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.communityDays.map((cd) => ({ number: cd.number, startDate: cd.startDate, endDate: cd.endDate })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(communityDay).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.communityDayBonuses.map((cdb) => ({ communityDayNumber: cdb.communityDayNumber, bonus: cdb.bonus })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(communityDayBonus).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.communityDaySpecies.map((cds) => ({
        communityDayNumber: cds.communityDayNumber,
        speciesSlug: cds.speciesSlug,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(communityDaySpecies).values(rows).run();
    }
    for (const rows of chunk(
      referenceData.communityDayEventMoves.map((cdm) => ({
        communityDayNumber: cdm.communityDayNumber,
        speciesSlug: cdm.speciesSlug,
        moveSlug: cdm.moveSlug,
      })),
      INSERT_CHUNK_SIZE,
    )) {
      await drizzleDb.insert(communityDayEventMove).values(rows).run();
    }

    await db.run(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [VERSION_SETTING_KEY, newVersion],
      false,
    );

    await db.commitTransaction();
  } catch (err) {
    await db.rollbackTransaction();
    throw err;
  }
}
