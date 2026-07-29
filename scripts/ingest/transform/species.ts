// Species / form / form-type / mega-variant construction, plus the
// comparative-gap constants that describe what these sources can't
// reproduce. Ported from build-reference.ts's inline main() logic with two
// sourcing changes (gender + shadow now come from GAME_MASTER, shiny from
// the pokemongo-shiny sheet) and the two duplicate-scan fixes the ingestion
// plan called for: the shared pokedex `byId` map is now PokedexSource's own
// index (passed on to transform/evolutions.ts too), and the species/form
// pass and the old separate typesByFormSlug pass are one loop.

import { slugify, formSlug, megaVariantSlug } from "../slug";
import type { GameMasterIndex } from "../sources/game-master";
import type { AssetPair, PokedexEntry, PokedexSource } from "../sources/pokemon-go-api";
import type { ShinySheetSource } from "../sources/shiny-sheet";
import type { Form, FormType, Gender, MegaVariant, Rarity, Species } from "../../../src/db/types";
import type { ReferenceData, ReferenceGap } from "../../../src/db/reference-data";

// Form already carries shinyReleasedAt (the shiny *debut date* the
// pokemongo-shiny sheet publishes); `shinyAvailable` is derived from it
// (never set independently) so the two can't disagree. This alias is kept
// so call sites built against the pre-schema-column name don't need to
// change; it's structurally identical to Form now.
export type FormWithShinyDebut = Form;

export interface SpeciesBuildResult {
  species: Species[];
  forms: FormWithShinyDebut[];
  formTypes: FormType[];
  megaVariants: MegaVariant[];
  /** slug (species/form/mega) -> sprite source URLs, consumed by the sprite build. Returned rather than mutated into module state so this transform stays a pure function. */
  spriteManifest: Record<string, AssetPair>;
  gigantamaxSpeciesCount: number;
  duplicateFormsDropped: number;
}

// Basculegion (#902) isn't in pokemon-go-api's pokedex yet at all — confirmed
// directly against the cache, not inferred from a diff (see
// docs/v2-data-source-findings.md).
export const KNOWN_MISSING_SPECIES_DEX = new Set([902]);

// Species whose Gigantamax capability our source disagrees on: real GO data
// (docs/v2-data-source-findings.md §11, cross-checked by hand) says these
// 17 can Gigantamax, but pokemon-go-api's hasGigantamaxEvolution flag says
// no. Hardcoded rather than diffed against a prior commit — a diff against
// git HEAD would stop reporting this the moment it's ever committed once,
// since HEAD would then already reflect the gap and there'd be nothing left
// to diff (a real bug this replaced, caught by re-running the build a
// second time after the first cutover commit).
export const KNOWN_GIGANTAMAX_MISMATCH_DEX = new Set([25, 52, 133, 809, 823, 826, 834, 839, 841, 842, 844, 851, 858, 869, 879, 884, 892]);

// Evolution edges pokemon-go-api's evolutions[] data simply doesn't carry
// at all (confirmed by direct inspection of the cached pokedex.json — no
// base-entry or regionForm-entry evolutions[] array names the link), so
// family grouping can't reproduce these even after the regionForms-walk fix
// below. Hitmontop is different: it's not a source-data gap, but a
// pre-existing inconsistency in *production's own* data (Tyrogue's ascending-
// dex-order pipeline linked Hitmontop, dex 237, since Tyrogue was already
// processed by then, but never linked Hitmonlee/Hitmonchan, dex 106/107,
// since they're lower-dex and Tyrogue hadn't been processed yet) — logged
// here rather than silently replicated, since the "keep current" convention
// the owner chose was about mainline-first grouping in general, not this
// specific accident of processing order.
export const FAMILY_ROOT_GAP_NOTES: Map<number, string> = new Map([
  [292, "Shedinja: pokemon-go-api doesn't model a Nincada -> Shedinja evolution edge (Shedinja isn't obtained by evolving in Pokémon GO), so it roots its own family instead of Nincada's."],
  [899, "Wyrdeer: pokemon-go-api's Stantler entry has no evolutions[] data at all (Hisuian-item evolutions aren't modeled), so it roots its own family instead of Stantler's."],
  [900, "Kleavor: pokemon-go-api's Scyther entry has no evolution edge into Kleavor (Hisuian-item evolutions aren't modeled), so it roots its own family instead of Scyther's."],
  [1018, "Archaludon: pokemon-go-api's Duraludon entry has no evolutions[] data at all, so it roots its own family instead of Duraludon's."],
  [237, "Hitmontop: production's own old pipeline linked this to Tyrogue's family by processing-order accident (Tyrogue's lower dex meant Hitmonlee/Hitmonchan never got the same link) — not replicated here since it isn't a real design convention worth preserving."],
]);

export const GEN_TO_REGION: Record<number, string> = {
  1: "kanto", 2: "johto", 3: "hoenn", 4: "sinnoh", 5: "unova",
  6: "kalos", 7: "alola", 8: "galar", 9: "paldea",
};

// Comparative gaps: things the sources can't (yet) reproduce, or get wrong,
// against known facts about the real game — not a diff against whatever's
// currently committed (see KNOWN_GIGANTAMAX_MISMATCH_DEX above for why that
// approach doesn't stay correct across commits).
export function buildComparativeGaps(candidate: ReferenceData, previouslyMismatchedFamilyRootDex: Map<number, string>): ReferenceGap[] {
  const gaps: ReferenceGap[] = [];
  const candidateDex = new Set(candidate.species.map((s) => s.dexNumber));
  for (const dex of KNOWN_MISSING_SPECIES_DEX) {
    if (!candidateDex.has(dex)) {
      gaps.push({
        kind: "missing-species",
        speciesSlug: `dex-${dex}`,
        note: `Species #${dex} is not reproducible from the current sources — see docs/v2-data-source-findings.md.`,
      });
    }
  }

  for (const dex of KNOWN_GIGANTAMAX_MISMATCH_DEX) {
    const current = candidate.species.find((c) => c.dexNumber === dex);
    if (current && !current.canGigantamax) {
      gaps.push({
        kind: "gigantamax-mismatch",
        speciesSlug: current.slug,
        note: `${current.name} (#${dex}) can Gigantamax in the real game, but pokemon-go-api's hasGigantamaxEvolution flag says no — see docs/v2-data-source-findings.md §11.`,
      });
    }
  }

  for (const [dex, note] of previouslyMismatchedFamilyRootDex) {
    const current = candidate.species.find((c) => c.dexNumber === dex);
    if (current) gaps.push({ kind: "family-root-mismatch", speciesSlug: current.slug, note });
  }

  return gaps;
}

// Nidoran♀/♂ (dex 29/32) are pokemon-go-api's only species named with a raw
// gender symbol instead of text. They are NOT a gender split of one species
// (that's a real, separate case — e.g. Meowstic, Indeedee — modeled via
// Species.hasMale/hasFemale on a single species): Nidoran♀ and Nidoran♂ have
// distinct dex numbers and completely separate evolution lines (Nidorina/
// Nidoqueen vs. Nidorino/Nidorking), same as the current schema/
// reference.json already treats them (two Species rows, "Nidoran (F)"/
// "Nidoran (M)"). This is purely a *display*-name cleanup — slugs are not
// derived from names.English at all (see slugFor() below), so this doesn't
// need to dodge a slug collision, just match the existing UI convention for
// the "name" field.
const GENDER_SYMBOL_SUFFIX: Record<string, string> = { "♀": "(F)", "♂": "(M)" };

export function cleanSpeciesDisplayName(name: string): string {
  for (const [symbol, suffix] of Object.entries(GENDER_SYMBOL_SUFFIX)) {
    if (name.includes(symbol)) return `${name.replace(symbol, "").trim()} ${suffix}`;
  }
  return name;
}

// Slugs are built from pokemon-go-api's `id`/`formId` enum tokens, never
// from names.English. Those enum tokens come straight off the game's own
// data (GAME_MASTER), so they can't carry the kind of human-typo the old
// PokeAPI/CSV pipeline's name-derived slugs did — confirmed against the
// real reference.json, which has "revaroom"/"farigaraf" (misspelled) where
// pokemon-go-api's id is correctly "REVAVROOM"/"FARIGIRAF".
export function slugFor(id: string): string {
  return slugify(id);
}

// Region-form formIds are `${speciesId}_${TOKEN}` (e.g. RATTATA_ALOLA under
// species id RATTATA) — the TOKEN half is itself a stable enum value, so it
// makes a typo-proof form-slug token the same way species slugs use `id`.
export function formTokenFromFormId(formId: string, speciesId: string): string {
  const prefix = `${speciesId}_`;
  return formId.startsWith(prefix) ? formId.slice(prefix.length) : formId;
}

export function deriveRarity(pokemonClass: string | null | undefined): Rarity {
  if (pokemonClass === "POKEMON_CLASS_MYTHIC") return "mythical";
  if (pokemonClass === "POKEMON_CLASS_LEGENDARY") return "legendary";
  if (pokemonClass === "POKEMON_CLASS_ULTRA_BEAST") return "ultra_beast";
  return "standard";
}

export function gendersFor(hasMale: boolean, hasFemale: boolean): Gender[] {
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

// GAME_MASTER declares one genderSettings record per *spawnable form* of a
// species (base, "_NORMAL", every costume, plus explicit single-gender
// variants like SPAWN_V0592_POKEMON_FRILLISH_FEMALE). Species.hasMale/
// hasFemale ask "does this species have males/females at all", so the union
// across every record is the correct read — the old pipeline's "prefer the
// Normal-form record" rule was a statement about *pogoapi's* record
// structure, not a semantic claim, and reproducing it here would mark
// Frillish/Jellicent/Pyroar/Meowstic/Oinkologne male-only and Indeedee
// male-only (all six genuinely have both genders in game; Indeedee is
// female-only in the current reference.json, so the union is also what
// keeps its existing female form slugs alive).
export function gendersForSpecies(gameMaster: GameMasterIndex, pokemonId: string): { hasMale: boolean; hasFemale: boolean } {
  const records = gameMaster.genderSettingsFor(pokemonId);
  // No genderSettings record at all: keep build-reference.ts's original
  // both-genders fallback rather than silently emitting an "unknown" form.
  if (records.length === 0) return { hasMale: true, hasFemale: true };
  return {
    hasMale: records.some((r) => (r.gender?.malePercent ?? 0) > 0),
    hasFemale: records.some((r) => (r.gender?.femalePercent ?? 0) > 0),
  };
}

// GAME_MASTER's pokemonSettings carries a `shadow` block (purification cost,
// FRUSTRATION/RETURN move ids) only for species/forms that have actually
// been released as Shadow Pokémon — its presence is the availability signal
// (sanity-checked against Mew, which correctly has none). Records exist both
// per species (`BULBASAUR`) and per form (`BULBASAUR_NORMAL`,
// `RATTATA_ALOLA`), so a region form gets its own answer instead of
// inheriting the species-level one the old pogoapi shadow list gave.
function shadowAvailableFor(gameMaster: GameMasterIndex, pokemonId: string, form?: string): boolean {
  const formRecord = form ? gameMaster.getPokemonSettings(pokemonId, form) : undefined;
  const record = formRecord ?? gameMaster.getPokemonSettings(pokemonId);
  return record?.shadow !== undefined;
}

// The pokemongo-shiny sheet keys rows by the same `pm{dex}[.f{FORM}|.c{COSTUME}]`
// convention pokemon-go-api's assets use, but its token casing doesn't always
// match pokemon-go-api's (pgapi has Eevee's `May_2023` costume where the sheet
// has `MAY_2023`), so lookups are case-normalized here rather than going
// through the source module's exact-match byPid.
export interface ShinyLookup {
  /** `known` is true when the sheet has a row for any of these pids at all — a row with an empty `debut` is a deliberate "tracked, not released yet" statement (e.g. Eternatus `pm890`), which is exactly the false positive pokemon-go-api's `assets.shinyImage` presence produced. `debut` is the first non-empty ISO date found, else null. */
  formDebut(pids: string[]): { known: boolean; debut: string | null };
  /** The species-wide answer, equivalent to the old species-level shiny list: the base `pm{dex}` row's date when the sheet tracks one, otherwise the earliest date across any of that dex's form rows (species like Unown and Burmy have no base row at all, only per-form ones). */
  speciesDebut(dexNr: number): string | null;
}

export function createShinyLookup(shinySheet: ShinySheetSource): ShinyLookup {
  // The sheet's tokens follow pokemon-go-api's asset filenames but not its
  // casing (pgapi has Eevee's `May_2023` costume where the sheet has
  // `MAY_2023`), so every lookup is case-normalized.
  const byNormalizedPid = new Map<string, string>();
  const baseDebutByDex = new Map<number, string>();
  const baseRowByDex = new Set<number>();
  const earliestDebutByDex = new Map<number, string>();

  for (const record of shinySheet.all()) {
    if (!record.pid) continue;
    const key = record.pid.toUpperCase();
    const debut = record.debut ?? "";
    if (!byNormalizedPid.has(key)) byNormalizedPid.set(key, debut);

    const match = /^PM(\d+)(?:\.|$)/.exec(key);
    if (!match) continue;
    const dex = Number(match[1]);
    if (key === `PM${dex}`) {
      baseRowByDex.add(dex);
      if (debut) baseDebutByDex.set(dex, debut);
    }
    const earliest = earliestDebutByDex.get(dex);
    if (debut && (earliest === undefined || debut < earliest)) earliestDebutByDex.set(dex, debut);
  }

  return {
    formDebut(pids: string[]): { known: boolean; debut: string | null } {
      let known = false;
      for (const pid of pids) {
        const debut = byNormalizedPid.get(pid.toUpperCase());
        if (debut === undefined) continue;
        known = true;
        if (debut) return { known: true, debut };
      }
      return { known, debut: null };
    },
    speciesDebut(dexNr: number): string | null {
      if (baseRowByDex.has(dexNr)) return baseDebutByDex.get(dexNr) ?? null;
      return earliestDebutByDex.get(dexNr) ?? null;
    },
  };
}

// Baby Pokémon (breeding/incense-only precursors added after their
// mainline-evolution family already existed) are deliberately NOT linked
// as a family parent, matching production's existing convention (confirmed
// against src/data/reference.json: pichu.familySlug === "pichu", not
// "pikachu" — the old pipeline's dex-ascending single pass never linked
// these either, since a baby's dex number is higher than its already-evolved
// form's). pokemon-go-api's evolutions[] data is complete enough to link them
// (Pichu -> Pikachu), so without this exclusion the family root would shift
// to the baby for ~25 species, changing existing grouping behavior the owner
// explicitly chose to keep as-is.
const BABY_PRECURSOR_DEX = new Set([
  172, // Pichu -> Pikachu
  173, // Cleffa -> Clefairy
  174, // Igglybuff -> Jigglypuff
  236, // Tyrogue -> Hitmonlee/Hitmonchan
  238, // Smoochum -> Jynx
  239, // Elekid -> Electabuzz
  240, // Magby -> Magmar
  298, // Azurill -> Marill
  360, // Wynaut -> Wobbuffet
  406, // Budew -> Roselia
  433, // Chingling -> Chimecho
  438, // Bonsly -> Sudowoodo
  439, // Mime Jr. -> Mr. Mime
  440, // Happiny -> Chansey
  446, // Munchlax -> Snorlax
  458, // Mantyke -> Mantine
]);

export interface SpeciesBuildInput {
  pokedex: PokedexSource;
  gameMaster: GameMasterIndex;
  shinySheet: ShinySheetSource;
}

export function buildSpecies({ pokedex, gameMaster, shinySheet }: SpeciesBuildInput): SpeciesBuildResult {
  const entries = pokedex.all();
  const shiny = createShinyLookup(shinySheet);

  const species: Species[] = [];
  const forms: FormWithShinyDebut[] = [];
  const formTypes: FormType[] = [];
  const megaVariants: MegaVariant[] = [];
  const spriteManifest: Record<string, AssetPair> = {};

  // Pass 1: family grouping via evolutions[] (target dexNr -> source dexNr).
  // Match by `id` alone, not `formId` — evolutions[].formId uses a
  // different convention than the actual top-level entry's own formId
  // (e.g. Gloom's evolution into Vileplume references formId
  // "VILEPLUME_NORMAL", but Vileplume's real top-level entry has
  // formId==="VILEPLUME" — an id/formId mismatch was silently failing this
  // lookup for many species). `id` is reliably unique across all 1024
  // top-level entries (confirmed, including both Nidoran entries), so it's
  // the safe join key here — and it's PokedexSource's own index, shared with
  // transform/evolutions.ts instead of each doing its own linear .find().
  // Some evolution edges are only declared on a *regional form's* own
  // evolutions[] array, not the base species' (e.g. base DEERLING's
  // evolutions is empty — only DEERLING_AUTUMN/_SPRING/_SUMMER/_WINTER carry
  // the edge into SAWSBUCK; base ZIGZAGOON only evolves into LINOONE, but
  // ZIGZAGOON_GALARIAN's regionForm evolves into OBSTAGOON). Missing these
  // silently orphaned every Gen 8/9 "regional form evolves into a new
  // standalone species" chain (Obstagoon, Perrserker, Cursola, Sirfetch'd,
  // Mr. Rime, Runerigus, Wyrdeer, Kleavor, Sneasler, Overqwil, Clodsire,
  // Farigiraf, Archaludon) plus Sawsbuck — confirmed by direct inspection of
  // the cached pokedex.json, not assumed.
  const parentDexOf = new Map<number, number>();
  for (const entry of entries) {
    if (BABY_PRECURSOR_DEX.has(entry.dexNr)) continue;
    const evolutionSources = [entry, ...Object.values(entry.regionForms ?? {})];
    for (const source of evolutionSources) {
      for (const evo of source.evolutions ?? []) {
        const target = pokedex.byId(evo.id);
        if (target) parentDexOf.set(target.dexNr, entry.dexNr);
      }
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
  for (const entry of entries) slugByDex.set(entry.dexNr, slugFor(entry.id));

  function familySlugFor(dexNr: number): string {
    let current = dexNr;
    const seen = new Set<number>();
    while (parentDexOf.has(current) && !seen.has(current)) {
      seen.add(current);
      current = parentDexOf.get(current)!;
    }
    return slugByDex.get(current) ?? slugByDex.get(dexNr) ?? String(dexNr);
  }

  // Types: form-type assignment needs per-form type data, which the pokedex
  // entries don't carry directly per costume/region form beyond the base —
  // approximated as "every form of a species shares the species' base
  // types" (pokemon-go-api doesn't expose per-costume type overrides).
  // Region forms are separate pokedex entries with their own primaryType and
  // are recorded here too, but under the *species* slug, so a species with a
  // region form ends up with that form's types applied to all of its forms —
  // pre-existing behavior, deliberately preserved rather than "fixed" as
  // part of this restructuring.
  const typesBySpeciesSlug = new Map<string, string[]>();
  function recordTypes(entry: PokedexEntry, baseSlug: string) {
    const primary = entry.primaryType?.type?.replace("POKEMON_TYPE_", "").toLowerCase();
    const secondary = entry.secondaryType?.type?.replace("POKEMON_TYPE_", "").toLowerCase();
    typesBySpeciesSlug.set(baseSlug, [primary, secondary].filter((t): t is string => Boolean(t)));
  }

  let gigantamaxSpeciesCount = 0;

  for (const entry of entries) {
    // No formId===id filter here — see the slugByDex comment above. Every
    // top-level entry is its own species; regionForms are handled below,
    // per-species, from entry.regionForms.
    const displayName = cleanSpeciesDisplayName(entry.names.English);
    const slug = slugFor(entry.id);
    const gender = gendersForSpecies(gameMaster, entry.id);
    const rarity = deriveRarity(entry.pokemonClass);
    const canMegaEvolve = Object.keys(entry.megaEvolutions ?? {}).length > 0;
    const canGigantamax = entry.hasGigantamaxEvolution ?? false;

    // Same single pass as the species/form build (the old separate
    // typesByFormSlug loop recomputed slugFor(entry.id) for every entry).
    recordTypes(entry, slug);
    for (const region of Object.values(entry.regionForms ?? {})) recordTypes(region, slug);

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
    if (entry.assets) spriteManifest[slug] = entry.assets;

    const standardShinyDebut = shiny.speciesDebut(entry.dexNr);
    const standardShadow = shadowAvailableFor(gameMaster, entry.id, `${entry.id}_NORMAL`);

    // Standard form(s), one per gender. assetForms sometimes carries a
    // gender-specific "no form, no costume" entry (e.g. Pikachu's female
    // look) distinct from the species-level assets — prefer that per-gender
    // art when present, falling back to the species-level icon otherwise.
    // The shiny sheet's own per-gender rows (`.g2`) are display metadata for
    // its tracker UI, not separate releases, so both gender rows share the
    // species-level debut date.
    for (const g of gendersFor(gender.hasMale, gender.hasFemale)) {
      const fSlug = formSlug(slug, null, g);
      const genderedArt = entry.assetForms?.find((af) => !af.form && !af.costume && (g === "female" ? af.isFemale : !af.isFemale));
      const art = genderedArt ?? entry.assets;
      if (art) spriteManifest[fSlug] = art;
      forms.push({
        slug: fSlug,
        speciesSlug: slug,
        formName: "Standard",
        costumeName: null,
        gender: g,
        evolves: true,
        shinyAvailable: standardShinyDebut !== null,
        shinyReleasedAt: standardShinyDebut,
        shadowAvailable: standardShadow,
        // Not derivable from any current source — dynamax is only modeled
        // for the synthesized Gigantamax forms below.
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
      spriteManifest[fSlug] = af;
      // The sheet files most costumes under `.c{COSTUME}` but a handful
      // under `.f{COSTUME}` (its own tokens follow pokemon-go-api's asset
      // filenames, which differ per costume) — try both. Unlike the form
      // rows below there is no species-level fallback here: a costume's
      // shiny is its own separate release, the sheet tracks costumes
      // comprehensively, and the signal being replaced (pokemon-go-api
      // shipping a shiny costume *image*) is precisely the one confirmed to
      // over-report.
      const costumeDebut = shiny.formDebut([`pm${entry.dexNr}.c${costumeName}`, `pm${entry.dexNr}.f${costumeName}`]).debut;
      forms.push({
        slug: fSlug,
        speciesSlug: slug,
        formName: af.form ?? "Standard",
        costumeName,
        gender: g,
        evolves: false,
        shinyAvailable: costumeDebut !== null,
        shinyReleasedAt: costumeDebut,
        shadowAvailable: false,
        dynamaxAvailable: false,
        regionalExclusive: false,
        imageRef: null,
      });
    }

    // Region forms (e.g. Alolan Meowth) — own Form rows under the parent
    // species, not separate Species rows, matching the current schema.
    for (const region of Object.values(entry.regionForms ?? {})) {
      const regionToken = formTokenFromFormId(region.formId, entry.id);
      // A few region-form entries (e.g. Paldean Wooper) give names.English
      // identical to the base species' own name — no distinguishing text to
      // strip out — so falling back to the raw enum token id would be
      // uglier than necessary; title-case the token instead (PALDEA ->
      // Paldea) as a readable, if not perfectly grammatical, fallback.
      const regionDisplayLabel =
        region.names.English.replace(entry.names.English, "").trim() ||
        regionToken.charAt(0).toUpperCase() + regionToken.slice(1).toLowerCase();
      // The sheet writes some form tokens stripped of the species prefix
      // (`pm19.fALOLA` for RATTATA_ALOLA) and others in full
      // (`pm201.fUNOWN_G`, `pm412.fBURMY_PLANT`), so both spellings are
      // tried. When it tracks no row for the form at all — true of most
      // cosmetic/pattern forms — the species-level answer applies, which is
      // what the old species-level shiny list gave every form anyway.
      const regionMatch = shiny.formDebut([`pm${entry.dexNr}.f${region.formId}`, `pm${entry.dexNr}.f${regionToken}`]);
      const regionDebut = regionMatch.known ? regionMatch.debut : standardShinyDebut;
      const regionShadow = shadowAvailableFor(gameMaster, entry.id, region.formId);
      for (const g of gendersFor(gender.hasMale, gender.hasFemale)) {
        const fSlug = formSlug(slug, regionToken, g);
        if (region.assets) spriteManifest[fSlug] = region.assets;
        forms.push({
          slug: fSlug,
          speciesSlug: slug,
          formName: regionDisplayLabel,
          costumeName: null,
          gender: g,
          evolves: true,
          shinyAvailable: regionDebut !== null,
          shinyReleasedAt: regionDebut,
          shadowAvailable: regionShadow,
          dynamaxAvailable: false,
          regionalExclusive: true,
          imageRef: null,
        });
      }
    }

    // Gigantamax — synthesized per gender, gated on pokemon-go-api's
    // hasGigantamaxEvolution. Shiny availability prefers the sheet's own
    // `.fGIGANTAMAX` row (a Gigantamax shiny is a separate release with its
    // own date) and falls back to mirroring the Standard form, as the old
    // heuristic did, when the sheet tracks no such row.
    if (canGigantamax) {
      const gmaxArt = entry.assetForms?.find((af) => af.form === "GIGANTAMAX" && !af.costume);
      const gmaxMatch = shiny.formDebut([`pm${entry.dexNr}.fGIGANTAMAX`]);
      const gmaxDebut = gmaxMatch.known ? gmaxMatch.debut : standardShinyDebut;
      for (const g of gendersFor(gender.hasMale, gender.hasFemale)) {
        const fSlug = formSlug(slug, "Gigantamax", g);
        if (gmaxArt) spriteManifest[fSlug] = gmaxArt;
        forms.push({
          slug: fSlug,
          speciesSlug: slug,
          formName: "Gigantamax",
          costumeName: null,
          gender: g,
          evolves: false,
          shinyAvailable: gmaxDebut !== null,
          shinyReleasedAt: gmaxDebut,
          shadowAvailable: false,
          dynamaxAvailable: true,
          regionalExclusive: false,
          imageRef: null,
        });
      }
      gigantamaxSpeciesCount++;
    }

    for (const [megaFormId, megaEntry] of Object.entries(entry.megaEvolutions ?? {})) {
      const variant = megaVariantKindFromId(megaFormId);
      const megaSlug = megaVariantSlug(slug, variant);
      if (megaEntry.assets) spriteManifest[megaSlug] = megaEntry.assets;
      megaVariants.push({ slug: megaSlug, speciesSlug: slug, variant });
    }
  }

  // A handful of species (e.g. Darmanitan) model their base Kantonian
  // form as its own named regionForms entry ("DARMANITAN_STANDARD") on top
  // of the species' own top-level entry — formTokenFromFormId strips the
  // species-id prefix and gets "standard" back, colliding with the
  // always-created base Standard form above. Keep the first occurrence
  // (the base loop's own Standard form) and drop the duplicate rather than
  // let a slug collision reach the database as a silent overwrite/crash.
  const seenFormSlugs = new Set<string>();
  const dedupedForms: FormWithShinyDebut[] = [];
  let duplicateFormsDropped = 0;
  for (const f of forms) {
    if (seenFormSlugs.has(f.slug)) {
      duplicateFormsDropped++;
      continue;
    }
    seenFormSlugs.add(f.slug);
    dedupedForms.push(f);
  }

  for (const f of dedupedForms) {
    for (const t of typesBySpeciesSlug.get(f.speciesSlug) ?? []) formTypes.push({ formSlug: f.slug, typeSlug: t });
  }

  return {
    species,
    forms: dedupedForms,
    formTypes,
    megaVariants,
    spriteManifest,
    gigantamaxSpeciesCount,
    duplicateFormsDropped,
  };
}
