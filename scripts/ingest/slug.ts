// Shared slug generation — used throughout the ingestion pipeline
// (scripts/ingest/transform/*.ts, scripts/ingest/ingest.ts) so every slug in
// reference.json is built the same way.

const COMBINING_DIACRITICS = /[̀-ͯ]/g;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "") // strip accents, e.g. Flabébé -> Flabebe
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Punctuation-only form tokens (Unown's "!" and "?" forms) slugify to an
// empty string and would otherwise collide with each other — spell them out.
// Exported so PokeAPI variety-name matching (build-reference.ts) can apply
// the same translation — PokeAPI's own Unown varieties are named
// "unown-exclamation"/"unown-question", not "unown-!"/"unown-?".
export const PUNCTUATION_FORM_NAMES: Record<string, string> = {
  "!": "exclamation",
  "?": "question",
};

export function formSlug(speciesSlug: string, formToken: string | null, gender: string, costumeName?: string | null): string {
  const token = formToken ? slugify(PUNCTUATION_FORM_NAMES[formToken] ?? formToken) : "standard";
  // Costume is appended (not substituted) because a costume always decorates
  // some underlying form/gender — without it, every costume on a species'
  // base form would collide on the same "-standard-<gender>" slug as the
  // plain uncostumed form.
  const costumePart = costumeName ? `-${slugify(costumeName)}` : "";
  return `${speciesSlug}-${token}${costumePart}-${gender}`;
}

export function megaVariantSlug(speciesSlug: string, variant: "X" | "Y" | "Primal" | null): string {
  return variant ? `${speciesSlug}-mega-${variant.toLowerCase()}` : `${speciesSlug}-mega`;
}
