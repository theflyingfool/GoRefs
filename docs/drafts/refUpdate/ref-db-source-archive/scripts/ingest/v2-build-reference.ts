// V2 sourcing spike — the parity build. Consumes ONLY scripts/ingest/.cache-v2
// data (pokemon-go-api + pogoapi.net) — no PokeAPI, no CSVs, no wikitext —
// and produces a candidate reference.json in the same shape
// build-reference.ts produces today, to see how close the new sources get
// before extending to any new tables. See docs/v2-schema-design.md and the
// V2 ingestion plan for context.
//
// Several fields in the current schema are hand-curated tracker data (per-
// form shiny/shadow/dynamax availability) that neither new source exposes
// directly — these are approximated here (documented inline) and are
// expected to show up as differences in v2-compare-reference.ts's report,
// not silently treated as correct.
//
// Requires: npm run ingest:v2:fetch (and, for full parity checking,
// ingest:v2:fetch-assets). Run with: npm run ingest:v2:build

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CACHE_V2_ROOT } from "./v2-http-cache";
import { slugify, formSlug, megaVariantSlug } from "./slug";
import type { Species, Form, FormType, MegaVariant, Gender, Rarity } from "../../src/db/types";
import type { ReferenceData } from "../../src/db/reference-data";

const OUT_DIR = resolve(process.cwd(), "data-authoring/v2-explore");
const OUT_PATH = resolve(OUT_DIR, "reference-v2-candidate.json");

const GEN_TO_REGION: Record<number, string> = {
  1: "kanto", 2: "johto", 3: "hoenn", 4: "sinnoh", 5: "unova",
  6: "kalos", 7: "alola", 8: "galar", 9: "paldea",
};

// Nidoran♀/♂ (dex 29/32) are pokemon-go-api's only species named with a raw
// gender symbol instead of text — slugify() strips ♀/♂ as non-alphanumeric,
// which collapses both to the same "nidoran" slug. They are NOT a gender
// split of one species (that's a real, separate case — e.g. Meowstic,
// Indeedee — modeled via Species.hasMale/hasFemale on a single species):
// Nidoran♀ and Nidoran♂ have distinct dex numbers and completely separate
// evolution lines (Nidorina/Nidoqueen vs. Nidorino/Nidorking), same as the
// current schema/reference.json already treats them (two Species rows,
// "Nidoran (F)"/"Nidoran (M)"). This just matches that existing display
// convention so the slug comes out the same.
const GENDER_SYMBOL_SUFFIX: Record<string, string> = { "♀": "(F)", "♂": "(M)" };

function cleanSpeciesDisplayName(name: string): string {
  for (const [symbol, suffix] of Object.entries(GENDER_SYMBOL_SUFFIX)) {
    if (name.includes(symbol)) return `${name.replace(symbol, "").trim()} ${suffix}`;
  }
  return name;
}

interface AssetPair {
  image?: string;
  shinyImage?: string;
}
interface AssetForm extends AssetPair {
  form: string | null;
  costume: string | null;
  isFemale: boolean;
}
interface Evolution {
  id: string;
  formId?: string;
  candies?: number;
}
interface PokedexEntry {
  id: string;
  formId: string;
  dexNr: number;
  generation?: number;
  names: { English: string };
  pokemonClass?: string | null;
  primaryType?: { type: string };
  secondaryType?: { type: string } | null;
  assets?: AssetPair;
  assetForms?: AssetForm[];
  regionForms?: Record<string, PokedexEntry>;
  megaEvolutions?: Record<string, unknown>;
  hasGigantamaxEvolution?: boolean;
  evolutions?: Evolution[];
}

interface GenderRecord {
  pokemon_id: number;
  form: string;
  gender?: { male_percent?: number; female_percent?: number };
}

function loadJson<T>(relPath: string): T {
  return JSON.parse(readFileSync(resolve(CACHE_V2_ROOT, relPath), "utf-8")) as T;
}

function deriveRarity(pokemonClass: string | null | undefined): Rarity {
  if (pokemonClass === "POKEMON_CLASS_MYTHIC") return "mythical";
  if (pokemonClass === "POKEMON_CLASS_LEGENDARY") return "legendary";
  if (pokemonClass === "POKEMON_CLASS_ULTRA_BEAST") return "ultra_beast";
  return "standard";
}

function gendersFor(hasMale: boolean, hasFemale: boolean): Gender[] {
  if (hasMale && hasFemale) return ["male", "female"];
  if (hasMale) return ["male"];
  if (hasFemale) return ["female"];
  return ["unknown"];
}

function megaVariantKindFromId(megaFormId: string): "X" | "Y" | "Primal" | null {
  if (megaFormId.endsWith("_MEGA_X")) return "X";
  if (megaFormId.endsWith("_MEGA_Y")) return "Y";
  if (megaFormId.endsWith("_PRIMAL")) return "Primal";
  return null;
}

async function main() {
  console.log("Loading cached data...");
  const pokedex = loadJson<PokedexEntry[]>("pgapi/pokedex.json");
  const genderRecordsByBucket = loadJson<Record<string, GenderRecord[]>>("pogoapi/pokemon_genders.json");
  const shinySpeciesData = loadJson<Record<string, { id: number }>>("pogoapi/shiny_pokemon.json");
  const shadowSpeciesData = loadJson<Record<string, { id: number }>>("pogoapi/shadow_pokemon.json");

  // pokemon_id -> {hasMale, hasFemale}, derived from the "Normal" form record
  // per species (falls back to any record for that species if no "Normal").
  const genderById = new Map<number, { hasMale: boolean; hasFemale: boolean }>();
  for (const [bucket, records] of Object.entries(genderRecordsByBucket)) {
    for (const rec of records) {
      const existing = genderById.get(rec.pokemon_id);
      if (existing && rec.form !== "Normal") continue; // prefer the Normal-form record
      if (bucket === "Genderless") {
        genderById.set(rec.pokemon_id, { hasMale: false, hasFemale: false });
        continue;
      }
      const femalePercent = rec.gender?.female_percent ?? (rec.gender?.male_percent !== undefined ? 1 - rec.gender.male_percent : undefined);
      if (femalePercent === undefined) continue;
      genderById.set(rec.pokemon_id, { hasMale: femalePercent < 1, hasFemale: femalePercent > 0 });
    }
  }

  const shinySpeciesIds = new Set(Object.values(shinySpeciesData).map((v) => v.id));
  const shadowSpeciesIds = new Set(Object.values(shadowSpeciesData).map((v) => v.id));

  const species: Species[] = [];
  const forms: Form[] = [];
  const formTypes: FormType[] = [];
  const megaVariants: MegaVariant[] = [];

  // Pass 1: family grouping via evolutions[] (target dexNr -> source dexNr).
  // Match by `id` alone, not `formId` — evolutions[].formId uses a
  // different convention than the actual top-level entry's own formId
  // (e.g. Gloom's evolution into Vileplume references formId
  // "VILEPLUME_NORMAL", but Vileplume's real top-level entry has
  // formId==="VILEPLUME" — an id/formId mismatch was silently failing this
  // lookup for many species). `id` is reliably unique across all 1024
  // top-level entries (confirmed, including both Nidoran entries), so it's
  // the safe join key here.
  const parentDexOf = new Map<number, number>();
  for (const entry of pokedex) {
    for (const evo of entry.evolutions ?? []) {
      const target = pokedex.find((e) => e.id === evo.id);
      if (target) parentDexOf.set(target.dexNr, entry.dexNr);
    }
  }
  // The top-level pokedex array is already one entry per species/dex number
  // (confirmed: 1024 entries, 1024 unique dexNr) — regional forms only ever
  // appear nested under regionForms, never duplicated at this level. The
  // only two entries whose formId differs from id are Nidoran♀/♂
  // (id: NIDORAN_FEMALE/NIDORAN_MALE, formId: NIDORAN for both) — they are
  // genuinely distinct species (separate dex numbers 29/32, separate
  // evolution lines), not a gender-variant pair of one species, so no
  // formId===id filter belongs here at all; iterating every top-level entry
  // unconditionally is correct.
  const slugByDex = new Map<number, string>();
  for (const entry of pokedex) {
    slugByDex.set(entry.dexNr, slugify(cleanSpeciesDisplayName(entry.names.English)));
  }
  function familySlugFor(dexNr: number): string {
    let current = dexNr;
    const seen = new Set<number>();
    while (parentDexOf.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentDexOf.get(current)!;
    }
    return slugByDex.get(current) ?? slugByDex.get(dexNr) ?? String(dexNr);
  }

  let skippedGigantamaxOnly = 0;

  for (const entry of pokedex) {
    // No formId===id filter here — see the slugByDex comment above. Every
    // top-level entry is its own species; regionForms are handled below,
    // per-species, from entry.regionForms.
    const displayName = cleanSpeciesDisplayName(entry.names.English);
    const slug = slugify(displayName);
    const gender = genderById.get(entry.dexNr) ?? { hasMale: true, hasFemale: true };
    const rarity = deriveRarity(entry.pokemonClass);
    const canMegaEvolve = Object.keys(entry.megaEvolutions ?? {}).length > 0;
    const canGigantamax = entry.hasGigantamaxEvolution ?? false;

    species.push({
      slug,
      dexNumber: entry.dexNr,
      name: displayName,
      familySlug: familySlugFor(entry.dexNr),
      gen: entry.generation ?? 0,
      rarity,
      regionSlug: GEN_TO_REGION[entry.generation ?? 0] ?? "unidentified",
      hasMale: gender.hasMale,
      hasFemale: gender.hasFemale,
      canMegaEvolve,
      canGigantamax,
    });

    const shinyAvailable = shinySpeciesIds.has(entry.dexNr);
    const shadowAvailable = shadowSpeciesIds.has(entry.dexNr);

    // Standard form(s), one per gender.
    for (const g of gendersFor(gender.hasMale, gender.hasFemale)) {
      const fSlug = formSlug(slug, null, g);
      forms.push({
        slug: fSlug,
        speciesSlug: slug,
        formName: "Standard",
        costumeName: null,
        gender: g,
        evolves: true,
        shinyAvailable,
        shadowAvailable,
        // Not derivable from either source today — see file header comment.
        dynamaxAvailable: false,
        regionalExclusive: false,
        imageRef: null,
      });
    }

    // Costume forms, from assetForms[] — gender comes directly from
    // isFemale (genderless species always report isFemale:false; mapped to
    // "unknown" rather than mislabeled "male").
    for (const af of entry.assetForms ?? []) {
      if (!af.costume) continue;
      const g: Gender = !gender.hasMale && !gender.hasFemale ? "unknown" : af.isFemale ? "female" : "male";
      const costumeName = af.costume;
      const fSlug = formSlug(slug, af.form, g, costumeName);
      forms.push({
        slug: fSlug,
        speciesSlug: slug,
        formName: af.form ?? "Standard",
        costumeName,
        gender: g,
        evolves: false,
        shinyAvailable: Boolean(af.shinyImage),
        shadowAvailable: false,
        dynamaxAvailable: false,
        regionalExclusive: false,
        imageRef: null,
      });
    }

    // Region forms (e.g. Alolan Meowth) — own Form rows under the parent
    // species, not separate Species rows, matching the current schema.
    for (const region of Object.values(entry.regionForms ?? {})) {
      const regionLabel = region.names.English.replace(entry.names.English, "").trim() || region.formId;
      for (const g of gendersFor(gender.hasMale, gender.hasFemale)) {
        const fSlug = formSlug(slug, regionLabel, g);
        forms.push({
          slug: fSlug,
          speciesSlug: slug,
          formName: regionLabel,
          costumeName: null,
          gender: g,
          evolves: true,
          shinyAvailable,
          shadowAvailable,
          dynamaxAvailable: false,
          regionalExclusive: true,
          imageRef: null,
        });
      }
    }

    // Gigantamax — synthesized per gender, mirroring the Standard form's
    // shiny availability, same heuristic as the current pipeline's
    // Obsidian-sheet-driven step, just gated on pokemon-go-api's corrected
    // hasGigantamaxEvolution instead.
    if (canGigantamax) {
      for (const g of gendersFor(gender.hasMale, gender.hasFemale)) {
        const fSlug = formSlug(slug, "Gigantamax", g);
        forms.push({
          slug: fSlug,
          speciesSlug: slug,
          formName: "Gigantamax",
          costumeName: null,
          gender: g,
          evolves: false,
          shinyAvailable,
          shadowAvailable: false,
          dynamaxAvailable: true,
          regionalExclusive: false,
          imageRef: null,
        });
      }
      skippedGigantamaxOnly++;
    }

    for (const [megaFormId] of Object.entries(entry.megaEvolutions ?? {})) {
      const variant = megaVariantKindFromId(megaFormId);
      megaVariants.push({ slug: megaVariantSlug(slug, variant), speciesSlug: slug, variant });
    }
  }

  // Types: form-type assignment needs per-form type data, which the pokedex
  // entries don't carry directly per costume/region form beyond the base —
  // approximated here as "every form of a species shares the species' base
  // types" (pokemon-go-api doesn't expose per-costume type overrides, and
  // in practice costumes/regions rarely differ — region forms are the
  // known exception, e.g. Alolan Meowth is Dark not Normal, handled since
  // regionForms are separate pokedex entries with their own primaryType —
  // wired in below instead of the placeholder above).
  const typesByFormSlug = new Map<string, string[]>();
  function recordTypes(entry: PokedexEntry, baseSlug: string) {
    const primary = entry.primaryType?.type?.replace("POKEMON_TYPE_", "").toLowerCase();
    const secondary = entry.secondaryType?.type?.replace("POKEMON_TYPE_", "").toLowerCase();
    const types = [primary, secondary].filter((t): t is string => Boolean(t));
    typesByFormSlug.set(baseSlug, types);
  }
  for (const entry of pokedex) {
    const slug = slugify(cleanSpeciesDisplayName(entry.names.English));
    recordTypes(entry, slug);
    for (const region of Object.values(entry.regionForms ?? {})) {
      recordTypes(region, slug); // types keyed by species slug, applied per-form below
    }
  }
  for (const f of forms) {
    const types = typesByFormSlug.get(f.speciesSlug) ?? [];
    for (const t of types) formTypes.push({ formSlug: f.slug, typeSlug: t });
  }

  const allTypeSlugs = new Set(formTypes.map((ft) => ft.typeSlug));

  const referenceData: ReferenceData = {
    regions: [...new Set(Object.values(GEN_TO_REGION))].map((slug) => ({ slug, name: capitalize(slug) })),
    types: [...allTypeSlugs].map((slug) => ({ slug, name: capitalize(slug) })),
    backgrounds: [
      { slug: "spring-2024", name: "Spring 2024" },
      { slug: "anniversary-2016", name: "8th Anniversary" },
    ],
    species,
    forms,
    formTypes,
    megaVariants,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(referenceData));

  console.log(`Wrote ${species.length} species, ${forms.length} forms (${skippedGigantamaxOnly} with Gigantamax), ${megaVariants.length} mega variants.`);
  console.log(`-> ${OUT_PATH}`);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
