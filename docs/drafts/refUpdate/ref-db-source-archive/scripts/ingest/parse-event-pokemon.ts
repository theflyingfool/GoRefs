// Parses Bulbapedia's "Event Pokémon (GO)" article into costume `form` rows.
//
// This is a genuinely new data source, not a cross-check of an existing one:
// as of this writing, src/data/reference.json has zero forms with a
// costumeName set at all — costumes were never modeled by the Forms-CSV/
// PokeAPI pipeline (that pipeline only knows about regional variants,
// letters, and other "form" tokens, never event costumes).
//
// Source file: scripts/ingest/sources/event-pokemon-go.wikitext — a raw
// wikitext snapshot, fetched via:
//   curl 'https://bulbapedia.bulbagarden.net/w/index.php?title=Event_Pok%C3%A9mon_(GO)&action=raw'
// Committed so ingestion is reproducible without a live fetch; re-fetch and
// overwrite it to pick up new costumes later.
//
// The article's table groups rows under a shared "Form" column (rowspan),
// e.g. every Festive-hat Pichu/Pikachu/Raichu row shares one "Festive hat"
// label. Columns: Form | Pokémon (directly obtainable) | Evolution only
// (only reachable by evolving a costumed pre-evolution) | Availability
// (bulleted event history, {{Shinystar/GO}} marking a shiny-possible event).
//
// Output is the same CSV shape `csv-authoring.ts` reads, so costumes get
// reviewed/merged through the existing authoring workflow rather than a
// bespoke merge path:
//   npm run ingest:events
//   npm run ingest:csv:import -- data-authoring/event-pokemon.csv
//
// Known simplifications (flagged to stdout, not silently assumed correct):
// - Shiny availability is tracked per **row**, not per bullet: if any event
//   bullet in a row's Availability cell mentions Shinystar/GO, every species
//   in that row (direct + evolution-only) is marked shinyAvailable. Some
//   rows restrict a specific bullet to one species via a "** X only"
//   sub-note — those nuances are not parsed; the row-level OR is a
//   deliberate over-approximation, consistent with the "Shiny available at
//   all" boolean the schema actually stores (not "since which event").
// - `evolves` for a directly-caught species is true iff its row lists any
//   evolution-only species; evolution-only species themselves are always
//   marked non-evolving (doesn't handle 3-stage chains where the middle
//   stage can still evolve further in costume) — flagged per-species below.
// - A handful of species get the *same* Form label across multiple rows in
//   the source (e.g. Cosplay Pikachu's Libre/Rock Star/Pop Star/Ph.D. rows
//   all say "Cosplay Pikachu") — these would collide on one form slug, so a
//   suffix is derived from Bulbapedia's own MSP sprite code. Two codes are
//   already known (Cosplay Pikachu, Pumpkaboo/Gourgeist size); anything else
//   falls back to the raw code and is flagged for a human to give it a
//   proper name.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { formSlug, slugify } from "./slug";
import type { ReferenceData } from "../../src/db/reference-data";
import type { Gender } from "../../src/db/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const WIKITEXT_PATH = resolve(__dirname, "sources/event-pokemon-go.wikitext");
const REFERENCE_PATH = resolve(REPO_ROOT, "src/data/reference.json");
const OUT_CSV = resolve(REPO_ROOT, "data-authoring/event-pokemon.csv");

const COLUMNS = [
  "species_slug",
  "dex_number",
  "species_name",
  "family_slug",
  "generation",
  "rarity",
  "region_slug",
  "has_male",
  "has_female",
  "can_mega_evolve",
  "form_slug",
  "form_name",
  "costume_name",
  "gender",
  "evolves",
  "shiny_available",
  "shadow_available",
  "dynamax_available",
  "gigantamax_available",
  "regional_exclusive",
  "image_ref",
  "types",
] as const;

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function stripWikitext(text: string): string {
  return text
    .trim()
    .replace(/^rowspan="\d+"\s*\|\s*/, "")
    .replace(/\{\{anchor\|[^}]*\}\}/g, "")
    // {{OBP|display text|page name}} — the *first* arg is the display text
    // (opposite convention from the generic case below; confirmed via
    // "{{OBP|Detective Pikachu|character}}", which the generic last-arg
    // rule mangled into just "character").
    .replace(/\{\{OBP\|([^{}|]*)\|[^{}]*\}\}/g, "$1")
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    // Generic single/multi-arg templates (e.g. {{p|Charizard}}, {{ga|Lucas}})
    // — Bulbapedia's convention in these Form-column cells is otherwise that
    // the last argument is the display text.
    .replace(/\{\{[^{}|]*\|([^{}]*)\}\}/g, (_, args: string) => args.split("|").pop()!.trim())
    .replace(/'''/g, "")
    .trim();
}

interface SpeciesRef {
  name: string;
  code: string;
}

function extractSpeciesRefs(cellText: string): SpeciesRef[] {
  const refs: SpeciesRef[] = [];
  const re = /\{\{MSP\/GO\|([^}]*)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cellText))) {
    const params = m[1].split("|").map((p) => p.trim());
    const name = params[params.length - 1];
    const codeRaw = params[params.length - 2] ?? "";
    const code = codeRaw.replace(/^\d+/, "");
    refs.push({ name, code });
  }
  // The source wikitext has at least one known copy-paste duplicate (the
  // exact same {{MSP/GO}} template repeated twice in one cell, e.g. Pikachu/
  // Raichu's "Feb2019" costume) — same pattern as the duplicate rows already
  // found in the Forms tracker CSV (see project memory). Dedupe rather than
  // emit a real duplicate form row.
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.name}|${ref.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cellHasShinyMarker(cellText: string): boolean {
  return /Shinystar\/GO/.test(cellText);
}

interface RawRow {
  cells: string[];
}

function splitIntoRows(tableBody: string): RawRow[] {
  const chunks = tableBody.split(/\n\|-/).slice(1);
  const rows: RawRow[] = [];
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const cells: string[] = [];
    for (const line of lines) {
      if (line.startsWith("|") && !line.startsWith("|}")) {
        cells.push(line.slice(1));
      } else if (cells.length > 0) {
        cells[cells.length - 1] += "\n" + line;
      }
    }
    if (cells.length > 0) rows.push({ cells });
  }
  return rows;
}

interface CostumeEntry {
  speciesName: string;
  code: string;
  formGroupName: string;
  role: "direct" | "evolution-only";
  shinyAvailable: boolean;
  evolves: boolean;
}

function parseEventPokemon(wikitext: string): CostumeEntry[] {
  const startMarker = "==List of Event Pokémon==";
  const start = wikitext.indexOf(startMarker);
  if (start === -1) throw new Error("Couldn't find the '==List of Event Pokémon==' section — page structure may have changed.");
  const tableStart = wikitext.indexOf("{|", start);
  const tableEnd = wikitext.indexOf("\n|}", tableStart);
  if (tableStart === -1 || tableEnd === -1) throw new Error("Couldn't find the event table's start/end markers.");
  const tableBody = wikitext.slice(tableStart, tableEnd);

  const rows = splitIntoRows(tableBody);
  const entries: CostumeEntry[] = [];
  let currentFormName = "";
  let skippedRows = 0;

  for (const row of rows) {
    let cells = row.cells;
    if (!/\{\{MSP\/GO/.test(cells[0])) {
      currentFormName = stripWikitext(cells[0]);
      cells = cells.slice(1);
    }
    if (cells.length < 3) {
      skippedRows++;
      continue;
    }
    const [pokemonCell, evoCell, availabilityCell] = cells;
    const directRefs = extractSpeciesRefs(pokemonCell);
    const evoRefs = extractSpeciesRefs(evoCell);
    if (directRefs.length === 0) {
      skippedRows++;
      continue;
    }
    const shiny = cellHasShinyMarker(availabilityCell);
    const evolves = evoRefs.length > 0;

    for (const ref of directRefs) {
      entries.push({ speciesName: ref.name, code: ref.code, formGroupName: currentFormName, role: "direct", shinyAvailable: shiny, evolves });
    }
    for (const ref of evoRefs) {
      entries.push({ speciesName: ref.name, code: ref.code, formGroupName: currentFormName, role: "evolution-only", shinyAvailable: shiny, evolves: false });
    }
  }

  if (skippedRows > 0) console.log(`  Skipped ${skippedRows} row(s) with no recognizable Pokémon cell (likely malformed or a non-data row).`);
  return entries;
}

// Suffixes for the small set of known cases where Bulbapedia reuses one
// Form label across multiple distinct costumes for the same species.
const EXACT_CODE_SUFFIX: Record<string, string> = {
  Li: "Libre",
  Po: "Pop Star",
  Ro: "Rock Star",
  PhD: "Ph.D.",
};

function resolveCostumeSuffix(code: string, siblingCodes: string[]): { label: string; guessed: boolean } {
  if (EXACT_CODE_SUFFIX[code]) return { label: EXACT_CODE_SUFFIX[code], guessed: false };
  if (code.startsWith("Sm")) return { label: "Small", guessed: false };
  if (code.startsWith("La")) return { label: "Large", guessed: false };
  if (code.startsWith("Su")) return { label: "Super", guessed: false };
  const hasSizeSibling = siblingCodes.some((c) => /^(Sm|La|Su)/.test(c));
  if (hasSizeSibling) return { label: "Average", guessed: false };
  return { label: code || "Variant", guessed: true };
}

function main() {
  console.log("Parsing Event Pokémon (GO) wikitext...");
  const wikitext = readFileSync(WIKITEXT_PATH, "utf-8");
  const entries = parseEventPokemon(wikitext);
  console.log(`  ${entries.length} species/costume entries found.`);

  const reference: ReferenceData = JSON.parse(readFileSync(REFERENCE_PATH, "utf-8"));
  const speciesByName = new Map(reference.species.map((s) => [s.name.trim().toLowerCase(), s]));
  const formTypesBySlug = new Map<string, string[]>();
  for (const ft of reference.formTypes) {
    const list = formTypesBySlug.get(ft.formSlug) ?? [];
    list.push(ft.typeSlug);
    formTypesBySlug.set(ft.formSlug, list);
  }

  // Group by (speciesSlug, formGroupName) to detect the same species
  // reusing one Form label across multiple rows (needs disambiguation).
  interface Grouped {
    speciesSlug: string;
    formGroupName: string;
    entries: CostumeEntry[];
  }
  const groups = new Map<string, Grouped>();
  const unmatchedNames = new Set<string>();

  for (const entry of entries) {
    const species = speciesByName.get(entry.speciesName.trim().toLowerCase());
    if (!species) {
      unmatchedNames.add(entry.speciesName);
      continue;
    }
    const key = `${species.slug}|${slugify(entry.formGroupName)}`;
    const group = groups.get(key) ?? { speciesSlug: species.slug, formGroupName: entry.formGroupName, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }

  if (unmatchedNames.size > 0) {
    console.log(`  ${unmatchedNames.size} species name(s) from the wikitext didn't match any species in reference.json (skipped, not guessed):`);
    for (const name of [...unmatchedNames].sort()) console.log(`    - ${name}`);
  }

  const rows: string[][] = [];
  const guessedSuffixNotes: string[] = [];
  let genderRowCount = 0;

  for (const group of groups.values()) {
    const species = reference.species.find((s) => s.slug === group.speciesSlug)!;
    const costumeNameFor = (entry: CostumeEntry): string => {
      const cleanedGroup = stripWikitext(group.formGroupName);
      if (group.entries.length === 1) return cleanedGroup;
      const siblingCodes = group.entries.filter((e) => e !== entry).map((e) => e.code);
      const { label, guessed } = resolveCostumeSuffix(entry.code, siblingCodes);
      if (guessed) guessedSuffixNotes.push(`${species.name} / "${cleanedGroup}" (code "${entry.code}") — couldn't map to a friendly costume name, using the raw sprite code`);
      return `${cleanedGroup} (${label})`;
    };

    const genders: Gender[] = species.hasMale && species.hasFemale ? ["male", "female"] : species.hasMale ? ["male"] : species.hasFemale ? ["female"] : ["unknown"];

    for (const entry of group.entries) {
      const costumeName = costumeNameFor(entry);
      for (const gender of genders) {
        const fSlug = formSlug(species.slug, null, gender, costumeName);
        const baseFormSlug = formSlug(species.slug, null, gender);
        const types = formTypesBySlug.get(baseFormSlug) ?? [];
        rows.push([
          species.slug,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          fSlug,
          "Standard",
          costumeName,
          gender,
          String(entry.evolves),
          String(entry.shinyAvailable),
          "false",
          "false",
          "false",
          "false",
          "",
          types.join(";"),
        ]);
        genderRowCount++;
      }
    }
  }

  if (guessedSuffixNotes.length > 0) {
    console.log(`  ${guessedSuffixNotes.length} costume-suffix name(s) had to be guessed from a raw sprite code — verify manually:`);
    for (const note of guessedSuffixNotes) console.log(`    - ${note}`);
  }

  const content = [COLUMNS.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n") + "\n";
  writeFileSync(OUT_CSV, content);
  console.log(`Wrote ${genderRowCount} form row(s) (${groups.size} distinct species/costume combos) to ${OUT_CSV}`);
  console.log(`Review it, then run: npm run ingest:csv:import -- ${OUT_CSV.replace(REPO_ROOT + "/", "")}`);
}

main();
