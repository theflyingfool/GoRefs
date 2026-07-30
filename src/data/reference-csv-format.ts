// The flat CSV column shape used by the manual reference-data authoring
// round-trip (scripts/ingest/csv-authoring.ts's export/template/import
// commands). Lives under src/data (not scripts/ingest) because it's plain,
// environment-agnostic TS with no node:fs dependency — both the node-side
// authoring script AND the in-app Coverage Report (which needs to build the
// exact same CSV shape in the browser, so a hand-edited export round-trips
// straight back through `npm run ingest:csv:import` with no changes to that
// command) import it from here. Don't duplicate this column list or the
// per-form row-building logic anywhere else — extend this file instead.

import type { ReferenceData } from "../db/reference-data";
import type { Form } from "../db/types";

export const REFERENCE_CSV_COLUMNS = [
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
  "can_gigantamax",
  "form_slug",
  "form_name",
  "costume_name",
  "gender",
  "evolves",
  "shiny_available",
  "shiny_released_at",
  "shadow_available",
  "dynamax_available",
  "regional_exclusive",
  "image_ref",
  "types",
] as const;

export function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function referenceRowsToCsv(rows: string[][]): string {
  return [REFERENCE_CSV_COLUMNS.join(","), ...rows.map((r) => r.map(csvEscape).join(","))].join("\n") + "\n";
}

function typesForForm(data: ReferenceData, formSlug: string): string {
  return data.formTypes
    .filter((ft) => ft.formSlug === formSlug)
    .map((ft) => ft.typeSlug)
    .join(";");
}

/** Builds one CSV row (in REFERENCE_CSV_COLUMNS order) for a form + its species, exactly matching csv-authoring.ts's `export` output. */
export function formToCsvRow(data: ReferenceData, form: Form): string[] {
  const species = data.species.find((s) => s.slug === form.speciesSlug);
  if (!species) throw new Error(`Form ${form.slug} references unknown species ${form.speciesSlug}`);
  return [
    species.slug,
    String(species.dexNumber),
    species.name,
    species.familySlug,
    String(species.gen),
    species.rarity,
    species.regionSlug,
    String(species.hasMale),
    String(species.hasFemale),
    String(species.canMegaEvolve),
    String(species.canGigantamax),
    form.slug,
    form.formName,
    form.costumeName ?? "",
    form.gender,
    String(form.evolves),
    String(form.shinyAvailable),
    form.shinyReleasedAt ?? "",
    String(form.shadowAvailable),
    String(form.dynamaxAvailable),
    String(form.regionalExclusive),
    form.imageRef ?? "",
    typesForForm(data, form.slug),
  ];
}
