// Indexed access to a raw GAME_MASTER dump — replaces ad-hoc GAME_MASTER
// parsing for every later ingestion task.
//
// Raw shape: a flat JSON array of `{ templateId, data }` (~18.7k entries in
// the real dump). `templateId` is a unique-per-record string — it is NOT a
// grouping key. Almost every entry's `data` object carries exactly one key
// besides `data.templateId` itself; that key is the *category*
// ("pokemonSettings", "moveSettings", ...). This module buckets entries by
// that category, then builds a secondary per-category lookup keyed by
// whatever field(s) that category actually uses as its natural id — those
// fields are not uniform across categories (see the per-category comments
// below, confirmed against a real ~18.7k-entry GAME_MASTER.json).

export interface GameMasterEntry {
  templateId: string;
  data?: Record<string, unknown>;
}

// --- Per-category record shapes -------------------------------------------
// Deliberately narrow: only the fields this pipeline reads. Every record
// also carries a `templateId` (from `data.templateId`) for traceability and,
// for the categories with no better natural key, as the lookup key itself.

export interface PokemonSettingsRecord {
  templateId: string;
  pokemonId: string;
  form?: string;
  [key: string]: unknown;
}

export interface FormSettingsRecord {
  templateId: string;
  pokemon: string;
  forms?: unknown[];
  [key: string]: unknown;
}

export interface GenderSettingsRecord {
  templateId: string;
  pokemon: string;
  gender?: { malePercent?: number; femalePercent?: number };
  [key: string]: unknown;
}

export interface MoveSettingsRecord {
  templateId: string;
  movementId: string;
  [key: string]: unknown;
}

export interface CombatMoveRecord {
  templateId: string;
  uniqueId: string;
  [key: string]: unknown;
}

export interface TypeEffectiveRecord {
  templateId: string;
  attackType: string;
  attackScalar?: number[];
  [key: string]: unknown;
}

export interface WeatherAffinityRecord {
  templateId: string;
  weatherCondition: string;
  pokemonType?: string[];
  [key: string]: unknown;
}

// playerLevel is a GAME_MASTER singleton (one record total) carrying the
// full level-1-80 curve as parallel arrays (index 0 = level 1) — confirmed
// against the real dump: requiredExperience.length === cpMultiplier.length
// === 80, i.e. the game currently publishes the full level-80 curve, not a
// truncated one. A later task explodes these parallel arrays into per-level
// PlayerLevel rows; this module hands back the raw settings object as-is.
export interface PlayerLevelSettingsRecord {
  templateId: string;
  requiredExperience: number[];
  cpMultiplier: number[];
  [key: string]: unknown;
}

export interface LevelUpRewardsRecord {
  templateId: string;
  level: number;
  items?: string[];
  itemsCount?: number[];
  [key: string]: unknown;
}

export interface BadgeSettingsRecord {
  templateId: string;
  badgeType: string;
  [key: string]: unknown;
}

// No level/tier number lives in the data itself (e.g. "FRIENDSHIP_LEVEL_2"
// carries no numeric field) — templateId is the only reliable natural key.
export interface FriendshipMilestoneSettingsRecord {
  templateId: string;
  milestoneXpReward?: number;
  [key: string]: unknown;
}

// combatLeague's `title` field looks like a natural key but isn't one: it's
// a shared display string across variants (e.g. "combat_great_league" is
// reused by both the live Great League and its NPC-only counterpart) —
// confirmed against the real dump (74 unique titles across 110 records).
// templateId is the only unique id.
export interface CombatLeagueRecord {
  templateId: string;
  title?: string;
  [key: string]: unknown;
}

// --- Index -------------------------------------------------------------

interface CategoryIndex<T> {
  all: T[];
  byKey: Map<string, T>;
}

function warnConflict(category: string, key: string, kept: unknown, discarded: unknown): void {
  console.warn(
    `[game-master] ${category} conflict for key "${key}": keeping first-seen record, discarding a later one with different data (kept=${JSON.stringify(kept)}, discarded=${JSON.stringify(discarded)})`,
  );
}

// Builds a secondary map keyed by `keyOf(record)`. First-seen wins on a
// duplicate key; if the discarded record is deep-equal (by JSON, ignoring
// templateId -- every record has a distinct one by construction) to the one
// already kept it's a harmless re-declaration and is dropped silently,
// otherwise the conflict is logged — same convention as build-reference.ts's
// species_evolution conflict handling (keep first, warn only on genuine
// divergence, not on every duplicate).
function indexByKey<T extends { templateId: string }>(category: string, records: T[], keyOf: (record: T) => string): Map<string, T> {
  const byKey = new Map<string, T>();
  for (const record of records) {
    const key = keyOf(record);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, record);
      continue;
    }
    const { templateId: _existingId, ...existingContent } = existing;
    const { templateId: _recordId, ...recordContent } = record;
    if (JSON.stringify(existingContent) === JSON.stringify(recordContent)) continue;
    warnConflict(category, key, existing, record);
  }
  return byKey;
}

function pokemonSettingsKey(record: PokemonSettingsRecord): string {
  return record.form ? `${record.pokemonId}|${record.form}` : record.pokemonId;
}

export interface GameMasterIndex {
  /** All entries whose data category is `category` (raw, un-narrowed). Escape hatch for categories this pipeline doesn't have a typed getter for. */
  categoryEntries(category: string): unknown[];

  allPokemonSettings(): PokemonSettingsRecord[];
  getPokemonSettings(pokemonId: string, form?: string): PokemonSettingsRecord | undefined;

  allFormSettings(): FormSettingsRecord[];
  getFormSettings(pokemon: string): FormSettingsRecord | undefined;

  // genderSettings has no field that's actually unique per gender-ratio
  // variant (`pokemon` alone collapses distinct records — e.g. Frillish's
  // male-only base form and its separate 100%-female FRILLISH_FEMALE
  // record share `pokemon: "FRILLISH"` but carry different ratios).
  // Deciding which ratio represents "the species" is a transform-layer call,
  // not this index's — so the secondary map here is keyed by templateId
  // (verified unique across all 2469 real records) and every record is kept.
  // `genderSettingsFor` is a convenience lookup that returns every record
  // for a given `pokemon`, plural, on purpose.
  allGenderSettings(): GenderSettingsRecord[];
  getGenderSettings(templateId: string): GenderSettingsRecord | undefined;
  genderSettingsFor(pokemon: string): GenderSettingsRecord[];

  allMoveSettings(): MoveSettingsRecord[];
  getMoveSettings(movementId: string): MoveSettingsRecord | undefined;

  allCombatMoves(): CombatMoveRecord[];
  getCombatMove(uniqueId: string): CombatMoveRecord | undefined;

  allTypeEffective(): TypeEffectiveRecord[];
  getTypeEffective(attackType: string): TypeEffectiveRecord | undefined;

  allWeatherAffinities(): WeatherAffinityRecord[];
  getWeatherAffinity(weatherCondition: string): WeatherAffinityRecord | undefined;

  // Singleton category — GAME_MASTER carries exactly one playerLevel record.
  getPlayerLevelSettings(): PlayerLevelSettingsRecord | undefined;

  allLevelUpRewards(): LevelUpRewardsRecord[];
  getLevelUpRewards(level: number): LevelUpRewardsRecord | undefined;

  allBadgeSettings(): BadgeSettingsRecord[];
  getBadgeSettings(badgeType: string): BadgeSettingsRecord | undefined;

  allFriendshipMilestoneSettings(): FriendshipMilestoneSettingsRecord[];
  getFriendshipMilestoneSettings(templateId: string): FriendshipMilestoneSettingsRecord | undefined;

  allCombatLeagues(): CombatLeagueRecord[];
  getCombatLeague(templateId: string): CombatLeagueRecord | undefined;
}

export function createGameMasterIndex(raw: unknown[]): GameMasterIndex {
  const byCategory = new Map<string, unknown[]>();

  for (const rawEntry of raw) {
    const entry = rawEntry as GameMasterEntry;
    if (!entry || typeof entry !== "object" || !entry.data) continue;
    const category = Object.keys(entry.data).find((key) => key !== "templateId");
    if (!category) continue;
    const bucket = byCategory.get(category);
    // Each record carries its own templateId (from the entry, not
    // data.templateId) so per-category natural-key lookups that fall back
    // to templateId (genderSettings, friendshipMilestoneSettings,
    // combatLeague) have it available.
    const record = { templateId: entry.templateId, ...(entry.data[category] as Record<string, unknown>) };
    if (bucket) {
      bucket.push(record);
    } else {
      byCategory.set(category, [record]);
    }
  }

  function categoryEntries(category: string): unknown[] {
    return byCategory.get(category) ?? [];
  }

  function buildCategoryIndex<T extends { templateId: string }>(category: string, keyOf: (record: T) => string): CategoryIndex<T> {
    const all = (byCategory.get(category) ?? []) as T[];
    return { all, byKey: indexByKey(category, all, keyOf) };
  }

  const pokemonSettings = buildCategoryIndex<PokemonSettingsRecord>("pokemonSettings", pokemonSettingsKey);
  const formSettings = buildCategoryIndex<FormSettingsRecord>("formSettings", (r) => r.pokemon);
  const genderSettings = buildCategoryIndex<GenderSettingsRecord>("genderSettings", (r) => r.templateId);
  const moveSettings = buildCategoryIndex<MoveSettingsRecord>("moveSettings", (r) => r.movementId);
  const combatMove = buildCategoryIndex<CombatMoveRecord>("combatMove", (r) => r.uniqueId);
  const typeEffective = buildCategoryIndex<TypeEffectiveRecord>("typeEffective", (r) => r.attackType);
  const weatherAffinities = buildCategoryIndex<WeatherAffinityRecord>("weatherAffinities", (r) => r.weatherCondition);
  const playerLevel = buildCategoryIndex<PlayerLevelSettingsRecord>("playerLevel", (r) => r.templateId);
  const levelUpRewards = buildCategoryIndex<LevelUpRewardsRecord>("levelUpRewards", (r) => String(r.level));
  const badgeSettings = buildCategoryIndex<BadgeSettingsRecord>("badgeSettings", (r) => r.badgeType);
  const friendshipMilestoneSettings = buildCategoryIndex<FriendshipMilestoneSettingsRecord>(
    "friendshipMilestoneSettings",
    (r) => r.templateId,
  );
  const combatLeague = buildCategoryIndex<CombatLeagueRecord>("combatLeague", (r) => r.templateId);

  const genderSettingsByPokemon = new Map<string, GenderSettingsRecord[]>();
  for (const record of genderSettings.all) {
    const list = genderSettingsByPokemon.get(record.pokemon);
    if (list) list.push(record);
    else genderSettingsByPokemon.set(record.pokemon, [record]);
  }

  return {
    categoryEntries,

    allPokemonSettings: () => pokemonSettings.all,
    getPokemonSettings: (pokemonId, form) => pokemonSettings.byKey.get(form ? `${pokemonId}|${form}` : pokemonId),

    allFormSettings: () => formSettings.all,
    getFormSettings: (pokemon) => formSettings.byKey.get(pokemon),

    allGenderSettings: () => genderSettings.all,
    getGenderSettings: (templateId) => genderSettings.byKey.get(templateId),
    genderSettingsFor: (pokemon) => genderSettingsByPokemon.get(pokemon) ?? [],

    allMoveSettings: () => moveSettings.all,
    getMoveSettings: (movementId) => moveSettings.byKey.get(movementId),

    allCombatMoves: () => combatMove.all,
    getCombatMove: (uniqueId) => combatMove.byKey.get(uniqueId),

    allTypeEffective: () => typeEffective.all,
    getTypeEffective: (attackType) => typeEffective.byKey.get(attackType),

    allWeatherAffinities: () => weatherAffinities.all,
    getWeatherAffinity: (weatherCondition) => weatherAffinities.byKey.get(weatherCondition),

    getPlayerLevelSettings: () => playerLevel.all[0],

    allLevelUpRewards: () => levelUpRewards.all,
    getLevelUpRewards: (level) => levelUpRewards.byKey.get(String(level)),

    allBadgeSettings: () => badgeSettings.all,
    getBadgeSettings: (badgeType) => badgeSettings.byKey.get(badgeType),

    allFriendshipMilestoneSettings: () => friendshipMilestoneSettings.all,
    getFriendshipMilestoneSettings: (templateId) => friendshipMilestoneSettings.byKey.get(templateId),

    allCombatLeagues: () => combatLeague.all,
    getCombatLeague: (templateId) => combatLeague.byKey.get(templateId),
  };
}
