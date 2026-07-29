// V2 Tier-1 build: populates the new tables from docs/v2-schema-design.md
// §2 (scripts/ingest/v2-schema.ts) — moves, evolutions, type effectiveness/
// weather, player progression, PvP, raids, community days. Sourced entirely
// from pogoapi.net (everything except species/forms) plus the species/form
// slugs already produced by v2-build-reference.ts (for FK targets).
//
// Writes a real, queryable SQLite file:
// data-authoring/v2-explore/v2-extended.sqlite (REFERENCE_SCHEMA_SQL +
// V2_EXTENDED_SCHEMA_SQL, populated). Not wired into the real app — same
// validation-pass status as the rest of the V2 spike.
//
// Requires: npm run ingest:v2:fetch && npm run ingest:v2:build first.
// Run with: npm run ingest:v2:build-extended

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { CACHE_V2_ROOT } from "./v2-http-cache";
import { slugify } from "./slug";
import { REFERENCE_SCHEMA_SQL } from "../../src/db/schema";
import { V2_EXTENDED_SCHEMA_SQL } from "./v2-schema";
import type { ReferenceData } from "../../src/db/reference-data";

const CANDIDATE_PATH = resolve(process.cwd(), "data-authoring/v2-explore/reference-v2-candidate.json");
const DB_PATH = resolve(process.cwd(), "data-authoring/v2-explore/v2-extended.sqlite");

function loadPogoapi<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(CACHE_V2_ROOT, "pogoapi", `${name}.json`), "utf-8")) as T;
}

function loadPgapi<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(CACHE_V2_ROOT, "pgapi", `${name}.json`), "utf-8")) as T;
}

const b = (value: boolean) => (value ? 1 : 0);

function insertAll<T extends object>(db: DatabaseSync, table: string, columns: string[], rows: T[]) {
  if (rows.length === 0) return 0;
  const placeholders = columns.map((c) => `@${c}`).join(", ");
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`);
  let inserted = 0;
  for (const row of rows) {
    try {
      stmt.run(row as never);
      inserted++;
    } catch (err) {
      console.warn(`  [${table}] skipped a row: ${(err as Error).message}`);
    }
  }
  return inserted;
}

interface MoveRecord {
  move_id: number;
  name: string;
  power: number;
  energy_delta: number;
  duration: number;
  type: string;
  stamina_loss_scaler?: number;
}
interface PvpMoveRecord {
  move_id: number;
  power: number;
  energy_delta: number;
  turn_duration: number;
}

function buildMoves(db: DatabaseSync): Map<string, string> {
  const fast = loadPogoapi<MoveRecord[]>("fast_moves");
  const charged = loadPogoapi<MoveRecord[]>("charged_moves");
  const pvpFast = new Map(loadPogoapi<PvpMoveRecord[]>("pvp_fast_moves").map((m) => [m.move_id, m]));
  const pvpCharged = new Map(loadPogoapi<PvpMoveRecord[]>("pvp_charged_moves").map((m) => [m.move_id, m]));

  const slugByMoveId = new Map<string, string>(); // "fast:12" / "charged:12" -> slug
  const rows: Record<string, unknown>[] = [];

  for (const m of fast) {
    const slug = slugify(`${m.name}-fast`);
    const pvp = pvpFast.get(m.move_id);
    slugByMoveId.set(`fast:${m.move_id}`, slug);
    rows.push({
      slug, name: m.name, category: "fast", type_slug: slugify(m.type),
      power: m.power, energy_delta: m.energy_delta, duration_ms: m.duration,
      pvp_power: pvp?.power ?? null, pvp_energy_delta: pvp?.energy_delta ?? null, pvp_turns: pvp?.turn_duration ?? null,
    });
  }
  for (const m of charged) {
    const slug = slugify(`${m.name}-charged`);
    const pvp = pvpCharged.get(m.move_id);
    slugByMoveId.set(`charged:${m.move_id}`, slug);
    rows.push({
      slug, name: m.name, category: "charged", type_slug: slugify(m.type),
      power: m.power, energy_delta: m.energy_delta, duration_ms: m.duration,
      pvp_power: pvp?.power ?? null, pvp_energy_delta: pvp?.energy_delta ?? null, pvp_turns: pvp?.turn_duration ?? null,
    });
  }

  const inserted = insertAll(db, "move", ["slug", "name", "category", "type_slug", "power", "energy_delta", "duration_ms", "pvp_power", "pvp_energy_delta", "pvp_turns"], rows);
  console.log(`  move: ${inserted}/${rows.length}`);

  // slug lookup by move NAME (case-sensitive, as given) for form_move/
  // community_day_event_move, since those source files reference moves by
  // name, not move_id.
  const slugByName = new Map<string, string>();
  for (const m of fast) slugByName.set(m.name, slugify(`${m.name}-fast`));
  for (const m of charged) slugByName.set(m.name, slugify(`${m.name}-charged`));
  return slugByName;
}

interface EvolutionEntry {
  id: string;
  formId?: string;
  candies?: number;
  item?: { id: string } | null;
}
interface PokedexEntry {
  id: string;
  formId: string;
  dexNr: number;
  evolutions?: EvolutionEntry[];
}

interface SpeciesMovesRecord {
  pokemon_id: number;
  form: string;
  fast_moves: string[];
  charged_moves: string[];
  elite_fast_moves: string[];
  elite_charged_moves: string[];
}

// Only pogoapi.net's "Normal" form record per species — its `form` token
// vocabulary doesn't match our v2 (pokemon-go-api-sourced) form/costume
// slugs (the confirmed mismatch in docs/v2-data-source-findings.md §8), so
// there's no reliable way to apply this to costume-specific forms. Base/
// Standard-form move pools (the common case — movesets don't usually
// differ by costume in practice) are still worth having.
function buildFormMoves(db: DatabaseSync, moveSlugByName: Map<string, string>): void {
  const candidate: ReferenceData = JSON.parse(readFileSync(CANDIDATE_PATH, "utf-8"));
  const standardFormSlugsByDex = new Map<number, string[]>();
  for (const f of candidate.forms) {
    if (f.formName !== "Standard") continue;
    const species = candidate.species.find((s) => s.slug === f.speciesSlug);
    if (!species) continue;
    const list = standardFormSlugsByDex.get(species.dexNumber) ?? [];
    list.push(f.slug);
    standardFormSlugsByDex.set(species.dexNumber, list);
  }

  const records = loadPogoapi<SpeciesMovesRecord[]>("current_pokemon_moves");
  const rows: Record<string, unknown>[] = [];
  for (const rec of records) {
    if (rec.form !== "Normal") continue;
    const formSlugs = standardFormSlugsByDex.get(rec.pokemon_id);
    if (!formSlugs) continue;
    for (const formSlug of formSlugs) {
      for (const name of rec.fast_moves) {
        const moveSlug = moveSlugByName.get(name);
        if (moveSlug) rows.push({ form_slug: formSlug, move_slug: moveSlug, is_elite: 0 });
      }
      for (const name of rec.charged_moves) {
        const moveSlug = moveSlugByName.get(name);
        if (moveSlug) rows.push({ form_slug: formSlug, move_slug: moveSlug, is_elite: 0 });
      }
      for (const name of rec.elite_fast_moves) {
        const moveSlug = moveSlugByName.get(name);
        if (moveSlug) rows.push({ form_slug: formSlug, move_slug: moveSlug, is_elite: 1 });
      }
      for (const name of rec.elite_charged_moves) {
        const moveSlug = moveSlugByName.get(name);
        if (moveSlug) rows.push({ form_slug: formSlug, move_slug: moveSlug, is_elite: 1 });
      }
    }
  }
  console.log(`  form_move: ${insertAll(db, "form_move", ["form_slug", "move_slug", "is_elite"], rows)}/${rows.length}`);
}

function buildEvolutions(db: DatabaseSync): void {
  const pokedex = loadPgapi<PokedexEntry[]>("pokedex");
  const slugByDex = new Map<number, string>();
  const candidate: ReferenceData = JSON.parse(readFileSync(CANDIDATE_PATH, "utf-8"));
  for (const s of candidate.species) slugByDex.set(s.dexNumber, s.slug);

  const rows: Record<string, unknown>[] = [];
  for (const entry of pokedex) {
    const fromSlug = slugByDex.get(entry.dexNr);
    if (!fromSlug) continue;
    for (const evo of entry.evolutions ?? []) {
      const target = pokedex.find((e) => e.id === evo.id);
      const toSlug = target ? slugByDex.get(target.dexNr) : undefined;
      if (!toSlug) continue;
      rows.push({
        from_species_slug: fromSlug,
        to_species_slug: toSlug,
        candy_required: evo.candies ?? null,
        item_required: evo.item?.id ?? null,
      });
    }
  }
  const inserted = insertAll(db, "species_evolution", ["from_species_slug", "to_species_slug", "candy_required", "item_required"], rows);
  console.log(`  species_evolution: ${inserted}/${rows.length}`);
}

function buildTypeEffectivenessAndWeather(db: DatabaseSync): void {
  const typeEff = loadPogoapi<Record<string, Record<string, number>>>("type_effectiveness");
  const rows: Record<string, unknown>[] = [];
  for (const [attacking, row] of Object.entries(typeEff)) {
    for (const [defending, multiplier] of Object.entries(row)) {
      rows.push({ attacking_type_slug: slugify(attacking), defending_type_slug: slugify(defending), multiplier });
    }
  }
  const inserted = insertAll(db, "type_effectiveness", ["attacking_type_slug", "defending_type_slug", "multiplier"], rows);
  console.log(`  type_effectiveness: ${inserted}/${rows.length}`);

  const weather = loadPogoapi<Record<string, string[]>>("weather_boosts");
  const weatherRows: Record<string, unknown>[] = [];
  for (const [weatherName, types] of Object.entries(weather)) {
    for (const t of types) weatherRows.push({ weather: weatherName, type_slug: slugify(t) });
  }
  const weatherInserted = insertAll(db, "weather_boost", ["weather", "type_slug"], weatherRows);
  console.log(`  weather_boost: ${weatherInserted}/${weatherRows.length}`);
}

function buildPlayerProgression(db: DatabaseSync): void {
  const xpReq = loadPogoapi<Record<string, number>>("player_xp_requirements");
  const levelRows = Object.entries(xpReq).map(([level, xp]) => ({ level: Number(level), cumulative_xp: xp }));
  console.log(`  player_level: ${insertAll(db, "player_level", ["level", "cumulative_xp"], levelRows)}/${levelRows.length}`);

  interface LevelReward { level: number; items_received: { item: string; amount_received: number }[] }
  const rewards = loadPogoapi<LevelReward[]>("levelup_rewards");
  const rewardRows: Record<string, unknown>[] = [];
  for (const r of rewards) {
    r.items_received.forEach((item, i) => {
      rewardRows.push({ level: r.level, sort_order: i, item_name: item.item, amount: item.amount_received });
    });
  }
  console.log(`  player_level_reward: ${insertAll(db, "player_level_reward", ["level", "sort_order", "item_name", "amount"], rewardRows)}/${rewardRows.length}`);

  interface Badge { name: string; description: string; event_badge: boolean; rank?: number; targets?: number[] }
  const badges = loadPogoapi<Badge[]>("badges");
  const medalRows: Record<string, unknown>[] = [];
  const medalTierRows: Record<string, unknown>[] = [];
  const seenMedalSlugs = new Set<string>();
  for (const badge of badges) {
    const slug = slugify(badge.name);
    if (!seenMedalSlugs.has(slug)) {
      seenMedalSlugs.add(slug);
      medalRows.push({ slug, name: badge.name, description: badge.description, is_event_medal: b(badge.event_badge) });
    }
    if (badge.targets) {
      badge.targets.forEach((target, i) => {
        medalTierRows.push({ medal_slug: slug, rank: i + 1, target });
      });
    } else if (badge.rank !== undefined) {
      medalTierRows.push({ medal_slug: slug, rank: badge.rank, target: null });
    }
  }
  console.log(`  medal: ${insertAll(db, "medal", ["slug", "name", "description", "is_event_medal"], medalRows)}/${medalRows.length}`);
  console.log(`  medal_tier: ${insertAll(db, "medal_tier", ["medal_slug", "rank", "target"], medalTierRows)}/${medalTierRows.length}`);

  interface FriendshipLevel {
    friendship_level: number; name: string; friendship_points_required: number;
    xp_reward: number; attack_bonus: number; trading_discount: number; raid_ball_bonus: number;
  }
  const friendship = loadPogoapi<FriendshipLevel[]>("friendship_level_settings");
  const friendshipRows = friendship.map((f) => ({
    level: f.friendship_level, name: f.name, points_required: f.friendship_points_required,
    xp_reward: f.xp_reward, attack_bonus: f.attack_bonus, trading_discount: f.trading_discount, raid_ball_bonus: f.raid_ball_bonus,
  }));
  console.log(`  friendship_level: ${insertAll(db, "friendship_level", ["level", "name", "points_required", "xp_reward", "attack_bonus", "trading_discount", "raid_ball_bonus"], friendshipRows)}/${friendshipRows.length}`);
}

function buildPvp(db: DatabaseSync): void {
  interface RewardItem { type: string; amount?: number; item_name?: string }
  const leagueRewards = loadPogoapi<Record<string, { free: (RewardItem | null)[]; premium: (RewardItem | null)[] }>>("gobattle_league_rewards");
  const rows: Record<string, unknown>[] = [];
  for (const [rank, tracks] of Object.entries(leagueRewards)) {
    for (const track of ["free", "premium"] as const) {
      // A handful of slots (e.g. rank 5) are genuinely null in the source
      // data — no reward defined for that slot, not a parsing error.
      tracks[track].forEach((item, i) => {
        if (!item) return;
        rows.push({ league_rank: Number(rank), track, sort_order: i, reward_type: item.type, item_name: item.item_name ?? null, amount: item.amount ?? null });
      });
    }
  }
  console.log(`  pvp_rank_reward: ${insertAll(db, "pvp_rank_reward", ["league_rank", "track", "sort_order", "reward_type", "item_name", "amount"], rows)}/${rows.length}`);

  interface RankRequirement { rank: number; additional_battles_required?: number; additional_battle_wins_required?: number }
  const rankSettings = loadPogoapi<{ rank_requirements: RankRequirement[] }>("gobattle_ranking_settings");
  const rankRows = rankSettings.rank_requirements.map((r) => ({
    rank: r.rank, additional_battles_required: r.additional_battles_required ?? null, additional_battle_wins_required: r.additional_battle_wins_required ?? null,
  }));
  console.log(`  pvp_rank_requirement: ${insertAll(db, "pvp_rank_requirement", ["rank", "additional_battles_required", "additional_battle_wins_required"], rankRows)}/${rankRows.length}`);
}

interface RaidBossEntry {
  id: number; form: string | null; costume: string | null;
  min_unboosted_cp: number; max_unboosted_cp: number; min_boosted_cp: number; max_boosted_cp: number;
  possible_shiny: boolean; boosted_weather: string[]; tier: string | number;
}

function buildRaidsAndEvents(db: DatabaseSync, moveSlugByName: Map<string, string>): void {
  const candidate: ReferenceData = JSON.parse(readFileSync(CANDIDATE_PATH, "utf-8"));
  const formSlugByDex = new Map<number, string>(); // Standard form only, best-effort match
  for (const f of candidate.forms) {
    if (f.formName !== "Standard") continue;
    const species = candidate.species.find((s) => s.slug === f.speciesSlug);
    if (species && !formSlugByDex.has(species.dexNumber)) formSlugByDex.set(species.dexNumber, f.slug);
  }

  // Top-level shape is { current: { [tier]: RaidBossEntry[] }, previous: {...} }
  // — only "current" is a live rotation snapshot worth tracking here.
  const raidBosses = loadPogoapi<{ current: Record<string, RaidBossEntry[]> }>("raid_bosses");
  const raidRows: Record<string, unknown>[] = [];
  const weatherRows: Record<string, unknown>[] = [];
  for (const [tier, bosses] of Object.entries(raidBosses.current)) {
    if (!Array.isArray(bosses)) continue;
    for (const boss of bosses) {
      const formSlug = formSlugByDex.get(boss.id);
      if (!formSlug) continue; // species not in our candidate set (e.g. Basculegion-style gap)
      raidRows.push({
        tier: String(tier), form_slug: formSlug,
        min_cp: boss.min_unboosted_cp, max_cp: boss.max_unboosted_cp,
        min_boosted_cp: boss.min_boosted_cp, max_boosted_cp: boss.max_boosted_cp,
        possible_shiny: b(boss.possible_shiny),
      });
      for (const weather of boss.boosted_weather ?? []) {
        weatherRows.push({ tier: String(tier), form_slug: formSlug, weather });
      }
    }
  }
  console.log(`  raid_boss: ${insertAll(db, "raid_boss", ["tier", "form_slug", "min_cp", "max_cp", "min_boosted_cp", "max_boosted_cp", "possible_shiny"], raidRows)}/${raidRows.length}`);
  console.log(`  raid_boss_weather_boost: ${insertAll(db, "raid_boss_weather_boost", ["tier", "form_slug", "weather"], weatherRows)}/${weatherRows.length}`);

  const speciesSlugByName = new Map(candidate.species.map((s) => [s.name, s.slug]));
  function resolveSpeciesName(rawName: string): string | undefined {
    // pogoapi.net encodes some regional-form boosts as "Alola:::Geodude" —
    // the part after ::: is the species name; regional forms are still
    // rows of the same species in our schema, so matching the base name is
    // correct, not a workaround.
    const name = rawName.includes(":::") ? rawName.split(":::")[1] : rawName;
    return speciesSlugByName.get(name);
  }

  interface CommunityDay {
    community_day_number: number; start_date: string; end_date: string;
    bonuses: string[]; boosted_pokemon: string[];
    event_moves: { move: string; move_type: string; pokemon: string }[];
  }
  const communityDays = loadPogoapi<CommunityDay[]>("community_days");

  const cdRows = communityDays.map((cd) => ({ number: cd.community_day_number, start_date: cd.start_date, end_date: cd.end_date }));
  console.log(`  community_day: ${insertAll(db, "community_day", ["number", "start_date", "end_date"], cdRows)}/${cdRows.length}`);

  const bonusRows: Record<string, unknown>[] = [];
  const speciesRows: Record<string, unknown>[] = [];
  const eventMoveRows: Record<string, unknown>[] = [];
  for (const cd of communityDays) {
    for (const bonus of cd.bonuses) bonusRows.push({ community_day_number: cd.community_day_number, bonus });
    for (const rawName of cd.boosted_pokemon) {
      const slug = resolveSpeciesName(rawName);
      if (slug) speciesRows.push({ community_day_number: cd.community_day_number, species_slug: slug });
    }
    for (const em of cd.event_moves) {
      const speciesSlug = resolveSpeciesName(em.pokemon);
      const moveSlug = moveSlugByName.get(em.move);
      if (speciesSlug && moveSlug) eventMoveRows.push({ community_day_number: cd.community_day_number, species_slug: speciesSlug, move_slug: moveSlug });
    }
  }
  console.log(`  community_day_bonus: ${insertAll(db, "community_day_bonus", ["community_day_number", "bonus"], bonusRows)}/${bonusRows.length}`);
  console.log(`  community_day_species: ${insertAll(db, "community_day_species", ["community_day_number", "species_slug"], speciesRows)}/${speciesRows.length}`);
  console.log(`  community_day_event_move: ${insertAll(db, "community_day_event_move", ["community_day_number", "species_slug", "move_slug"], eventMoveRows)}/${eventMoveRows.length}`);
}

async function main() {
  if (!existsSync(CANDIDATE_PATH)) {
    console.error(`Missing ${CANDIDATE_PATH} — run "npm run ingest:v2:build" first.`);
    process.exit(1);
  }

  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA foreign_keys = OFF;"); // populated out of dependency order in places (moves before/after community days); integrity isn't the point of this pass
  db.exec(REFERENCE_SCHEMA_SQL);
  db.exec(V2_EXTENDED_SCHEMA_SQL);
  // Without an explicit transaction, node:sqlite commits (and fsyncs) after
  // every single INSERT — tens of thousands of individual commits took long
  // enough to look hung. One transaction around the whole population.
  db.exec("BEGIN TRANSACTION;");

  // Load the parity candidate's species/form/type/mega data into this DB
  // too, so the new tables' FKs actually resolve against something.
  const candidate: ReferenceData = JSON.parse(readFileSync(CANDIDATE_PATH, "utf-8"));
  insertAll(db, "regions", ["slug", "name"], candidate.regions);
  insertAll(db, "types", ["slug", "name"], candidate.types);
  insertAll(db, "backgrounds", ["slug", "name"], candidate.backgrounds);
  insertAll(
    db, "species",
    ["slug", "dex_number", "name", "family_slug", "gen", "rarity", "region_slug", "has_male", "has_female", "can_mega_evolve", "can_gigantamax"],
    candidate.species.map((s) => ({
      slug: s.slug, dex_number: s.dexNumber, name: s.name, family_slug: s.familySlug, gen: s.gen, rarity: s.rarity,
      region_slug: s.regionSlug, has_male: b(s.hasMale), has_female: b(s.hasFemale), can_mega_evolve: b(s.canMegaEvolve), can_gigantamax: b(s.canGigantamax),
    })),
  );
  insertAll(
    db, "form",
    ["slug", "species_slug", "form_name", "costume_name", "gender", "evolves", "shiny_available", "shadow_available", "dynamax_available", "regional_exclusive", "image_ref"],
    candidate.forms.map((f) => ({
      slug: f.slug, species_slug: f.speciesSlug, form_name: f.formName, costume_name: f.costumeName, gender: f.gender,
      evolves: b(f.evolves), shiny_available: b(f.shinyAvailable), shadow_available: b(f.shadowAvailable),
      dynamax_available: b(f.dynamaxAvailable), regional_exclusive: b(f.regionalExclusive), image_ref: f.imageRef,
    })),
  );
  insertAll(
    db, "mega_variant", ["slug", "species_slug", "variant"],
    candidate.megaVariants.map((m) => ({ slug: m.slug, species_slug: m.speciesSlug, variant: m.variant })),
  );
  insertAll(db, "form_types", ["form_slug", "type_slug"], candidate.formTypes.map((ft) => ({ form_slug: ft.formSlug, type_slug: ft.typeSlug })));

  console.log("Building V2 extended tables...");
  buildTypeEffectivenessAndWeather(db);
  buildPlayerProgression(db);
  buildPvp(db);
  buildEvolutions(db);
  const moveSlugByName = buildMoves(db);
  buildFormMoves(db, moveSlugByName);
  buildRaidsAndEvents(db, moveSlugByName);

  db.exec("COMMIT;");
  db.close();
  console.log(`\nDone: ${DB_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
