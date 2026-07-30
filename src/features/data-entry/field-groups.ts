import type { Form, FormPersonal, SpeciesPersonal } from "../../db/types";

type FormField = keyof Omit<FormPersonal, "formSlug" | "bestShiny" | "bestNonShiny" | "bestLucky" | "updatedAt">;

// Gigantamax form rows carry dynamaxAvailable: true (Gigantamax is
// fundamentally a Dynamax variant — scripts/ingest/transform/species.ts), but
// showing the Dynamax/Lucky Dynamax sections on one would ask the user to
// mark the *same* catch event twice: the row's own Standard section
// (caught/shiny/floor/fourStar/shundo) already *is* the Gigantamax
// encounter, there's no separate "regular" version of this form to Dynamax
// on top of it. No dedicated schema flag for this — formName is always
// "Gigantamax" or "Gigantamax {style}" per the ingestion script above, so
// that's the reliable signal. Exported since src/data/in-memory-store.ts
// needs the identical check for the Form-complete/G-max-complete lens split
// (same cross-layer import shape as src/db/cascades.ts already has on this
// file) — completion-stats-sql.ts's SQL side mirrors this with a LIKE
// pattern rather than calling this function directly.
export function isGigantamaxForm(form: Form): boolean {
  return form.formName === "Gigantamax" || form.formName.startsWith("Gigantamax ");
}

export const FORM_FIELD_GROUPS: { title: string; fields: { field: FormField; label: string }[]; availableWhen?: (form: Form) => boolean }[] = [
  {
    title: "Standard",
    fields: [
      { field: "caught", label: "Caught" },
      { field: "shiny", label: "Shiny" },
      { field: "floor", label: "Floor IV" },
      { field: "fourStar", label: "4★" },
      { field: "shundo", label: "Shundo" },
    ],
  },
  {
    // No corresponding reference-availability flag — Lucky comes from
    // trading, a universal mechanic not gated per-form in the schema.
    title: "Lucky",
    fields: [
      { field: "lucky", label: "Lucky" },
      { field: "luckyShiny", label: "Lucky shiny" },
      { field: "luckyFloor", label: "Lucky floor IV" },
      { field: "luckyFourStar", label: "Lucky 4★" },
      { field: "luckyShundo", label: "Lucky shundo" },
    ],
  },
  {
    title: "Shadow",
    availableWhen: (form) => form.shadowAvailable,
    fields: [
      { field: "shadow", label: "Shadow" },
      { field: "shadowShiny", label: "Shadow shiny" },
      { field: "shadowFloor", label: "Shadow floor IV" },
      { field: "shadowFourStar", label: "Shadow 4★" },
      { field: "shadowShundo", label: "Shadow shundo" },
    ],
  },
  {
    title: "Dynamax",
    availableWhen: (form) => form.dynamaxAvailable && !isGigantamaxForm(form),
    fields: [
      { field: "dynamax", label: "Dynamax" },
      { field: "dynamaxFloor", label: "Dynamax floor IV" },
      { field: "dynamaxShiny", label: "Dynamax shiny" },
      { field: "dynamaxFourStar", label: "Dynamax 4★" },
      { field: "dynamaxShundo", label: "Dynamax shundo" },
    ],
  },
  {
    // Lucky Dynamax is a sub-variant of Dynamax, not an independently
    // gated reference flag — same availableWhen as the Dynamax group above.
    title: "Lucky Dynamax",
    availableWhen: (form) => form.dynamaxAvailable && !isGigantamaxForm(form),
    fields: [
      { field: "luckyDynamax", label: "Lucky Dynamax" },
      { field: "luckyDynamaxFloor", label: "Lucky Dynamax floor IV" },
      { field: "luckyDynamaxShiny", label: "Lucky Dynamax shiny" },
      { field: "luckyDynamaxFourStar", label: "Lucky Dynamax 4★" },
      { field: "luckyDynamaxShundo", label: "Lucky Dynamax shundo" },
    ],
  },
];

type SpeciesField = keyof Omit<SpeciesPersonal, "speciesSlug" | "updatedAt">;

export const SPECIES_FIELDS: { field: SpeciesField; label: string }[] = [
  { field: "registered", label: "Registered" },
  { field: "xxl", label: "XXL" },
  { field: "xxs", label: "XXS" },
  { field: "purified", label: "Purified" },
];
