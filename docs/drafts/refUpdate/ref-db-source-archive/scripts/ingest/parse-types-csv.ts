// Parses "Partial pokemon list.csv" as a FALLBACK types/generation source —
// PokeAPI (scripts/ingest/pokeapi-client.ts) is the primary source for
// typing since it has full, correct dex 1-1025 coverage; this file only
// gets consulted if a PokeAPI fetch is somehow missing for a given
// species/form. Full investigation in memory
// project_reference_data_ingestion.md.
//
// Known issue: ~27 rows (mostly Gen 9 Paradox Pokémon) have corrupted
// `types` values from what looks like a name-splitting bug (e.g. Roaring
// Moon -> ["Roaring","Dragon"] instead of ["Dragon","Dark"]). Corrected
// below for the cases this was caught on. Since this file is a fallback
// rarely expected to be exercised (PokeAPI covers the full dex), this
// correction table is best-effort, not exhaustively re-verified against
// every one of the file's 1,086 rows.

import { readFileSync } from "node:fs";

const TYPE_CORRECTIONS: Record<string, string[]> = {
  "Roaring Moon": ["Dragon", "Dark"],
  "Iron Valiant": ["Fairy", "Fighting"],
  Okidogi: ["Poison", "Fighting"],
  Munkidori: ["Poison", "Psychic"],
  Feandipiti: ["Poison", "Fairy"], // misspelled in source (missing "z")
  Fezandipiti: ["Poison", "Fairy"],
  Archaludon: ["Steel", "Dragon"],
  Hydrapple: ["Grass", "Dragon"],
  "Gouging Fire": ["Fire", "Dragon"],
  "Raging Bolt": ["Electric", "Dragon"],
  "Iron Boulder": ["Rock", "Fighting"],
  "Iron Crown": ["Steel", "Psychic"],
  "Iron Hands": ["Fighting", "Electric"],
  "Iron Jugulis": ["Dark", "Flying"],
  "Iron Moth": ["Fire", "Poison"],
  "Iron Thorns": ["Rock", "Electric"],
  "Iron Treads": ["Ground", "Steel"],
  "Iron Bundle": ["Ice", "Water"],
  "Great Tusk": ["Ground", "Fighting"],
  "Scream Tail": ["Fairy", "Psychic"],
  "Brute Bonnet": ["Grass", "Dark"],
  "Flutter Mane": ["Ghost", "Fairy"],
  "Slither Wing": ["Bug", "Fighting"],
  "Sandy Shocks": ["Electric", "Ground"],
  Glimmet: ["Rock", "Poison"],
  Annihilape: ["Fighting", "Ghost"],
  Farigaraf: ["Normal", "Psychic"], // also misspelled in source (Farigiraf)
  Farigiraf: ["Normal", "Psychic"],
  Ursaluna: ["Ground", "Normal"],
  Chewtle: ["Water"],
};

export interface TypesCsvEntry {
  dexNumber: number;
  form: string;
  name: string;
  generation: number;
  types: string[];
}

export function parseTypesCsv(filePath: string): TypesCsvEntry[] {
  const raw = readFileSync(filePath, "utf-8").replace(/^﻿/, "");
  const lines = raw.split("\n").filter((l) => l.trim());
  const [, ...dataLines] = lines; // drop header

  return dataLines.map((line) => {
    // types is the only field that can contain commas, always inside a
    // quoted, comma-escaped JSON string ("[""Grass"",""Poison""]") — split
    // around it rather than naively on every comma.
    const match = line.match(/^(\d+),"(.*)",([^,]*),(\d+),([^,]*),(.*)$/);
    if (!match) throw new Error(`Unparseable row in ${filePath}: ${line}`);
    const [, generation, typesJson, , dexNumber, form, name] = match;

    let types: string[] = JSON.parse(typesJson.replace(/""/g, '"'));
    if (TYPE_CORRECTIONS[name]) types = TYPE_CORRECTIONS[name];

    return { dexNumber: Number(dexNumber), form, name, generation: Number(generation), types };
  });
}
