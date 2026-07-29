// Parses "Blank Pokedex Project (Living Column) - Forms w_ Dynamax.csv"
// into a species+form skeleton with PoGo-specific availability flags.
//
// File shape (see memory project_reference_data_ingestion.md for the full
// investigation): row 1 header, row 2 a "Missing:" summary row, then
// ALL-CAPS region section headers (KANTO, JOHTO, ...) interleaved with one
// row per species ("19 Rattata") optionally followed by unnumbered
// sub-rows for regional variants/costumes/formes ("Alolan", "A", "Attack").
//
// Column convention (0-indexed after split): 0=name/label, 3=Shiny,
// 4=100% (hundo), 5=Lucky, 6=XXL, 7=XXS, 8=Mega, 9=Dynamax,
// 10=Gigantamax, 11=Shadow, 12=Purified. `-` = not possible for that row,
// blank = possible-but-not-yet-achieved.
//
// Critical finding from manual inspection: only Shiny varies meaningfully
// per sub-row — every other column is uniformly dashed on every sub-row
// regardless of true in-game possibility; real values only ever appear on
// the species row. Per the user's confirmed decision, every form inherits
// its species' availability for every column except Shiny, which is read
// per-row since it's the one column that's actually populated at that
// granularity.

import { readFileSync } from "node:fs";

const REGION_HEADERS = new Set([
  "KANTO",
  "JOHTO",
  "HOENN",
  "SINNOH",
  "UNOVA",
  "KALOS",
  "ALOLA",
  "GALAR",
  "PALDEA",
]);

const COL = {
  LABEL: 0,
  SHINY: 3,
  HUNDO: 4,
  LUCKY: 5,
  MEGA: 8,
  DYNAMAX: 9,
  GIGANTAMAX: 10,
  SHADOW: 11,
} as const;

function isAvailable(cell: string | undefined): boolean {
  return (cell ?? "").trim() !== "-";
}

export interface ParsedForm {
  /** null = the species' base/standard form (the species row itself) */
  formToken: string | null;
  shinyAvailable: boolean;
}

export interface ParsedSpecies {
  dexNumber: number;
  name: string;
  regionSlug: string;
  hundoAvailable: boolean;
  luckyAvailable: boolean;
  canMegaEvolve: boolean;
  dynamaxAvailable: boolean;
  gigantamaxAvailable: boolean;
  shadowAvailable: boolean;
  forms: ParsedForm[];
  /** Form tokens that appeared more than once for this species (e.g. a
   * copy-paste duplicate row) — deduped down to one, kept here so the
   * build step can flag it for manual review rather than silently drop it. */
  duplicateFormTokens: string[];
}

function dedupeForms(species: Omit<ParsedSpecies, "duplicateFormTokens">): ParsedSpecies {
  const byToken = new Map<string, ParsedForm>();
  const duplicateFormTokens: string[] = [];
  for (const form of species.forms) {
    const key = (form.formToken ?? "").toLowerCase();
    const existing = byToken.get(key);
    if (existing) {
      duplicateFormTokens.push(form.formToken ?? "(base)");
      // Prefer whichever copy claims Shiny is available — a duplicate row
      // is a source-data error either way, but the more permissive claim
      // is the safer default until a human resolves which is correct.
      if (form.shinyAvailable && !existing.shinyAvailable) byToken.set(key, form);
    } else {
      byToken.set(key, form);
    }
  }
  return { ...species, forms: [...byToken.values()], duplicateFormTokens };
}

export function parseFormsCsv(filePath: string): ParsedSpecies[] {
  const lines = readFileSync(filePath, "utf-8").split("\n").map((l) => l.replace(/\r$/, ""));

  const species: ParsedSpecies[] = [];
  let currentRegion = "";
  let current: Omit<ParsedSpecies, "duplicateFormTokens"> | null = null;

  // Skip the header + "Missing:" summary rows.
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue;
    const cells = line.split(",");
    const label = cells[COL.LABEL]?.trim() ?? "";
    if (!label) continue;

    if (REGION_HEADERS.has(label)) {
      currentRegion = label.toLowerCase();
      continue;
    }

    const speciesMatch = label.match(/^(\d+)\s+(.+)$/);
    if (speciesMatch) {
      if (current) species.push(dedupeForms(current));
      const dexNumber = Number(speciesMatch[1]);
      const name = speciesMatch[2];
      current = {
        dexNumber,
        name,
        regionSlug: currentRegion,
        hundoAvailable: isAvailable(cells[COL.HUNDO]),
        luckyAvailable: isAvailable(cells[COL.LUCKY]),
        canMegaEvolve: isAvailable(cells[COL.MEGA]),
        dynamaxAvailable: isAvailable(cells[COL.DYNAMAX]),
        gigantamaxAvailable: isAvailable(cells[COL.GIGANTAMAX]),
        shadowAvailable: isAvailable(cells[COL.SHADOW]),
        forms: [],
      };
      current.forms.push({ formToken: null, shinyAvailable: isAvailable(cells[COL.SHINY]) });
      continue;
    }

    // A sub-row (regional variant/costume/forme) belonging to `current`.
    if (current) {
      current.forms.push({ formToken: label, shinyAvailable: isAvailable(cells[COL.SHINY]) });
    }
  }
  if (current) species.push(dedupeForms(current));

  return species;
}
