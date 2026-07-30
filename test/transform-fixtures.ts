// Shared fixture builders for the transform/* tests. Everything here is
// hand-written (modelled on real records, but small) so the tests never need
// the ingestion cache or the untracked GAME_MASTER.json dump.

import { createGameMasterIndex, type GameMasterIndex } from "../scripts/ingest/sources/game-master";
import { createPokedexSource, type PokedexEntry, type PokedexSource } from "../scripts/ingest/sources/pokemon-go-api";
import { createShinySheetSource, type ShinySheetRecord, type ShinySheetSource } from "../scripts/ingest/sources/shiny-sheet";

/** Builds a GAME_MASTER index from `[category, record]` pairs — the raw dump's `{ templateId, data: { <category>: record } }` shape, with the record's own templateId reused as the entry templateId. */
export function gameMasterFrom(entries: [string, Record<string, unknown>][]): GameMasterIndex {
  return createGameMasterIndex(
    entries.map(([category, record]) => ({ templateId: String(record.templateId ?? `${category}_${Math.random()}`), data: { [category]: record } })),
  );
}

export function pokedexFrom(entries: PokedexEntry[]): PokedexSource {
  return createPokedexSource(entries);
}

export function shinySheetFrom(rows: Partial<ShinySheetRecord>[]): ShinySheetSource {
  return createShinySheetSource(rows.map((r) => ({ family_dex: "0", debut: "", pid: "", group: "", ...r }) as ShinySheetRecord));
}

/** A minimal single-species pokedex entry with sensible defaults. */
export function pokedexEntry(entry: Partial<PokedexEntry> & { id: string; dexNr: number }): PokedexEntry {
  return {
    formId: entry.id,
    generation: 1,
    names: { English: entry.id },
    primaryType: { type: "POKEMON_TYPE_NORMAL" },
    ...entry,
  } as PokedexEntry;
}

/** genderSettings record, keyed by templateId the way the real dump is. */
export function genderSettings(templateId: string, pokemon: string, gender: Record<string, number>): [string, Record<string, unknown>] {
  return ["genderSettings", { templateId, pokemon, gender }];
}

/** pokemonSettings record; pass `shadow` to mark the species/form shadow-available. */
export function pokemonSettings(record: { templateId?: string; pokemonId: string; form?: string; shadow?: Record<string, unknown>; quickMoves?: string[]; cinematicMoves?: string[]; eliteQuickMove?: string[]; eliteCinematicMove?: string[] }): [string, Record<string, unknown>] {
  return ["pokemonSettings", { templateId: record.templateId ?? `V_POKEMON_${record.form ?? record.pokemonId}`, ...record }];
}
