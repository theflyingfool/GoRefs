// SQL DDL for GoBuddy's reference-table schema (personal tables' DDL moved
// to src/db/schema/personal.ts's Drizzle definitions — see
// docs/data-model.md's "Migration runner (Drizzle)" section). Consumed by
// scripts/build-dummy-db.ts and src/db/reference-sync.ts's wholesale
// drop/recreate. Column names are snake_case to match SQLite/dumping-tool
// conventions; src/db/types.ts holds the camelCase TS mirror used by
// application code for these reference tables.

export const REFERENCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS regions (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS types (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backgrounds (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS species (
  slug TEXT PRIMARY KEY,
  dex_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  family_slug TEXT NOT NULL,
  gen INTEGER NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('standard', 'legendary', 'mythical', 'ultra_beast')),
  region_slug TEXT NOT NULL REFERENCES regions(slug),
  has_male INTEGER NOT NULL CHECK (has_male IN (0, 1)),
  has_female INTEGER NOT NULL CHECK (has_female IN (0, 1)),
  can_mega_evolve INTEGER NOT NULL CHECK (can_mega_evolve IN (0, 1)),
  can_gigantamax INTEGER NOT NULL CHECK (can_gigantamax IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_species_region_slug ON species(region_slug);

CREATE TABLE IF NOT EXISTS form (
  slug TEXT PRIMARY KEY,
  species_slug TEXT NOT NULL REFERENCES species(slug),
  form_name TEXT NOT NULL,
  costume_name TEXT,
  gender TEXT NOT NULL CHECK (gender IN ('male', 'female', 'unknown')),
  evolves INTEGER NOT NULL CHECK (evolves IN (0, 1)),
  shiny_available INTEGER NOT NULL CHECK (shiny_available IN (0, 1)),
  shiny_released_at TEXT,
  shadow_available INTEGER NOT NULL CHECK (shadow_available IN (0, 1)),
  dynamax_available INTEGER NOT NULL CHECK (dynamax_available IN (0, 1)),
  regional_exclusive INTEGER NOT NULL CHECK (regional_exclusive IN (0, 1)),
  image_ref TEXT
);

-- completion-stats-sql.ts's per-lens queries correlate a subquery over the
-- form table for every species row in scope (region or global) — without
-- this, each of those subqueries does a full scan of every form row
-- (~8,000+) per species, which is what made the Stats page slow to load.
CREATE INDEX IF NOT EXISTS idx_form_species_slug ON form(species_slug);

CREATE TABLE IF NOT EXISTS form_types (
  form_slug TEXT NOT NULL REFERENCES form(slug),
  type_slug TEXT NOT NULL REFERENCES types(slug),
  PRIMARY KEY (form_slug, type_slug)
);

CREATE TABLE IF NOT EXISTS mega_variant (
  slug TEXT PRIMARY KEY,
  species_slug TEXT NOT NULL REFERENCES species(slug),
  variant TEXT CHECK (variant IN ('X', 'Y', 'Primal'))
);

CREATE TABLE IF NOT EXISTS move (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('fast', 'charged')),
  type_slug TEXT NOT NULL REFERENCES types(slug),
  power INTEGER,
  energy_delta INTEGER,
  duration_ms INTEGER,
  pvp_power INTEGER,
  pvp_energy_delta INTEGER,
  pvp_turns INTEGER
);

-- Which forms can learn which moves, and whether it's a legacy/Elite-TM
-- move for that form specifically. Sourced from pogoapi.net's "Normal" form
-- movesets only — its form vocabulary doesn't match our costume/region form
-- slugs, so costume-specific learnsets aren't modeled (base movesets don't
-- usually differ by costume in practice).
CREATE TABLE IF NOT EXISTS form_move (
  form_slug TEXT NOT NULL REFERENCES form(slug),
  move_slug TEXT NOT NULL REFERENCES move(slug),
  is_elite INTEGER NOT NULL DEFAULT 0 CHECK (is_elite IN (0, 1)),
  PRIMARY KEY (form_slug, move_slug)
);

CREATE TABLE IF NOT EXISTS species_evolution (
  from_species_slug TEXT NOT NULL REFERENCES species(slug),
  to_species_slug TEXT NOT NULL REFERENCES species(slug),
  candy_required INTEGER,
  item_required TEXT,
  PRIMARY KEY (from_species_slug, to_species_slug)
);

CREATE TABLE IF NOT EXISTS type_effectiveness (
  attacking_type_slug TEXT NOT NULL REFERENCES types(slug),
  defending_type_slug TEXT NOT NULL REFERENCES types(slug),
  multiplier REAL NOT NULL,
  PRIMARY KEY (attacking_type_slug, defending_type_slug)
);

CREATE TABLE IF NOT EXISTS weather_boost (
  weather TEXT NOT NULL,
  type_slug TEXT NOT NULL REFERENCES types(slug),
  PRIMARY KEY (weather, type_slug)
);

-- cumulative_xp is nullable: GAME_MASTER's playerLevel template now
-- publishes the full level-1-80 XP curve directly (see
-- scripts/ingest/transform/player-progression.ts's buildPlayerProgression),
-- so every level 1-80 row currently has a real figure -- nullable is kept as
-- a defensive fallback (not dead code) so player_progress_personal
-- .current_level's FK always has somewhere to point even if a future source
-- ever stops covering the full curve, with an honestly-absent XP figure
-- rather than a fabricated one.
CREATE TABLE IF NOT EXISTS player_level (
  level INTEGER PRIMARY KEY,
  cumulative_xp INTEGER
);

CREATE TABLE IF NOT EXISTS player_level_reward (
  level INTEGER NOT NULL REFERENCES player_level(level),
  sort_order INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (level, sort_order)
);

-- pogoapi.net's "badges" -- named medal here, not badge, to avoid colliding
-- with the unrelated Gym Badge Tracker roadmap item (gym-visit badges, a
-- different in-game concept entirely).
CREATE TABLE IF NOT EXISTS medal (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  is_event_medal INTEGER NOT NULL CHECK (is_event_medal IN (0, 1))
);

CREATE TABLE IF NOT EXISTS medal_tier (
  medal_slug TEXT NOT NULL REFERENCES medal(slug),
  rank INTEGER NOT NULL,
  target INTEGER,
  PRIMARY KEY (medal_slug, rank)
);

CREATE TABLE IF NOT EXISTS friendship_level (
  level INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  points_required INTEGER NOT NULL,
  xp_reward INTEGER NOT NULL,
  attack_bonus REAL NOT NULL,
  trading_discount REAL NOT NULL,
  raid_ball_bonus REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS pvp_rank_reward (
  league_rank INTEGER NOT NULL,
  track TEXT NOT NULL CHECK (track IN ('free', 'premium')),
  sort_order INTEGER NOT NULL,
  reward_type TEXT NOT NULL,
  item_name TEXT,
  amount INTEGER,
  PRIMARY KEY (league_rank, track, sort_order)
);

CREATE TABLE IF NOT EXISTS pvp_rank_requirement (
  rank INTEGER PRIMARY KEY,
  additional_battles_required INTEGER,
  additional_battle_wins_required INTEGER
);

-- "Current rotation" snapshot data, same wholesale-replace-on-sync model as
-- other reference tables — just refreshed more often in practice.
CREATE TABLE IF NOT EXISTS raid_boss (
  tier TEXT NOT NULL,
  form_slug TEXT NOT NULL REFERENCES form(slug),
  min_cp INTEGER NOT NULL,
  max_cp INTEGER NOT NULL,
  min_boosted_cp INTEGER NOT NULL,
  max_boosted_cp INTEGER NOT NULL,
  possible_shiny INTEGER NOT NULL CHECK (possible_shiny IN (0, 1)),
  PRIMARY KEY (tier, form_slug)
);

CREATE TABLE IF NOT EXISTS raid_boss_weather_boost (
  tier TEXT NOT NULL,
  form_slug TEXT NOT NULL,
  weather TEXT NOT NULL,
  PRIMARY KEY (tier, form_slug, weather),
  FOREIGN KEY (tier, form_slug) REFERENCES raid_boss(tier, form_slug)
);

CREATE TABLE IF NOT EXISTS community_day (
  number INTEGER PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_day_bonus (
  community_day_number INTEGER NOT NULL REFERENCES community_day(number),
  bonus TEXT NOT NULL,
  PRIMARY KEY (community_day_number, bonus)
);

CREATE TABLE IF NOT EXISTS community_day_species (
  community_day_number INTEGER NOT NULL REFERENCES community_day(number),
  species_slug TEXT NOT NULL REFERENCES species(slug),
  PRIMARY KEY (community_day_number, species_slug)
);

CREATE TABLE IF NOT EXISTS community_day_event_move (
  community_day_number INTEGER NOT NULL REFERENCES community_day(number),
  species_slug TEXT NOT NULL REFERENCES species(slug),
  move_slug TEXT NOT NULL REFERENCES move(slug),
  PRIMARY KEY (community_day_number, species_slug, move_slug)
);
`;

// Bumped 6 -> 7 for the Drizzle migration's timestamp format change: every
// personal-table timestamp column is now an INTEGER (epoch milliseconds)
// instead of a TEXT ISO-8601 string — a "column meaning changed" bump per
// docs/data-model.md's versioning policy, not a column add/remove. This
// constant no longer drives an on-device migration path (see
// src/db/migrations.ts, which migrates off Drizzle's own tracking table) —
// it's only compared against PersonalDataExport.schemaVersion on import, so
// an export from a pre-7 (ISO-string) build is detected rather than merged
// in silently corrupted (see personal-data-transfer.ts's readPersonalDataFile).
// Bumped 7 -> 8: pokemon_instance.iv_percent changed from a writable REAL
// column to a SQL GENERATED column derived from new iv_attack/iv_defense/
// iv_stamina columns (see docs/superpowers/specs/2026-07-24-sub-project-4-iv-entry-rework-design.md).
// A pre-8 export's ivPercent field is not carried forward on import -- the
// imported instance's IV fields land null until re-entered, since the
// export never had real component data to derive from either.
// Bumped 8 -> 9: pokemon_instance gains two new instance-level catch-source
// flags -- dynamax (this specimen came from a Max Battle, independent of
// form_personal.dynamax's "have I ever caught a Dynamaxed one of this form"
// achievement -- same relationship shiny already has to form_personal.shiny)
// and received_via_trade (this specimen's origin). See
// docs/superpowers/specs/2026-07-24-sub-project-5-collection-dex-tags-design.md.
// Bumped 10 -> 11: pokemon_instance gains uuid/original_trainer_name/
// original_trainer_id, status's 'released' renamed to 'transferred', tag
// uniqueness becomes device-wide, new referenced_trainer table (Sub-project 7b).
export const CURRENT_PERSONAL_SCHEMA_VERSION = 11;

export const DEFAULT_PROFILE_USERNAME = "Trainer";
