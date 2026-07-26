import type { FormPersonal, MedalProgressPersonal, MegaPersonal, SpeciesPersonal } from "./types";

// Real, sensible defaults for a brand-new install — not demo data (see
// personal-demo-seed.ts for that). sqlite-repository.ts seeds app_settings
// with these when none exist yet, so a fresh install isn't left with zero
// grid badges/filters until a user visits Settings.
export const DEFAULT_APP_SETTINGS: Record<string, string> = {
  collapse_gender_forms: "0",
  grid_indicators: JSON.stringify(["shiny", "lucky", "fourStar"]),
  // Off by default: Form-complete counting regional-exclusive forms is
  // today's existing behavior. Some players (with an alt/travel/spoofing
  // access to regionals) can actually complete it as-is; others can't, so
  // this is a per-install choice (Settings), not a fixed app-wide answer.
  exclude_regional_form_complete: "0",
};

// Sentinel for a row that's never actually been written — always sorts
// older than any real updatedAt, so an incoming import row always wins a
// merge against a not-yet-existing local row (see importPersonalData).
// Epoch milliseconds (0 = 1970-01-01T00:00:00.000Z), matching the INTEGER
// column updatedAt is now stored in.
export const NEVER_UPDATED = 0;

export function emptySpeciesPersonal(speciesSlug: string): SpeciesPersonal {
  return { speciesSlug, registered: false, xxl: false, xxs: false, purified: false, updatedAt: NEVER_UPDATED };
}

export function emptyMegaPersonal(megaVariantSlug: string): MegaPersonal {
  return { megaVariantSlug, evolved: false, shinyEvolved: false, updatedAt: NEVER_UPDATED };
}

export function emptyMedalProgress(medalSlug: string, profileId: string): MedalProgressPersonal {
  return { medalSlug, profileId, currentRank: 0, currentCount: 0, updatedAt: NEVER_UPDATED };
}

export function emptyFormPersonal(formSlug: string, overrides: Partial<Omit<FormPersonal, "formSlug">> = {}): FormPersonal {
  return {
    formSlug,
    caught: false,
    shiny: false,
    floor: false,
    fourStar: false,
    shundo: false,
    lucky: false,
    luckyShiny: false,
    luckyFloor: false,
    luckyFourStar: false,
    luckyShundo: false,
    shadow: false,
    shadowShiny: false,
    shadowFloor: false,
    shadowFourStar: false,
    shadowShundo: false,
    dynamax: false,
    dynamaxFloor: false,
    dynamaxShiny: false,
    dynamaxFourStar: false,
    dynamaxShundo: false,
    luckyDynamax: false,
    luckyDynamaxFloor: false,
    luckyDynamaxShiny: false,
    luckyDynamaxFourStar: false,
    luckyDynamaxShundo: false,
    bestShiny: null,
    bestNonShiny: null,
    bestLucky: null,
    updatedAt: NEVER_UPDATED,
    ...overrides,
  };
}
