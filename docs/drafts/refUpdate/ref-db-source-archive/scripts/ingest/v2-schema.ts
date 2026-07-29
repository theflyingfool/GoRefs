// V2 Tier-1 reference schema — the new tables from docs/v2-schema-design.md
// §2, for categories neither our current schema nor ingestion pipeline
// covers at all (moves, evolutions, type effectiveness/weather, player
// progression, PvP, raids, events). Deliberately NOT an ALTER of any
// existing table (species/form/mega_variant) — the owner's call: extending
// existing tables couples this work to the legacy ingestion pipeline
// (build-reference.ts et al.), which is exactly what a clean set of new
// tables avoids. These reference the existing `species`/`form` tables
// (REFERENCE_SCHEMA_SQL, src/db/schema.ts) by slug, unmodified.
//
// Not wired into the real app yet — same "validation, not cutover" status
// as the rest of the V2 ingestion spike. Built into a real SQLite file by
// v2-build-extended.ts so it can be opened and queried like any other
// database, not just read as JSON.

export const V2_EXTENDED_SCHEMA_SQL = `
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

CREATE TABLE IF NOT EXISTS player_level (
  level INTEGER PRIMARY KEY,
  cumulative_xp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS player_level_reward (
  level INTEGER NOT NULL REFERENCES player_level(level),
  sort_order INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (level, sort_order)
);

-- pogoapi.net's "badges" — named medal here, not badge, to avoid colliding
-- with the unrelated Gym Badge Tracker roadmap item (gym-visit badges, a
-- different in-game concept).
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
