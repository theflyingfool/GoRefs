// Mirrors the schema proposed in CLAUDE.md, plus additions agreed with the
// user along the way:
// - Species.canGigantamax, and AppSetting (personal UI-state table).
//   Gigantamax was originally modeled as a per-form availability flag
//   (Form.gigantamaxAvailable), but the user confirmed Gigantamax Pokémon
//   are genuine distinct catchable forms — structurally like costumes, not
//   like Mega — so it's now a species-wide capability flag (mirroring
//   canMegaEvolve) plus dedicated "Gigantamax" `form` rows, rather than a
//   boolean on every existing form.
// - Form.shiny/luckyShiny/shadowShiny — CLAUDE.md's sketch had
//   dynamaxShiny/luckyDynamaxShiny but no plain shiny flag for the
//   base/lucky/shadow branches, even though the user's old Obsidian vault
//   treated "shiny" as its own tag independent of 4-star/floor-IV. Added
//   for consistency across all five branches.
// - FormBackgroundPersonal.achievementField — a background can be linked to
//   any specific tracked variant of a form (caught, lucky, shiny, shadow,
//   ...), not just "the form" generically, since those variants represent
//   distinct individually-owned Pokémon that can carry different
//   backgrounds. Always optional — no row means no background recorded.
// species.xxlAvailable/xxsAvailable were considered and dropped: XXL/XXS
// are always obtainable for any species in-game, so there's nothing to
// gate; only the personal "have I gotten one" fact
// (SpeciesPersonal.xxl/xxs) is meaningful.

export type Rarity = "standard" | "legendary" | "mythical" | "ultra_beast";
export type Gender = "male" | "female" | "unknown";
export type MegaVariantKind = "X" | "Y" | "Primal" | null;

// ---- Reference tables (replaceable wholesale, keyed by permanent slug) ----

export interface Region {
  slug: string;
  name: string;
}

export interface PokemonType {
  slug: string;
  name: string;
}

export interface Background {
  slug: string;
  name: string;
}

export interface Species {
  slug: string;
  dexNumber: number;
  name: string;
  familySlug: string;
  gen: number;
  rarity: Rarity;
  regionSlug: string;
  hasMale: boolean;
  hasFemale: boolean;
  canMegaEvolve: boolean;
  canGigantamax: boolean;
}

export interface Form {
  slug: string;
  speciesSlug: string;
  formName: string;
  costumeName: string | null;
  gender: Gender;
  evolves: boolean;
  shinyAvailable: boolean;
  shadowAvailable: boolean;
  dynamaxAvailable: boolean;
  regionalExclusive: boolean;
  imageRef: string | null;
}

export interface FormType {
  formSlug: string;
  typeSlug: string;
}

export interface MegaVariant {
  slug: string;
  speciesSlug: string;
  variant: MegaVariantKind;
}

export type MoveCategory = "fast" | "charged";

export interface Move {
  slug: string;
  name: string;
  category: MoveCategory;
  typeSlug: string;
  power: number | null;
  energyDelta: number | null;
  durationMs: number | null;
  pvpPower: number | null;
  pvpEnergyDelta: number | null;
  pvpTurns: number | null;
}

export interface FormMove {
  formSlug: string;
  moveSlug: string;
  isElite: boolean;
}

export interface SpeciesEvolution {
  fromSpeciesSlug: string;
  toSpeciesSlug: string;
  candyRequired: number | null;
  itemRequired: string | null;
}

export interface TypeEffectiveness {
  attackingTypeSlug: string;
  defendingTypeSlug: string;
  multiplier: number;
}

export interface WeatherBoost {
  weather: string;
  typeSlug: string;
}

export interface PlayerLevel {
  level: number;
  /** Null for levels beyond what any ingestion source publishes (currently 51-80) -- see schema.ts's player_level DDL comment. */
  cumulativeXp: number | null;
}

export interface PlayerLevelReward {
  level: number;
  sortOrder: number;
  itemName: string;
  amount: number;
}

// pogoapi.net's "badges" — named `medal` here, not `badge`, to avoid
// colliding with the unrelated Gym Badge Tracker roadmap item (gym-visit
// badges, a different in-game concept entirely).
export interface Medal {
  slug: string;
  name: string;
  description: string;
  isEventMedal: boolean;
}

export interface MedalTier {
  medalSlug: string;
  rank: number;
  target: number | null;
}

export interface FriendshipLevel {
  level: number;
  name: string;
  pointsRequired: number;
  xpReward: number;
  attackBonus: number;
  tradingDiscount: number;
  raidBallBonus: number;
}

export type PvpTrack = "free" | "premium";

export interface PvpRankReward {
  leagueRank: number;
  track: PvpTrack;
  sortOrder: number;
  rewardType: string;
  itemName: string | null;
  amount: number | null;
}

export interface PvpRankRequirement {
  rank: number;
  additionalBattlesRequired: number | null;
  additionalBattleWinsRequired: number | null;
}

// "Current rotation" snapshot data, same wholesale-replace-on-sync model as
// other reference tables — just refreshed more often in practice.
export interface RaidBoss {
  tier: string;
  formSlug: string;
  minCp: number;
  maxCp: number;
  minBoostedCp: number;
  maxBoostedCp: number;
  possibleShiny: boolean;
}

export interface RaidBossWeatherBoost {
  tier: string;
  formSlug: string;
  weather: string;
}

export interface CommunityDay {
  number: number;
  startDate: string;
  endDate: string;
}

export interface CommunityDayBonus {
  communityDayNumber: number;
  bonus: string;
}

export interface CommunityDaySpecies {
  communityDayNumber: number;
  speciesSlug: string;
}

export interface CommunityDayEventMove {
  communityDayNumber: number;
  speciesSlug: string;
  moveSlug: string;
}

// ---- Personal tables (never touched by reference updates) ----

export interface AppSetting {
  key: string;
  value: string;
}

export interface SpeciesPersonal {
  speciesSlug: string;
  registered: boolean;
  xxl: boolean;
  xxs: boolean;
  purified: boolean;
  /** Last write to this row, any field — the merge-on-import unit (see importPersonalData): the whole row is kept-or-replaced together, not field by field. Epoch milliseconds (Date.now()), not an ISO string — matches the INTEGER column this is stored in. */
  updatedAt: number;
}

export interface FormPersonal {
  formSlug: string;

  caught: boolean;
  shiny: boolean;
  floor: boolean;
  fourStar: boolean;
  shundo: boolean;

  lucky: boolean;
  luckyShiny: boolean;
  luckyFloor: boolean;
  luckyFourStar: boolean;
  luckyShundo: boolean;

  shadow: boolean;
  shadowShiny: boolean;
  shadowFloor: boolean;
  shadowFourStar: boolean;
  shadowShundo: boolean;

  dynamax: boolean;
  dynamaxFloor: boolean;
  dynamaxShiny: boolean;
  dynamaxFourStar: boolean;
  dynamaxShundo: boolean;

  luckyDynamax: boolean;
  luckyDynamaxFloor: boolean;
  luckyDynamaxShiny: boolean;
  luckyDynamaxFourStar: boolean;
  luckyDynamaxShundo: boolean;

  bestShiny: string | null;
  bestNonShiny: string | null;
  bestLucky: string | null;

  /** Last write to this row, any field — the merge-on-import unit (see importPersonalData): the whole row is kept-or-replaced together, not field by field. Epoch milliseconds, not an ISO string. */
  updatedAt: number;
}

// Every independently-ownable variant of a form — used both to drive the
// data-entry toggle grid and as the set of things a background can be
// linked to (see FormBackgroundPersonal below).
export const FORM_PERSONAL_BOOLEAN_FIELDS = [
  "caught",
  "shiny",
  "floor",
  "fourStar",
  "shundo",
  "lucky",
  "luckyShiny",
  "luckyFloor",
  "luckyFourStar",
  "luckyShundo",
  "shadow",
  "shadowShiny",
  "shadowFloor",
  "shadowFourStar",
  "shadowShundo",
  "dynamax",
  "dynamaxFloor",
  "dynamaxShiny",
  "dynamaxFourStar",
  "dynamaxShundo",
  "luckyDynamax",
  "luckyDynamaxFloor",
  "luckyDynamaxShiny",
  "luckyDynamaxFourStar",
  "luckyDynamaxShundo",
] as const satisfies readonly (keyof FormPersonal)[];

export type FormPersonalBooleanField = (typeof FORM_PERSONAL_BOOLEAN_FIELDS)[number];

// camelCase TS field name -> snake_case SQL column name, so the two never
// drift apart and so form_background_personal.achievement_field can store
// the same identifier the DB column uses.
export const FORM_PERSONAL_FIELD_COLUMNS: Record<FormPersonalBooleanField, string> = {
  caught: "caught",
  shiny: "shiny",
  floor: "floor",
  fourStar: "four_star",
  shundo: "shundo",
  lucky: "lucky",
  luckyShiny: "lucky_shiny",
  luckyFloor: "lucky_floor",
  luckyFourStar: "lucky_four_star",
  luckyShundo: "lucky_shundo",
  shadow: "shadow",
  shadowShiny: "shadow_shiny",
  shadowFloor: "shadow_floor",
  shadowFourStar: "shadow_four_star",
  shadowShundo: "shadow_shundo",
  dynamax: "dynamax",
  dynamaxFloor: "dynamax_floor",
  dynamaxShiny: "dynamax_shiny",
  dynamaxFourStar: "dynamax_four_star",
  dynamaxShundo: "dynamax_shundo",
  luckyDynamax: "lucky_dynamax",
  luckyDynamaxFloor: "lucky_dynamax_floor",
  luckyDynamaxShiny: "lucky_dynamax_shiny",
  luckyDynamaxFourStar: "lucky_dynamax_four_star",
  luckyDynamaxShundo: "lucky_dynamax_shundo",
};

export interface FormBackgroundPersonal {
  formSlug: string;
  achievementField: FormPersonalBooleanField;
  backgroundSlug: string;
  /** When this link was added — the composite PK has no "value" to compare on merge (a row either exists or doesn't), so this is informational, not a merge tiebreaker. Epoch milliseconds, not an ISO string. */
  updatedAt: number;
}

export interface MegaPersonal {
  megaVariantSlug: string;
  evolved: boolean;
  shinyEvolved: boolean;
  /** Last write to this row, any field — the merge-on-import unit (see importPersonalData): the whole row is kept-or-replaced together, not field by field. Epoch milliseconds, not an ISO string. */
  updatedAt: number;
}

// ---- Local trainer profile (not an auth account — see schema.ts) ----

export interface Profile {
  id: number;
  username: string;
  friendCode: string | null;
  createdAt: number;
}

export type PokemonInstanceStatus = "kept" | "traded" | "released" | "evolved";

// Individual caught-specimen log — see schema.ts's pokemon_instance comment
// for why this exists alongside FormPersonal's achievement flags rather
// than replacing them. Everything but the identity/bookkeeping fields is
// nullable on purpose (fast bulk-add of low-value catches).
export interface PokemonInstance {
  id: number;
  formSlug: string;
  profileId: number;
  status: PokemonInstanceStatus;
  recordedAt: number;
  caughtAt: number | null;
  updatedAt: number;
  cp: number | null;
  ivAttack: number | null;
  ivDefense: number | null;
  ivStamina: number | null;
  /** Derived from ivAttack/ivDefense/ivStamina by a SQL GENERATED column -- never write this directly. See computeIvPercent below for the JS-side mirror used before a DB round-trip is possible. */
  ivPercent: number | null;
  shiny: boolean;
  lucky: boolean;
  shadow: boolean;
  purified: boolean;
  dynamax: boolean;
  receivedViaTrade: boolean;
  heartsEarned: number | null;
  /** Mega Level is per-individual, not species-wide — confirmed directly (two caught Charizard can sit at different Mega Levels), so this lives here rather than on MegaPersonal. Only meaningful once this individual has actually been Mega Evolved. */
  currentMegaLevel: number | null;
  nickname: string | null;
  backgroundSlug: string | null;
}

/** Mirrors pokemon_instance.iv_percent's SQL GENERATED expression exactly (schema/personal.ts) -- used wherever a value is needed before an actual DB round-trip (the in-memory cache after an insert, and the Log-a-catch live preview). */
export function computeIvPercent(ivAttack: number | null, ivDefense: number | null, ivStamina: number | null): number | null {
  if (ivAttack === null || ivDefense === null || ivStamina === null) return null;
  return Math.round(((ivAttack + ivDefense + ivStamina) * 100) / 45 * 10) / 10;
}

export interface Tag {
  id: number;
  profileId: number;
  name: string;
}

export interface PokemonInstanceTag {
  pokemonInstanceId: number;
  tagId: number;
}

// Max Move levels are per-individual too (same correction as
// PokemonInstance.currentMegaLevel), so this is keyed by pokemonInstanceId,
// not a form/species slug. move_slot is a provisional identifier — see
// schema.ts's pokemon_instance_max_move comment on why the exact Max Move
// mechanic isn't fully modeled yet.
export interface PokemonInstanceMaxMove {
  pokemonInstanceId: number;
  moveSlot: string;
  level: number | null;
  updatedAt: number;
}

export interface PlayerProgressPersonal {
  profileId: number;
  currentLevel: number | null;
  totalXp: number | null;
  updatedAt: number;
}

// One immutable snapshot per setPlayerProgress call (schema version 6) — an
// XP-over-time chart needs more than "current state", it needs "state at
// each point it changed".
export interface PlayerProgressLogEntry {
  id: number;
  profileId: number;
  recordedAt: number;
  currentLevel: number | null;
  totalXp: number | null;
}

// Tracks progress against the `medal`/`medal_tier` reference data (see
// schema.ts) — the reference tables model what medals exist and their tier
// targets; this is the per-profile "how far along am I" counterpart, one row
// per medal per profile.
export interface MedalProgressPersonal {
  medalSlug: string;
  profileId: number;
  currentRank: number;
  currentCount: number;
  updatedAt: number;
}

export const SPECIES_PERSONAL_BOOLEAN_FIELDS = [
  "registered",
  "xxl",
  "xxs",
  "purified",
] as const satisfies readonly (keyof SpeciesPersonal)[];
