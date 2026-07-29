// Parses "Regional Formes" sheet of Refs from Obsidian/Pokedex Sheet
// Recovery.xlsx — an Obsidian-era tracking spreadsheet that mixes real
// regional-variant rows together with rows literally named
// "Gigantamax {Species}" (one per Gigantamax-capable species, not per
// form-variant — confirming Gigantamax capability is species-wide, same as
// Mega Evolution).
//
// This ingestion is reference-only: only a Gigantamax row's existence and
// species name matter (which Gigantamax forms exist at all). The other
// columns (Available/Captured/Seen/Shinies/etc.) are the original Obsidian
// vault owner's PERSONAL tracking data — per an earlier, already-settled
// decision, this repo never migrates personal data from the old Obsidian
// vault, so those columns are read from the sheet but deliberately ignored.
//
// Output: a small intermediate JSON file (mirroring parse-event-pokemon.ts's
// OUT_CSV pattern) that scripts/ingest/build-reference.ts reads directly to
// (a) set species.canGigantamax = true and (b) generate a dedicated
// "Gigantamax" form row per matched species — unlike costumes, which get
// merged in later via the csv-authoring import workflow, Gigantamax rows are
// simple enough (no per-row detail beyond "this species has one") to build
// directly into the main reference-build pass.
//
// Usage:
//   npm run ingest:gigantamax   (produces data-authoring/gigantamax-species.json)
//   npm run ingest:build        (consumes it)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as XLSX from "xlsx";

import type { ReferenceData } from "../../src/db/reference-data";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const XLSX_PATH = resolve(REPO_ROOT, "Refs from Obsidian/Pokedex Sheet Recovery.xlsx");
const SHEET_NAME = "Regional Formes";
const REFERENCE_PATH = resolve(REPO_ROOT, "src/data/reference.json");
const OUT_PATH = resolve(REPO_ROOT, "data-authoring/gigantamax-species.json");

const GIGANTAMAX_PREFIX = /^Gigantamax\s+/i;

export interface GigantamaxMatch {
  speciesSlug: string;
  /** The raw "Gigantamax {Species}" cell text, kept for traceability. */
  rawName: string;
  /**
   * Non-null only for the (currently one) known case where the sheet's
   * species name carries a form-name qualifier the base species slug alone
   * doesn't capture — e.g. "Gigantamax Urshifu Single Strike" matches
   * species "Urshifu" with styleSuffix "Single Strike", since Urshifu's
   * two styles (see its existing `form` rows) each get their own,
   * independently-obtainable Gigantamax form in the real games. Used to
   * disambiguate the generated form's name/slug so the two don't collide.
   */
  styleSuffix: string | null;
}

export interface GigantamaxParseOutput {
  matches: GigantamaxMatch[];
  /** Raw "Gigantamax {Species}" names that couldn't be matched to any known species slug — flagged, not silently dropped. */
  unmatched: string[];
}

function readGigantamaxRows(): string[] {
  // Read the bytes ourselves and use XLSX.read rather than XLSX.readFile:
  // the fs-backed readFile helper isn't wired up when the package is loaded
  // as ESM (via tsx), so XLSX.readFile is undefined there.
  const workbook = XLSX.read(readFileSync(XLSX_PATH), { type: "buffer" });
  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found in ${XLSX_PATH}. Available sheets: ${workbook.SheetNames.join(", ")}`);

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  // Row 0 is the header (No., Name, Available, Captured, Seen, Shinies,
  // Shiny Caught, Shadow, Shadow Shiny, Dynamax, Shiny D-Max, HOME, Region
  // Locked) — only column 1 (Name) matters here; every other column is the
  // old owner's personal tracking data, not reference data.
  const names: string[] = [];
  for (const row of rows.slice(1)) {
    const name = row[1];
    if (typeof name === "string" && GIGANTAMAX_PREFIX.test(name)) names.push(name.trim());
  }
  return names;
}

/**
 * Matches a "Gigantamax {Species}" row to a known species slug. Tries an
 * exact (case-insensitive) match first; if that fails, tries the longest
 * known species name that's a word-boundary-respecting prefix of the
 * remaining text, treating anything left over as a styleSuffix (handles the
 * Urshifu Single/Rapid Strike case without hardcoding it).
 */
function matchSpecies(
  speciesPart: string,
  byExactName: Map<string, ReferenceData["species"][number]>,
  allSpecies: ReferenceData["species"],
): { slug: string; styleSuffix: string | null } | null {
  const exact = byExactName.get(speciesPart.toLowerCase());
  if (exact) return { slug: exact.slug, styleSuffix: null };

  let best: { slug: string; styleSuffix: string; nameLength: number } | null = null;
  for (const species of allSpecies) {
    const prefix = `${species.name.toLowerCase()} `;
    if (speciesPart.toLowerCase().startsWith(prefix)) {
      const styleSuffix = speciesPart.slice(prefix.length).trim();
      if (!best || species.name.length > best.nameLength) {
        best = { slug: species.slug, styleSuffix, nameLength: species.name.length };
      }
    }
  }
  return best;
}

function main() {
  console.log(`Parsing "${SHEET_NAME}" from ${XLSX_PATH}...`);
  const rawNames = readGigantamaxRows();
  console.log(`  ${rawNames.length} "Gigantamax {Species}" row(s) found.`);

  const reference: ReferenceData = JSON.parse(readFileSync(REFERENCE_PATH, "utf-8"));
  const byExactName = new Map(reference.species.map((s) => [s.name.trim().toLowerCase(), s]));

  const matches: GigantamaxMatch[] = [];
  const unmatched: string[] = [];

  for (const rawName of rawNames) {
    const speciesPart = rawName.replace(GIGANTAMAX_PREFIX, "").trim();
    const match = matchSpecies(speciesPart, byExactName, reference.species);
    if (!match) {
      unmatched.push(rawName);
      continue;
    }
    matches.push({ speciesSlug: match.slug, rawName, styleSuffix: match.styleSuffix || null });
  }

  if (unmatched.length > 0) {
    console.log(`  ${unmatched.length} row(s) didn't match any species in reference.json (skipped, not guessed):`);
    for (const name of unmatched) console.log(`    - ${name}`);
  }
  const withStyle = matches.filter((m) => m.styleSuffix);
  if (withStyle.length > 0) {
    console.log(`  ${withStyle.length} match(es) carried a style-suffix qualifier (e.g. Urshifu's Single/Rapid Strike) — verify manually:`);
    for (const m of withStyle) console.log(`    - ${m.rawName} -> ${m.speciesSlug} (${m.styleSuffix})`);
  }

  const output: GigantamaxParseOutput = { matches, unmatched };
  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`Wrote ${matches.length} matched species (+ ${unmatched.length} unmatched) to ${OUT_PATH}`);
  console.log(`Now run: npm run ingest:build`);
}

main();
