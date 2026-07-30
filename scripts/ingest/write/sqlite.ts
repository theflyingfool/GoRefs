// Materializes reference.sqlite at the repo root: the real ingested
// reference data (all of ReferenceData, reference tables only — no personal
// tables, no demo seed) as an actual queryable SQLite file, for opening in
// DB Browser for SQLite / the sqlite3 CLI / `npx drizzle-kit studio` /
// whatever. Modeled on scripts/build-dummy-db.ts's DatabaseSync +
// REFERENCE_SCHEMA_SQL approach, minus that script's personal-table demo
// overlay (src/data/personal-demo-seed.ts) — see that file for the variant
// that also seeds fake personal-table data.
//
// Gitignored (regeneratable from src/data/reference.json on every ingest
// run) — see .gitignore next to the pre-existing dummy.sqlite entry.

import { DatabaseSync } from "node:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import { REFERENCE_SCHEMA_SQL } from "../../../src/db/schema";
import type { ReferenceData } from "../../../src/db/reference-data";

export const REFERENCE_SQLITE_OUT = resolve(process.cwd(), "reference.sqlite");

const b = (value: boolean) => (value ? 1 : 0);

function insertAll<T extends object>(db: DatabaseSync, table: string, columns: string[], rows: T[]): void {
  if (rows.length === 0) return;
  const placeholders = columns.map((c) => `@${c}`).join(", ");
  const stmt = db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
  for (const row of rows) {
    try {
      stmt.run(row as never);
    } catch (err) {
      console.error(`Failed inserting into ${table}:`, row);
      throw err;
    }
  }
}

// `outPath` defaults to the real repo-root REFERENCE_SQLITE_OUT (what
// `npm run ingest`'s sqlite step always uses) — tests override it with a
// scratch path so they don't clobber a developer's real reference.sqlite.
export function writeReferenceSqlite(referenceData: ReferenceData, outPath: string = REFERENCE_SQLITE_OUT): string {
  if (existsSync(outPath)) unlinkSync(outPath);

  const db = new DatabaseSync(outPath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);

  // Every insertAll below runs as one transaction, not autocommit-per-statement
  // -- node:sqlite's default autocommit mode fsyncs on every single INSERT,
  // which turned inserting ~2,700 form rows alone into several seconds of
  // wall time (and the full dataset, several minutes) the first time this
  // was measured. One BEGIN/COMMIT around the whole load makes this a
  // sub-second operation regardless of underlying disk latency.
  db.exec("BEGIN;");
  try {
    const { regions, types, backgrounds, species, forms, formTypes, megaVariants } = referenceData;

    insertAll(db, "regions", ["slug", "name"], regions);
    insertAll(db, "types", ["slug", "name"], types);
    insertAll(db, "backgrounds", ["slug", "name"], backgrounds);

    insertAll(
      db,
      "species",
      ["slug", "dex_number", "name", "family_slug", "gen", "rarity", "region_slug", "has_male", "has_female", "can_mega_evolve", "can_gigantamax"],
      species.map((s) => ({
        slug: s.slug,
        dex_number: s.dexNumber,
        name: s.name,
        family_slug: s.familySlug,
        gen: s.gen,
        rarity: s.rarity,
        region_slug: s.regionSlug,
        has_male: b(s.hasMale),
        has_female: b(s.hasFemale),
        can_mega_evolve: b(s.canMegaEvolve),
        can_gigantamax: b(s.canGigantamax),
      })),
    );

    insertAll(
      db,
      "form",
      [
        "slug",
        "species_slug",
        "form_name",
        "costume_name",
        "gender",
        "evolves",
        "shiny_available",
        "shiny_released_at",
        "shadow_available",
        "dynamax_available",
        "regional_exclusive",
        "image_ref",
      ],
      forms.map((f) => ({
        slug: f.slug,
        species_slug: f.speciesSlug,
        form_name: f.formName,
        costume_name: f.costumeName,
        gender: f.gender,
        evolves: b(f.evolves),
        shiny_available: b(f.shinyAvailable),
        shiny_released_at: f.shinyReleasedAt ?? null,
        shadow_available: b(f.shadowAvailable),
        dynamax_available: b(f.dynamaxAvailable),
        regional_exclusive: b(f.regionalExclusive),
        image_ref: f.imageRef,
      })),
    );

    insertAll(
      db,
      "form_types",
      ["form_slug", "type_slug"],
      formTypes.map((ft) => ({ form_slug: ft.formSlug, type_slug: ft.typeSlug })),
    );

    insertAll(
      db,
      "mega_variant",
      ["slug", "species_slug", "variant"],
      megaVariants.map((m) => ({ slug: m.slug, species_slug: m.speciesSlug, variant: m.variant })),
    );

    insertAll(
      db,
      "move",
      ["slug", "name", "category", "type_slug", "power", "energy_delta", "duration_ms", "pvp_power", "pvp_energy_delta", "pvp_turns"],
      referenceData.moves.map((m) => ({
        slug: m.slug,
        name: m.name,
        category: m.category,
        type_slug: m.typeSlug,
        power: m.power,
        energy_delta: m.energyDelta,
        duration_ms: m.durationMs,
        pvp_power: m.pvpPower,
        pvp_energy_delta: m.pvpEnergyDelta,
        pvp_turns: m.pvpTurns,
      })),
    );

    insertAll(
      db,
      "form_move",
      ["form_slug", "move_slug", "is_elite"],
      referenceData.formMoves.map((fm) => ({ form_slug: fm.formSlug, move_slug: fm.moveSlug, is_elite: b(fm.isElite) })),
    );

    insertAll(
      db,
      "species_evolution",
      ["from_species_slug", "to_species_slug", "candy_required", "item_required"],
      referenceData.speciesEvolutions.map((se) => ({
        from_species_slug: se.fromSpeciesSlug,
        to_species_slug: se.toSpeciesSlug,
        candy_required: se.candyRequired,
        item_required: se.itemRequired,
      })),
    );

    insertAll(
      db,
      "type_effectiveness",
      ["attacking_type_slug", "defending_type_slug", "multiplier"],
      referenceData.typeEffectiveness.map((te) => ({
        attacking_type_slug: te.attackingTypeSlug,
        defending_type_slug: te.defendingTypeSlug,
        multiplier: te.multiplier,
      })),
    );

    insertAll(
      db,
      "weather_boost",
      ["weather", "type_slug"],
      referenceData.weatherBoosts.map((wb) => ({ weather: wb.weather, type_slug: wb.typeSlug })),
    );

    insertAll(
      db,
      "player_level",
      ["level", "cumulative_xp"],
      referenceData.playerLevels.map((pl) => ({ level: pl.level, cumulative_xp: pl.cumulativeXp })),
    );

    insertAll(
      db,
      "player_level_reward",
      ["level", "sort_order", "item_name", "amount"],
      referenceData.playerLevelRewards.map((plr) => ({ level: plr.level, sort_order: plr.sortOrder, item_name: plr.itemName, amount: plr.amount })),
    );

    insertAll(
      db,
      "medal",
      ["slug", "name", "description", "is_event_medal"],
      referenceData.medals.map((m) => ({ slug: m.slug, name: m.name, description: m.description, is_event_medal: b(m.isEventMedal) })),
    );

    insertAll(
      db,
      "medal_tier",
      ["medal_slug", "rank", "target"],
      referenceData.medalTiers.map((mt) => ({ medal_slug: mt.medalSlug, rank: mt.rank, target: mt.target })),
    );

    insertAll(
      db,
      "friendship_level",
      ["level", "name", "points_required", "xp_reward", "attack_bonus", "trading_discount", "raid_ball_bonus"],
      referenceData.friendshipLevels.map((fl) => ({
        level: fl.level,
        name: fl.name,
        points_required: fl.pointsRequired,
        xp_reward: fl.xpReward,
        attack_bonus: fl.attackBonus,
        trading_discount: fl.tradingDiscount,
        raid_ball_bonus: fl.raidBallBonus,
      })),
    );

    insertAll(
      db,
      "pvp_rank_reward",
      ["league_rank", "track", "sort_order", "reward_type", "item_name", "amount"],
      referenceData.pvpRankRewards.map((prr) => ({
        league_rank: prr.leagueRank,
        track: prr.track,
        sort_order: prr.sortOrder,
        reward_type: prr.rewardType,
        item_name: prr.itemName,
        amount: prr.amount,
      })),
    );

    insertAll(
      db,
      "pvp_rank_requirement",
      ["rank", "additional_battles_required", "additional_battle_wins_required"],
      referenceData.pvpRankRequirements.map((prr) => ({
        rank: prr.rank,
        additional_battles_required: prr.additionalBattlesRequired,
        additional_battle_wins_required: prr.additionalBattleWinsRequired,
      })),
    );

    insertAll(
      db,
      "raid_boss",
      ["tier", "form_slug", "min_cp", "max_cp", "min_boosted_cp", "max_boosted_cp", "possible_shiny"],
      referenceData.raidBosses.map((rb) => ({
        tier: rb.tier,
        form_slug: rb.formSlug,
        min_cp: rb.minCp,
        max_cp: rb.maxCp,
        min_boosted_cp: rb.minBoostedCp,
        max_boosted_cp: rb.maxBoostedCp,
        possible_shiny: b(rb.possibleShiny),
      })),
    );

    insertAll(
      db,
      "raid_boss_weather_boost",
      ["tier", "form_slug", "weather"],
      referenceData.raidBossWeatherBoosts.map((rbwb) => ({ tier: rbwb.tier, form_slug: rbwb.formSlug, weather: rbwb.weather })),
    );

    insertAll(
      db,
      "community_day",
      ["number", "start_date", "end_date"],
      referenceData.communityDays.map((cd) => ({ number: cd.number, start_date: cd.startDate, end_date: cd.endDate })),
    );

    insertAll(
      db,
      "community_day_bonus",
      ["community_day_number", "bonus"],
      referenceData.communityDayBonuses.map((cdb) => ({ community_day_number: cdb.communityDayNumber, bonus: cdb.bonus })),
    );

    insertAll(
      db,
      "community_day_species",
      ["community_day_number", "species_slug"],
      referenceData.communityDaySpecies.map((cds) => ({ community_day_number: cds.communityDayNumber, species_slug: cds.speciesSlug })),
    );

    insertAll(
      db,
      "community_day_event_move",
      ["community_day_number", "species_slug", "move_slug"],
      referenceData.communityDayEventMoves.map((cdem) => ({
        community_day_number: cdem.communityDayNumber,
        species_slug: cdem.speciesSlug,
        move_slug: cdem.moveSlug,
      })),
    );

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  } finally {
    db.close();
  }

  return outPath;
}
