// Moves, per-form move pools, and the type-effectiveness / weather-boost
// matrices — all re-sourced from GAME_MASTER (moveSettings + combatMove +
// typeEffective + weatherAffinities) in place of pogoapi.net's fast_moves/
// charged_moves/pvp_*_moves/current_pokemon_moves/type_effectiveness/
// weather_boosts endpoints.
//
// Type effectiveness and weather live here rather than in their own module
// because they're the same domain as a move's type and power (the plan's
// module list has no types module, and inventing one wasn't in scope).

import { slugify } from "../slug";
import type { GameMasterIndex } from "../sources/game-master";
import type { PokedexEntry, PokedexSource } from "../sources/pokemon-go-api";
import type { Form, FormMove, Move, MoveCategory, TypeEffectiveness, WeatherBoost } from "../../../src/db/types";
import { slugFor } from "./species";

/** ENUM_STYLE_TOKEN -> "Enum Style Token". GAME_MASTER publishes no display strings, so every user-visible name derived from an enum id goes through here. Exported because player-progression.ts needs the identical derivation. */
export function titleCaseEnumToken(token: string): string {
  return token
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

// GAME_MASTER's typeEffective records carry an 18-element `attackScalar`
// array indexed by the game's own POKEMON_TYPE enum ordinal — the ordinal
// order is NOT published anywhere in the dump (the `combatType` category is
// alphabetical, and so is the order the typeEffective records themselves
// appear in), so it has to live here. Verified element-by-element against
// pogoapi.net's type_effectiveness table before it was dropped, and pinned
// by a test that cross-checks the derived matrix against pokemon-go-api's
// independent types.json.
const TYPE_ORDER = [
  "normal", "fighting", "flying", "poison", "ground", "rock",
  "bug", "ghost", "steel", "fire", "water", "grass",
  "electric", "psychic", "ice", "dragon", "dark", "fairy",
] as const;

function typeSlugFromEnum(typeEnum: string | undefined): string {
  return (typeEnum ?? "").replace("POKEMON_TYPE_", "").toLowerCase();
}

// GAME_MASTER ships 62 `VN_BM_*` placeholder move records that have no
// combatMove counterpart, no display name anywhere in either source, and no
// counterpart in the reference.json this pipeline replaces (confirmed: zero
// `vn-bm-*` move slugs there). They're internal/unreleased entries, not
// moves the game exposes — excluded so they don't reach the UI as
// "Vn Bm 001".
const PLACEHOLDER_MOVE_ID = /^VN_BM_\d+$/;

export interface MovesBuildResult {
  moves: Move[];
  /** movementId (GAME_MASTER's own move id, e.g. "VINE_WHIP_FAST") -> move slug. Replaces the old name-keyed lookup: pokemonSettings references moves by id, not by display name, so there's no name-collision ambiguity to resolve any more. */
  slugByMovementId: Map<string, string>;
}

/** Collects every English move name pokemon-go-api publishes on a species' move pools, keyed by GAME_MASTER's movementId. GAME_MASTER has the stats but no display strings; pokemon-go-api has the strings but only for moves some species can learn. */
function moveDisplayNames(pokedex: PokedexSource): Map<string, string> {
  const names = new Map<string, string>();
  const poolKeys = ["quickMoves", "cinematicMoves", "eliteQuickMoves", "eliteCinematicMoves"] as const;
  function collect(entry: PokedexEntry) {
    for (const key of poolKeys) {
      const pool = entry[key] as Record<string, { names?: { English?: string } }> | undefined;
      if (!pool || typeof pool !== "object") continue;
      for (const [moveId, move] of Object.entries(pool)) {
        const english = move?.names?.English;
        if (english && !names.has(moveId)) names.set(moveId, english);
      }
    }
  }
  for (const entry of pokedex.all()) {
    collect(entry);
    for (const region of Object.values(entry.regionForms ?? {})) collect(region);
  }
  return names;
}

export function buildMoves(gameMaster: GameMasterIndex, pokedex: PokedexSource): MovesBuildResult {
  const displayNames = moveDisplayNames(pokedex);

  const moves: Move[] = [];
  const slugByMovementId = new Map<string, string>();
  const usedSlugs = new Set<string>();

  for (const record of gameMaster.allMoveSettings()) {
    const movementId = record.movementId;
    if (PLACEHOLDER_MOVE_ID.test(movementId)) continue;

    // GAME_MASTER marks fast moves with a `_FAST` id suffix and nothing
    // else — there is no category field.
    const category: MoveCategory = movementId.endsWith("_FAST") ? "fast" : "charged";
    // The move id is the naming source of truth, because the slug derives
    // from the name and the previous source's names were themselves
    // id-derived — WEATHER_BALL_FIRE has to stay "Weather Ball Fire", not
    // pokemon-go-api's plain "Weather Ball", or four distinct moves collapse
    // onto one name and their slugs change. pokemon-go-api's English name is
    // used only where it slugifies identically, i.e. as a pure cosmetic
    // improvement ("X-Scissor" over "X Scissor") that can't move a slug.
    const idDerivedName = titleCaseEnumToken(movementId.replace(/_FAST$/, ""));
    const publishedName = displayNames.get(movementId);
    const name = publishedName && slugify(`${publishedName}-${category}`) === slugify(`${idDerivedName}-${category}`) ? publishedName : idDerivedName;

    // Pokémon GO has historically kept legacy/pre-buff versions of a move as
    // distinct records, and some display names cover two genuinely different
    // moves (Aura Wheel is Electric or Dark depending on Morpeko's form). A
    // plain name-derived slug collides across those and would produce
    // duplicate `move.slug` primary keys; later collisions get the move id
    // appended so every record is kept, not silently dropped. GAME_MASTER's
    // movementId is unique so this currently never fires, but the invariant
    // it protects (slug is a primary key) hasn't changed.
    const baseSlug = slugify(`${name}-${category}`);
    const slug = usedSlugs.has(baseSlug) ? `${baseSlug}-${slugify(movementId)}` : baseSlug;
    usedSlugs.add(slug);
    if (!slugByMovementId.has(movementId)) slugByMovementId.set(movementId, slug);

    // combatMove is the PvP-tuned mirror of moveSettings, keyed by the same
    // id. A handful of moves (Crush Claw, Leech Life, Horn Drill, Fissure)
    // exist only in the raid/gym table and get null PvP stats, same as they
    // did when the PvP numbers came from pogoapi's separate endpoints.
    const combat = gameMaster.getCombatMove(movementId);
    moves.push({
      slug,
      name,
      category,
      typeSlug: typeSlugFromEnum(record.pokemonType as string | undefined),
      power: (record.power as number | undefined) ?? null,
      energyDelta: (record.energyDelta as number | undefined) ?? null,
      durationMs: (record.durationMs as number | undefined) ?? null,
      pvpPower: (combat?.power as number | undefined) ?? null,
      pvpEnergyDelta: (combat?.energyDelta as number | undefined) ?? null,
      // combatMove counts a 1-turn move as `durationTurns` absent, 2-turn as
      // 1, and so on — verified to reproduce pogoapi's turn_duration exactly
      // for all 77 shared fast moves (and 1 for every charged move).
      pvpTurns: combat ? ((combat.durationTurns as number | undefined) ?? 0) + 1 : null,
    });
  }

  return { moves, slugByMovementId };
}

// Only the species' base ("_NORMAL", falling back to the record with no form
// at all) pokemonSettings record, applied to Standard forms — the same
// narrow rule the pogoapi-sourced version used. GAME_MASTER does publish a
// per-form move pool for region forms whose token maps cleanly onto our form
// slugs, which the old source couldn't, so widening this is a cheap
// follow-up — deliberately not done here to keep this pass a re-sourcing
// rather than a coverage change.
export function buildFormMoves(
  gameMaster: GameMasterIndex,
  pokedex: PokedexSource,
  forms: Form[],
  slugByMovementId: Map<string, string>,
): FormMove[] {
  const standardFormSlugsBySpecies = new Map<string, string[]>();
  for (const f of forms) {
    if (f.formName !== "Standard" || f.costumeName) continue;
    const list = standardFormSlugsBySpecies.get(f.speciesSlug) ?? [];
    list.push(f.slug);
    standardFormSlugsBySpecies.set(f.speciesSlug, list);
  }

  const formMoves: FormMove[] = [];
  for (const entry of pokedex.all()) {
    const formSlugs = standardFormSlugsBySpecies.get(slugFor(entry.id));
    if (!formSlugs) continue;
    const settings = gameMaster.getPokemonSettings(entry.id, `${entry.id}_NORMAL`) ?? gameMaster.getPokemonSettings(entry.id);
    if (!settings) continue;

    const pools: { ids: unknown; isElite: boolean }[] = [
      { ids: settings.quickMoves, isElite: false },
      { ids: settings.cinematicMoves, isElite: false },
      { ids: settings.eliteQuickMove, isElite: true },
      { ids: settings.eliteCinematicMove, isElite: true },
    ];
    for (const fSlug of formSlugs) {
      for (const pool of pools) {
        if (!Array.isArray(pool.ids)) continue;
        for (const moveId of pool.ids as string[]) {
          const moveSlug = slugByMovementId.get(moveId);
          if (moveSlug) formMoves.push({ formSlug: fSlug, moveSlug, isElite: pool.isElite });
        }
      }
    }
  }
  return formMoves;
}

export function buildTypeEffectivenessAndWeather(gameMaster: GameMasterIndex): { typeEffectiveness: TypeEffectiveness[]; weatherBoosts: WeatherBoost[] } {
  const typeEffectiveness: TypeEffectiveness[] = [];
  for (const record of gameMaster.allTypeEffective()) {
    const attackingTypeSlug = typeSlugFromEnum(record.attackType);
    const scalars = record.attackScalar ?? [];
    scalars.forEach((multiplier, i) => {
      const defendingTypeSlug = TYPE_ORDER[i];
      if (!defendingTypeSlug) return;
      typeEffectiveness.push({ attackingTypeSlug, defendingTypeSlug, multiplier });
    });
  }

  const weatherBoosts: WeatherBoost[] = [];
  for (const record of gameMaster.allWeatherAffinities()) {
    // Stored as the display string ("Partly Cloudy"), matching what the
    // previous source published and what the schema's weather column holds.
    const weather = titleCaseEnumToken(record.weatherCondition);
    for (const t of record.pokemonType ?? []) weatherBoosts.push({ weather, typeSlug: typeSlugFromEnum(t) });
  }

  return { typeEffectiveness, weatherBoosts };
}
