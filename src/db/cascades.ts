// Forward-only cascade rules: checking a "higher" achievement should also
// check its logical prerequisites, so the user doesn't need to tap every
// implied box by hand for one real-world catch (e.g. a shundo catch already
// implies caught + shiny + fourStar). Unchecking never cascades — that was
// explicitly decided against, since un-ticking one box shouldn't silently
// erase other independently-verified facts.
//
// Built programmatically from FORM_FIELD_GROUPS (src/features/data-entry/field-groups.ts)
// rather than hand-typed per field, since the same shiny/floor/fourStar/shundo
// -> base pattern repeats identically across all five sections (Standard,
// Lucky, Shadow, Dynamax, Lucky Dynamax) — encoding it once here keeps the
// two in sync automatically if a section's fields ever change.

import { FORM_FIELD_GROUPS } from "../features/data-entry/field-groups";
import type { FormPersonalBooleanField } from "./types";

function buildFormFieldCascades(): Partial<Record<FormPersonalBooleanField, FormPersonalBooleanField[]>> {
  const cascades: Partial<Record<FormPersonalBooleanField, FormPersonalBooleanField[]>> = {};

  for (const group of FORM_FIELD_GROUPS) {
    const fields = group.fields.map((f) => f.field);
    // The base field is always listed first per section (caught/lucky/shadow/
    // dynamax/luckyDynamax); the other four vary in listed order between
    // sections (e.g. Dynamax lists floor before shiny, unlike Standard/Lucky/
    // Shadow), so match the shiny/floor/fourStar/shundo-equivalents by name
    // suffix rather than assuming a fixed position. Case-insensitive because
    // Standard's own fields are the bare, unprefixed names ("shiny", not
    // "standardShiny") — a case-sensitive endsWith("Shiny") silently matched
    // nothing for the entire Standard section (found via a failing unit
    // test, 2026-07-14): checking Shiny/Floor/FourStar/Shundo there never
    // actually cascaded to Caught in production, for any user, ever.
    const base = fields[0];
    const shiny = fields.find((f) => f.toLowerCase().endsWith("shiny"))!;
    const floor = fields.find((f) => f.toLowerCase().endsWith("floor"))!;
    const fourStar = fields.find((f) => f.toLowerCase().endsWith("fourstar"))!;
    const shundo = fields.find((f) => f.toLowerCase().endsWith("shundo"))!;

    for (const field of [shiny, floor, fourStar, shundo]) {
      cascades[field] = [...(cascades[field] ?? []), base];
    }
    // Shundo (shiny + perfect IV) additionally implies both shiny and fourStar
    // for that same section — independently stored facts, but a shundo catch
    // is definitionally also a shiny and a 4-star, so both get set alongside it.
    cascades[shundo] = [...(cascades[shundo] ?? []), shiny, fourStar];
  }

  // Cross-section cascades (owner-specced, docs/issues.md, 2026-07-14). The
  // loop above only ever cascades a section up to *its own* base — these
  // bridge across sections, which the loop structurally can't do since it
  // only ever sees one group at a time.
  const byTitle = new Map(FORM_FIELD_GROUPS.map((g) => [g.title, g.fields.map((f) => f.field)]));
  const standardFields = byTitle.get("Standard")!;
  const standardBase = standardFields[0];
  const standardShiny = standardFields.find((f) => f.toLowerCase().endsWith("shiny"))!;
  const standardShundo = standardFields.find((f) => f.toLowerCase().endsWith("shundo"))!;

  // Any achievement anywhere means you caught the thing at all — every
  // other section's base field cascades up to Standard/Caught too, not just
  // the fields within that section.
  for (const [title, fields] of byTitle) {
    if (title === "Standard") continue;
    const base = fields[0];
    cascades[base] = [...(cascades[base] ?? []), standardBase];
  }

  // Lucky is the one section that isn't a separate encounter/individual —
  // it's a trait trading adds onto a Pokémon you already have, unlike
  // Shadow/Dynamax, which represent genuinely different acquisition paths
  // (and per CLAUDE.md, two independently-true flags never imply the same
  // individual was both — that's why Shadow/Dynamax don't get this same
  // promotion). Lucky Shiny/Shundo also promote Standard's own Shiny/
  // Shundo, since you unambiguously have a shiny of this form, Lucky or not.
  const luckyFields = byTitle.get("Lucky")!;
  const luckyShiny = luckyFields.find((f) => f.toLowerCase().endsWith("shiny"))!;
  const luckyShundo = luckyFields.find((f) => f.toLowerCase().endsWith("shundo"))!;
  cascades[luckyShiny] = [...(cascades[luckyShiny] ?? []), standardShiny];
  cascades[luckyShundo] = [...(cascades[luckyShundo] ?? []), standardShundo];

  return cascades;
}

/** Direct (one-level) cascade targets per field. Resolve transitively via resolveFormFieldCascade. */
export const FORM_FIELD_CASCADES: Partial<Record<FormPersonalBooleanField, FormPersonalBooleanField[]>> = buildFormFieldCascades();

/**
 * Resolves the full transitive set of fields implied by setting `field` to
 * true (not including `field` itself). Transitive because shundo cascades to
 * 3 other fields at once (shiny, fourStar, base), and shiny/fourStar each
 * further cascade to base.
 */
export function resolveFormFieldCascade(field: FormPersonalBooleanField): FormPersonalBooleanField[] {
  const resolved = new Set<FormPersonalBooleanField>();
  const queue = [...(FORM_FIELD_CASCADES[field] ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (resolved.has(next)) continue;
    resolved.add(next);
    for (const implied of FORM_FIELD_CASCADES[next] ?? []) {
      if (!resolved.has(implied)) queue.push(implied);
    }
  }
  return [...resolved];
}

export interface InstanceAchievementSource {
  shiny: boolean;
  lucky: boolean;
  shadow: boolean;
  dynamax: boolean;
  ivPercent: number | null;
}

/**
 * The single most-specific form_personal field implied by one logged
 * specimen's own recorded attributes. Feed the result into
 * setFormPersonalField/applyFormPersonalField -- resolveFormFieldCascade
 * (above) fills in every less-specific implied field (shiny/fourStar/base)
 * plus the species_personal.registered cascade, so callers only ever need
 * to set this one field per specimen, not a whole derivation table.
 *
 * Lucky+Shadow is not a real combination in Pokemon GO (owner-confirmed,
 * 2026-07-24) -- dynamax/shadow/lucky are checked in this order only as a
 * tie-break for callers that pass an invalid combination; it never matters
 * for a real specimen since the two flags can't both be true.
 */
export function resolveInstanceAchievementField(instance: InstanceAchievementSource): FormPersonalBooleanField {
  const fourStar = instance.ivPercent === 100;

  let base: FormPersonalBooleanField;
  let shinyField: FormPersonalBooleanField;
  let fourStarField: FormPersonalBooleanField;
  let shundoField: FormPersonalBooleanField;

  if (instance.lucky && instance.dynamax) {
    base = "luckyDynamax";
    shinyField = "luckyDynamaxShiny";
    fourStarField = "luckyDynamaxFourStar";
    shundoField = "luckyDynamaxShundo";
  } else if (instance.dynamax) {
    base = "dynamax";
    shinyField = "dynamaxShiny";
    fourStarField = "dynamaxFourStar";
    shundoField = "dynamaxShundo";
  } else if (instance.shadow) {
    base = "shadow";
    shinyField = "shadowShiny";
    fourStarField = "shadowFourStar";
    shundoField = "shadowShundo";
  } else if (instance.lucky) {
    base = "lucky";
    shinyField = "luckyShiny";
    fourStarField = "luckyFourStar";
    shundoField = "luckyShundo";
  } else {
    base = "caught";
    shinyField = "shiny";
    fourStarField = "fourStar";
    shundoField = "shundo";
  }

  if (instance.shiny && fourStar) return shundoField;
  if (instance.shiny) return shinyField;
  if (fourStar) return fourStarField;
  return base;
}
