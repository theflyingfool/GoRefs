// Typed, parse-only accessors over pokemon-go-api.github.io's four cached
// JSON files (pokedex.json, raidboss.json, types.json, mega.json). Same
// convention as sources/game-master.ts: each `createXSource` here takes the
// already-`JSON.parse()`d content, not a file path -- reading bytes off
// disk is ingest.ts's job (its `loadJson` helper calls
// `JSON.parse(readFileSync(...))` and hands the result to these factories).
// This keeps the module trivially testable against small fixture objects
// and keeps "read cache" and "understand the shape" separate concerns.
//
// Field sets below are deliberately narrow -- only what this pipeline
// reads today, matching game-master.ts's per-record convention -- with an
// index signature as an escape hatch for anything else callers need.

const PGAPI_BASE = "https://pokemon-go-api.github.io/pokemon-go-api/api";

/** The 4 pgapi files this pipeline caches, and the URLs they come from -- the single source of truth ingest.ts's fetch step and write/manifest.ts both read for what pgapi data this pipeline consumes. Relative paths are cache-root-relative, matching CACHE_V2_ROOT's existing "pgapi/<file>" convention. */
export const PGAPI_FILES: Record<string, string> = {
  "pgapi/pokedex.json": `${PGAPI_BASE}/pokedex.json`,
  "pgapi/raidboss.json": `${PGAPI_BASE}/raidboss.json`,
  "pgapi/types.json": `${PGAPI_BASE}/types.json`,
  "pgapi/mega.json": `${PGAPI_BASE}/pokedex/mega.json`,
};

export interface PokemonGoApiNames {
  English: string;
  [lang: string]: string | undefined;
}

export interface AssetPair {
  image?: string;
  shinyImage?: string;
}

export interface AssetForm extends AssetPair {
  form: string | null;
  costume: string | null;
  isFemale: boolean;
}

export interface PokedexEvolution {
  id: string;
  formId?: string;
  candies?: number;
  item?: { id: string } | null;
}

export interface MegaEvolutionEntry {
  assets?: AssetPair;
}

export interface PokedexEntry {
  id: string;
  formId: string;
  dexNr: number;
  generation?: number;
  names: PokemonGoApiNames;
  pokemonClass?: string | null;
  primaryType?: { type: string };
  secondaryType?: { type: string } | null;
  assets?: AssetPair;
  assetForms?: AssetForm[];
  regionForms?: Record<string, PokedexEntry>;
  megaEvolutions?: Record<string, MegaEvolutionEntry>;
  hasGigantamaxEvolution?: boolean;
  evolutions?: PokedexEvolution[];
  [key: string]: unknown;
}

export interface PokedexSource {
  all(): PokedexEntry[];
  byId(id: string): PokedexEntry | undefined;
}

/** pokedex.json: flat array of ~1024 species entries, keyed by pokemon-go-api's own enum-derived `id`. */
export function createPokedexSource(raw: PokedexEntry[]): PokedexSource {
  const byId = new Map(raw.map((entry) => [entry.id, entry]));
  return {
    all: () => raw,
    byId: (id) => byId.get(id),
  };
}

export interface TypeMatchup {
  type: string;
  names: PokemonGoApiNames;
  doubleDamageFrom: string[];
  halfDamageFrom: string[];
  noDamageFrom: string[];
  weatherBoost?: { id: string; names: PokemonGoApiNames; assetName: string };
  [key: string]: unknown;
}

export interface TypesSource {
  all(): TypeMatchup[];
  byType(type: string): TypeMatchup | undefined;
}

/** types.json: flat array of 18 type-effectiveness records keyed by English type name (e.g. "Fighting"), not the POKEMON_TYPE_* enum pokedex.json's primaryType.type uses. */
export function createTypesSource(raw: TypeMatchup[]): TypesSource {
  const byType = new Map(raw.map((entry) => [entry.type, entry]));
  return {
    all: () => raw,
    byType: (type) => byType.get(type),
  };
}

export interface MegaSource {
  all(): PokedexEntry[];
  /**
   * Returns every mega.json entry for `id`. An array, not a single record,
   * because mega.json reuses the full PokedexEntry shape (not a slim
   * megaEvolutions-only record) and, confirmed against the real cache,
   * duplicates an entry verbatim when its species has more than one mega
   * variant (e.g. "CHARIZARD" appears twice, byte-identical, for Mega
   * Charizard X and Y) rather than emitting one row per variant.
   */
  byId(id: string): PokedexEntry[];
}

/** mega.json: species-level pokedex entries for every mega-capable base species (not one row per mega variant -- see byId's doc comment). */
export function createMegaSource(raw: PokedexEntry[]): MegaSource {
  const byId = new Map<string, PokedexEntry[]>();
  for (const entry of raw) {
    const list = byId.get(entry.id);
    if (list) list.push(entry);
    else byId.set(entry.id, [entry]);
  }
  return {
    all: () => raw,
    byId: (id) => byId.get(id) ?? [],
  };
}

export interface RaidBossEntry {
  id: string;
  form: string | null;
  costume: string | null;
  assets?: AssetPair;
  level: string;
  names: PokemonGoApiNames;
  shiny: boolean;
  types: string[];
  cpRange: [number, number];
  cpRangeBoost: [number, number];
  [key: string]: unknown;
}

// Confirmed against the real cache -- raidboss.json's currentList has
// exactly these 7 tier keys, any of which may be absent if nothing is
// currently rotating in that tier.
export type RaidBossTier = "mega" | "lvl5" | "lvl3" | "lvl1" | "shadow_lvl5" | "shadow_lvl3" | "shadow_lvl1";

export interface RaidBossListRaw {
  currentList: Partial<Record<RaidBossTier, RaidBossEntry[]>>;
  [key: string]: unknown;
}

export interface RaidBossSource {
  /** Every current-rotation raid boss across all tiers, flattened (each entry's own `.level` still identifies its tier). */
  all(): RaidBossEntry[];
  byTier(tier: RaidBossTier): RaidBossEntry[];
}

// raidboss.json's top level is { currentList: { <tier>: RaidBossEntry[] }, graphics: {...} }
// -- only currentList (a live rotation snapshot) is modeled; `graphics` is
// unused by this pipeline and not typed.
export function createRaidBossSource(raw: RaidBossListRaw): RaidBossSource {
  const byTier = raw.currentList ?? {};
  const all = Object.values(byTier).flat();
  return {
    all: () => all,
    byTier: (tier) => byTier[tier] ?? [],
  };
}
