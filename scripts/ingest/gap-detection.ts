// Gap checks that are purely a function of a ReferenceData value's own
// contents — no PokeAPI fetch, no Forms-CSV skeleton, no Bulbapedia
// wikitext needed to (re)derive them. write/reference-json.ts calls these
// once at the end of a full ingest (see TODO.md's "Coverage Report was
// stale" entry for why this split matters: the stateless kinds below can be
// recomputed cheaply, without a full pipeline run).
//
// Other ReferenceGap kinds (mega-discrepancy, possible-bogus-form,
// guessed-costume-name) depend on external sources reference.json doesn't
// carry (PokeAPI's mega varieties, the Forms CSV's raw tokens, Bulbapedia's
// sprite codes) — those are NOT recomputed here; nothing in the current
// pipeline produces them any more (the old CSV-authoring workflow that once
// refreshed them was removed).

import type { Form, FormType, Species } from "../../src/db/types";
import type { ReferenceGap } from "../../src/db/reference-data";

/** The ReferenceGap kinds this module can fully recompute from reference.json alone. */
export const STATELESS_GAP_KINDS: ReferenceGap["kind"][] = ["missing-types", "unverified-gender", "inherited-availability"];

export function detectUnverifiedGenderGaps(species: Species[]): ReferenceGap[] {
  // Genderless AND not a legendary/mythical/UB is unusual enough to be worth a manual glance.
  return species
    .filter((s) => !s.hasMale && !s.hasFemale && s.rarity === "standard")
    .map(
      (s): ReferenceGap => ({
        kind: "unverified-gender",
        speciesSlug: s.slug,
        note: "Marked genderless — double check this is correct, not a fetch/import gap.",
      }),
    );
}

export function detectMissingTypesGaps(forms: Form[], formTypes: FormType[]): ReferenceGap[] {
  const typeCounts = new Map<string, number>();
  for (const ft of formTypes) typeCounts.set(ft.formSlug, (typeCounts.get(ft.formSlug) ?? 0) + 1);
  return forms
    .filter((f) => (typeCounts.get(f.slug) ?? 0) === 0)
    .map(
      (f): ReferenceGap => ({
        kind: "missing-types",
        speciesSlug: f.speciesSlug,
        formSlug: f.slug,
        note: "No types recorded for this form.",
      }),
    );
}

export function detectInheritedAvailabilityGaps(forms: Form[]): ReferenceGap[] {
  // Fires for every non-base form (by design — transform/species.ts sets
  // Dynamax/Gigantamax and evolves availability by form category
  // (costume/region/Gigantamax), not from a per-form source, for every form
  // but Standard. Shiny is the exception: it's looked up per form from the
  // shiny sheet for all form kinds.
  return forms
    .filter((f) => f.formName !== "Standard")
    .map(
      (f): ReferenceGap => ({
        kind: "inherited-availability",
        speciesSlug: f.speciesSlug,
        formSlug: f.slug,
        note: "Shadow/Dynamax/Gigantamax/evolves availability for this form defaults by form category rather than being individually sourced (only Shiny is looked up per form).",
      }),
    );
}

export function detectStatelessGaps(species: Species[], forms: Form[], formTypes: FormType[]): ReferenceGap[] {
  return [
    ...detectUnverifiedGenderGaps(species),
    ...detectMissingTypesGaps(forms, formTypes),
    ...detectInheritedAvailabilityGaps(forms),
  ];
}
