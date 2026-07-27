// Shared in-memory query/filter engine backing the SQLite repository
// implementation (src/data/sqlite-repository.ts). Reference data is
// read-only once loaded; personal data lives in a plain mutable object here,
// and every mutation calls a hook so the caller can write it through to real
// SQLite.
//
// Completion stats are deliberately NOT computed here — that's real
// parameterized SQL in completion-stats-sql.ts (CLAUDE.md asks for this, not
// an in-memory scan). This module used to also carry an equivalent
// plain-JS implementation for a since-deleted localStorage-backed dummy
// repository.

import { resolveFormFieldCascade } from "../db/cascades";
import { emptyFormPersonal, emptyMedalProgress, emptyMegaPersonal, emptySpeciesPersonal } from "../db/defaults";
import type { ReferenceData } from "../db/reference-data";
import { CURRENT_PERSONAL_SCHEMA_VERSION } from "../db/schema";
import {
  FORM_PERSONAL_BOOLEAN_FIELDS,
  type Form,
  type FormBackgroundPersonal,
  type FormPersonal,
  type FormPersonalBooleanField,
  type MedalProgressPersonal,
  type MegaPersonal,
  type MegaVariant,
  type PlayerProgressLogEntry,
  type PlayerProgressPersonal,
  type PokemonInstance,
  type PokemonInstanceStatus,
  type PokemonInstanceTag,
  type PokemonType,
  type Profile,
  type Region,
  type Species,
  type SpeciesPersonal,
  type Tag,
} from "../db/types";
import {
  fuzzyMatches,
  MAX_GRID_INDICATORS,
  parseSearchQuery,
  type GridFilterField,
  type ImportResult,
  type MedalProgress,
  type PersonalDataExport,
  type PokemonInstanceFilter,
  type PokemonInstanceWithSpecies,
  type Repository,
  type SearchKeyword,
  type SpecimenStateCounts,
  type SpeciesFilter,
  type SpeciesMegaVariant,
  type SpeciesSummary,
  type SpeciesWithForms,
  type TagCount,
} from "./repository";

const INDICATOR_SETTING_KEY = "grid_indicators";

export interface PersonalState {
  speciesPersonal: Record<string, SpeciesPersonal>;
  formPersonal: Record<string, FormPersonal>;
  appSettings: Record<string, string>;
  megaPersonal: Record<string, MegaPersonal>;
  /** Read/exported for completeness — no UI writes this yet (see repository.ts). */
  formBackgroundPersonal: FormBackgroundPersonal[];
  medalProgress: Record<string, MedalProgressPersonal>;
  pokemonInstances: PokemonInstance[];
  pokemonInstanceTags: PokemonInstanceTag[];
  playerProgress: PlayerProgressPersonal | undefined;
  playerProgressLog: PlayerProgressLogEntry[];
  profile: Profile;
}

export interface InMemoryStoreHooks {
  onSpeciesPersonalChanged(speciesSlug: string, personal: SpeciesPersonal): void;
  onFormPersonalChanged(formSlug: string, personal: FormPersonal): void;
  onAppSettingChanged(key: string, value: string): void;
  onMegaPersonalChanged(megaVariantSlug: string, personal: MegaPersonal): void;
  /** Fires once per newly-added link — form_background_personal has no per-row setter yet (see repository.ts), only import can add to it, and only ever as a brand-new row (composite PK, no update-in-place case). */
  onFormBackgroundPersonalAdded(row: FormBackgroundPersonal): void;
  onMedalProgressChanged(medalSlug: string, progress: MedalProgressPersonal): void;
  onPlayerProgressChanged(progress: PlayerProgressPersonal): void;
  /** Fires once per setPlayerProgress call, right after onPlayerProgressChanged — the log entry itself gets a real AUTOINCREMENT id from the real backend, same reasoning as onPokemonInstanceStatusChanged's comment below, but a plain hook is enough here since nothing needs that id back synchronously. */
  onPlayerProgressLogAppended(entry: PlayerProgressLogEntry): void;
  /** Existing-row status update only — creation (which needs a real AUTOINCREMENT id) is implemented directly in sqlite-repository.ts, not through this shared hook. */
  onPokemonInstanceStatusChanged(instance: PokemonInstance): void;
}

export function createInMemoryRepository(
  referenceData: ReferenceData,
  state: PersonalState,
  hooks: InMemoryStoreHooks,
  // Tags are device-wide, not part of PersonalState (see PersonalState's
  // doc comment / task-6 design note). This is a getter, not a plain array,
  // because the caller (sqlite-repository.ts) reassigns its `sharedTags`
  // binding wholesale on every create/rename/delete (`sharedTags = ...`)
  // rather than mutating in place — a getter closing over that `let` always
  // observes the latest array; a value captured once here would go stale
  // after the first mutation.
  getSharedTags: () => Tag[],
): Omit<
  Repository,
  | "getCompletionStats"
  | "createPokemonInstances"
  | "createTag"
  | "updatePokemonInstance"
  | "listBackgrounds"
  | "getTagUsageCounts"
  | "renameTag"
  | "deleteTag"
  | "listProfiles"
  | "getCurrentProfile"
  | "createProfile"
  | "switchProfile"
  | "renameProfile"
  | "deleteProfile"
  | "exportTrainer"
  | "listReferencedTrainers"
  | "planTrainerImport"
  | "applyTrainerImport"
> {
  const speciesBySlug = new Map<string, Species>(referenceData.species.map((s) => [s.slug, s]));
  const speciesByDexOrder = [...referenceData.species].sort((a, b) => a.dexNumber - b.dexNumber);
  const formsBySpecies = new Map<string, Form[]>();
  const speciesSlugByFormSlug = new Map<string, string>();
  for (const f of referenceData.forms) {
    const list = formsBySpecies.get(f.speciesSlug) ?? [];
    list.push(f);
    formsBySpecies.set(f.speciesSlug, list);
    speciesSlugByFormSlug.set(f.slug, f.speciesSlug);
  }

  const typesBySlug = new Map<string, PokemonType>(referenceData.types.map((t) => [t.slug, t]));
  const formTypesByFormSlug = new Map<string, PokemonType[]>();
  for (const ft of referenceData.formTypes) {
    const list = formTypesByFormSlug.get(ft.formSlug) ?? [];
    const type = typesBySlug.get(ft.typeSlug);
    if (type) list.push(type);
    formTypesByFormSlug.set(ft.formSlug, list);
  }

  const megaVariantsBySpecies = new Map<string, MegaVariant[]>();
  const speciesSlugByMegaVariantSlug = new Map<string, string>();
  for (const mv of referenceData.megaVariants) {
    const list = megaVariantsBySpecies.get(mv.speciesSlug) ?? [];
    list.push(mv);
    megaVariantsBySpecies.set(mv.speciesSlug, list);
    speciesSlugByMegaVariantSlug.set(mv.slug, mv.speciesSlug);
  }

  const medalSlugs = new Set(referenceData.medals.map((m) => m.slug));
  const medalTiersByMedalSlug = new Map<string, typeof referenceData.medalTiers>();
  for (const tier of referenceData.medalTiers) {
    const list = medalTiersByMedalSlug.get(tier.medalSlug) ?? [];
    list.push(tier);
    medalTiersByMedalSlug.set(tier.medalSlug, list);
  }

  function formWithSpeciesForInstance(instance: PokemonInstance): PokemonInstanceWithSpecies | undefined {
    const form = formsBySpecies.get(speciesSlugByFormSlug.get(instance.formSlug) ?? "")?.find((f) => f.slug === instance.formSlug);
    const speciesSlug = speciesSlugByFormSlug.get(instance.formSlug);
    const species = speciesSlug ? speciesBySlug.get(speciesSlug) : undefined;
    if (!form || !species) return undefined;
    const tagIds = new Set(state.pokemonInstanceTags.filter((t) => t.pokemonInstanceId === instance.id).map((t) => t.tagId));
    const tags = getSharedTags().filter((t) => tagIds.has(t.id));
    return { instance, form, species, tags };
  }

  function matchesSearchKeyword(species: Species, keyword: SearchKeyword): boolean {
    switch (keyword) {
      case "legendary":
        return species.rarity === "legendary";
      case "mythical":
        return species.rarity === "mythical";
      case "ultraBeast":
        return species.rarity === "ultra_beast";
      case "costume":
        // "Has this species ever had a costume" — species-level, matching
        // what the Dex grid's search box means by the keyword. Bulk Edit
        // additionally filters at the individual form/tile level (see
        // bulk-form-edit.ts) since a species can mix costume and non-costume
        // forms and its tiles are per-form, not per-species.
        return (formsBySpecies.get(species.slug) ?? []).some((f) => f.costumeName !== null);
    }
  }

  function matchesSearch(species: Species, search: string): boolean {
    const parsed = parseSearchQuery(search);
    if (parsed.keyword) {
      const matches = matchesSearchKeyword(species, parsed.keyword);
      return parsed.negate ? !matches : matches;
    }
    const q = parsed.text.trim();
    if (!q) return true;
    // All-digit query = dex-number intent, exact only — a substring match on
    // the number ("25" also matching #125/#225/#250-259/...) was real search
    // noise for something meant to jump to one species. Anything else is a
    // name, fuzzy-matched (see fuzzyMatches in repository.ts).
    if (/^\d+$/.test(q)) return species.dexNumber === Number(q);
    return fuzzyMatches(species.name, q);
  }

  function resolveFieldValue(
    field: GridFilterField,
    species: Species,
    personal: SpeciesPersonal,
    indicators: Record<FormPersonalBooleanField, boolean>,
  ): boolean {
    switch (field) {
      case "legendary":
        return species.rarity === "legendary";
      case "mythical":
        return species.rarity === "mythical";
      case "ultraBeast":
        return species.rarity === "ultra_beast";
      case "xxl":
      case "xxs":
      case "purified":
        return personal[field];
      case "megaCapable":
        return species.canMegaEvolve;
      case "megaEvolved":
        // Any-variant OR, same convention as the form-achievement indicators
        // above (e.g. Charizard counts as "mega evolved" once you've done
        // either X or Y, not only once you've done both — that stricter
        // all-variants bar is what the megaComplete *stats lens* tracks).
        return (megaVariantsBySpecies.get(species.slug) ?? []).some((mv) => (state.megaPersonal[mv.slug] ?? emptyMegaPersonal(mv.slug)).evolved);
      case "dynamaxCapable":
        return (formsBySpecies.get(species.slug) ?? []).some((f) => f.dynamaxAvailable);
      case "gigantamaxCapable":
        return species.canGigantamax;
      default:
        return indicators[field];
    }
  }

  function matchesFieldFilters(
    species: Species,
    personal: SpeciesPersonal,
    indicators: Record<FormPersonalBooleanField, boolean>,
    fieldFilters: SpeciesFilter["fieldFilters"],
  ): boolean {
    if (!fieldFilters) return true;
    return Object.entries(fieldFilters).every(([field, want]) => {
      const value = resolveFieldValue(field as GridFilterField, species, personal, indicators);
      return want === "include" ? value : !value;
    });
  }

  function setAppSetting(key: string, value: string) {
    state.appSettings[key] = value;
    hooks.onAppSettingChanged(key, value);
  }

  function isFormPersonalBooleanField(field: keyof Omit<FormPersonal, "formSlug">): field is FormPersonalBooleanField {
    return (FORM_PERSONAL_BOOLEAN_FIELDS as readonly string[]).includes(field);
  }

  // Reusable merge step: given the current record and one field being set,
  // returns the record with that field applied PLUS every field its cascade
  // implies (transitively — see resolveFormFieldCascade), all merged into a
  // single object. Pure/no side effects, so a future bulk-edit feature can
  // call this once per row and batch the writes, rather than duplicating the
  // cascade-resolution logic. Only `true`-valued boolean fields cascade —
  // unchecking (false) and non-boolean fields (bestShiny/etc.) pass through
  // unchanged, per the forward-only cascade rule.
  function mergeFormPersonalCascade(base: FormPersonal, field: keyof Omit<FormPersonal, "formSlug">, value: boolean): FormPersonal {
    const updated: FormPersonal = { ...base, [field]: value };
    if (value && isFormPersonalBooleanField(field)) {
      for (const implied of resolveFormFieldCascade(field)) {
        updated[implied] = true;
      }
    }
    return updated;
  }

  // Cross-cutting species-level cascade: if the merged form-personal record
  // has any boolean field true, that form's species must be "registered"
  // (you can't own an achievement on a form of a species you haven't caught
  // at all). Skips the write entirely if already registered, so toggling
  // further fields within an already-registered species doesn't produce a
  // redundant species_personal write on every keystroke.
  function cascadeSpeciesRegisteredForForm(formSlug: string, updated: FormPersonal): void {
    const anyTrue = FORM_PERSONAL_BOOLEAN_FIELDS.some((field) => updated[field]);
    if (!anyTrue) return;
    const speciesSlug = speciesSlugByFormSlug.get(formSlug);
    if (!speciesSlug) return;
    const currentSpecies = state.speciesPersonal[speciesSlug] ?? emptySpeciesPersonal(speciesSlug);
    if (currentSpecies.registered) return;
    const updatedSpecies: SpeciesPersonal = { ...currentSpecies, registered: true, updatedAt: Date.now() };
    state.speciesPersonal[speciesSlug] = updatedSpecies;
    hooks.onSpeciesPersonalChanged(speciesSlug, updatedSpecies);
  }

  // Single apply-step for one form field, factored out of setFormPersonalField
  // so the batched bulkSetFormPersonalField can reuse the EXACT same
  // cascade+persist path (mergeFormPersonalCascade for the forward-only field
  // cascade, then cascadeSpeciesRegisteredForForm for the species side) rather
  // than duplicating it and risking drift from the single-edit behavior.
  function applyFormPersonalField(formSlug: string, field: keyof Omit<FormPersonal, "formSlug">, value: boolean): void {
    const current = state.formPersonal[formSlug] ?? emptyFormPersonal(formSlug);
    const updated = { ...mergeFormPersonalCascade(current, field, value), updatedAt: Date.now() };
    state.formPersonal[formSlug] = updated;
    hooks.onFormPersonalChanged(formSlug, updated);
    cascadeSpeciesRegisteredForForm(formSlug, updated);
  }

  // Species counterpart to applyFormPersonalField — same reason: shared by the
  // single setter and the batched bulkSetSpeciesPersonalField so the
  // xxl/xxs/purified → registered cascade stays identical between them.
  function applySpeciesPersonalField(speciesSlug: string, field: keyof Omit<SpeciesPersonal, "speciesSlug">, value: boolean): void {
    const current = state.speciesPersonal[speciesSlug] ?? emptySpeciesPersonal(speciesSlug);
    const impliesRegistered = value && (field === "xxl" || field === "xxs" || field === "purified");
    const updated: SpeciesPersonal = { ...current, [field]: value, ...(impliesRegistered ? { registered: true } : {}), updatedAt: Date.now() };
    state.speciesPersonal[speciesSlug] = updated;
    hooks.onSpeciesPersonalChanged(speciesSlug, updated);
  }

  // Mega is species-wide (not per-form, see repository.ts), so its only
  // cascade is straight to species_personal.registered — no form-field
  // cascade machinery needed. shinyEvolved implies evolved (forward-only,
  // same rule as every other cascade: unchecking never cascades) since you
  // can't have shiny-mega-evolved something without having mega-evolved it
  // at all.
  function applyMegaPersonalField(megaVariantSlug: string, field: keyof Omit<MegaPersonal, "megaVariantSlug">, value: boolean): void {
    const current = state.megaPersonal[megaVariantSlug] ?? emptyMegaPersonal(megaVariantSlug);
    const updated: MegaPersonal = { ...current, [field]: value, updatedAt: Date.now() };
    if (value && field === "shinyEvolved") updated.evolved = true;
    state.megaPersonal[megaVariantSlug] = updated;
    hooks.onMegaPersonalChanged(megaVariantSlug, updated);

    if (!updated.evolved) return;
    const speciesSlug = speciesSlugByMegaVariantSlug.get(megaVariantSlug);
    if (!speciesSlug) return;
    const currentSpecies = state.speciesPersonal[speciesSlug] ?? emptySpeciesPersonal(speciesSlug);
    if (currentSpecies.registered) return;
    const updatedSpecies: SpeciesPersonal = { ...currentSpecies, registered: true, updatedAt: Date.now() };
    state.speciesPersonal[speciesSlug] = updatedSpecies;
    hooks.onSpeciesPersonalChanged(speciesSlug, updatedSpecies);
  }

  function applyMedalProgress(medalSlug: string, currentRank: number, currentCount: number): void {
    const updated: MedalProgressPersonal = { medalSlug, profileId: state.profile.id, currentRank, currentCount, updatedAt: Date.now() };
    state.medalProgress[medalSlug] = updated;
    hooks.onMedalProgressChanged(medalSlug, updated);
  }

  function applyPlayerProgress(currentLevel: number | null, totalXp: number | null): void {
    const now = Date.now();
    const updated: PlayerProgressPersonal = { profileId: state.profile.id, currentLevel, totalXp, updatedAt: now };
    state.playerProgress = updated;
    hooks.onPlayerProgressChanged(updated);

    // id here is just a stable react key for the in-memory/test path — the
    // real backend assigns its own AUTOINCREMENT id on insert (see
    // sqlite-repository.ts's onPlayerProgressLogAppended), which is what
    // actually lands in the DB. Nothing reads this value back afterward.
    const logEntry: PlayerProgressLogEntry = { id: state.playerProgressLog.length + 1, profileId: state.profile.id, recordedAt: now, currentLevel, totalXp };
    state.playerProgressLog.push(logEntry);
    hooks.onPlayerProgressLogAppended(logEntry);
  }

  function applyPokemonInstanceStatus(id: number, status: PokemonInstanceStatus): void {
    const index = state.pokemonInstances.findIndex((i) => i.id === id);
    if (index === -1) return;
    const updated: PokemonInstance = { ...state.pokemonInstances[index], status, updatedAt: Date.now() };
    state.pokemonInstances[index] = updated;
    hooks.onPokemonInstanceStatusChanged(updated);
  }

  function sortInstances(rows: PokemonInstanceWithSpecies[], sort: PokemonInstanceFilter["sort"]): PokemonInstanceWithSpecies[] {
    const sorted = [...rows];
    switch (sort) {
      case "cpDesc":
        return sorted.sort((a, b) => (b.instance.cp ?? -1) - (a.instance.cp ?? -1));
      case "ivDesc":
        return sorted.sort((a, b) => (b.instance.ivPercent ?? -1) - (a.instance.ivPercent ?? -1));
      case "nameAsc":
        return sorted.sort((a, b) => a.species.name.localeCompare(b.species.name));
      case "recent":
      default:
        return sorted.sort((a, b) => (b.instance.caughtAt ?? b.instance.recordedAt) - (a.instance.caughtAt ?? a.instance.recordedAt));
    }
  }

  function filteredInstances(filter: PokemonInstanceFilter = {}): PokemonInstanceWithSpecies[] {
    let rows = state.pokemonInstances.map(formWithSpeciesForInstance).filter((r): r is PokemonInstanceWithSpecies => r !== undefined);
    if (filter.status && filter.status !== "all") rows = rows.filter((r) => r.instance.status === filter.status);
    if (filter.tagId !== undefined) rows = rows.filter((r) => r.tags.some((t) => t.id === filter.tagId));
    if (filter.search) {
      const q = filter.search.trim();
      if (q) rows = rows.filter((r) => fuzzyMatches(r.species.name, q) || fuzzyMatches(r.instance.nickname ?? "", q));
    }
    return sortInstances(rows, filter.sort);
  }

  return {
    listRegions(): Region[] {
      return referenceData.regions;
    },

    listSpeciesByRegion(regionSlug: string): Species[] {
      return referenceData.species.filter((s) => s.regionSlug === regionSlug).sort((a, b) => a.dexNumber - b.dexNumber);
    },

    getFormTypes(formSlug: string): PokemonType[] {
      return formTypesByFormSlug.get(formSlug) ?? [];
    },

    getTypeMatchups(formSlug: string): { attackingType: PokemonType; multiplier: number }[] {
      const defendingTypes = formTypesByFormSlug.get(formSlug) ?? [];
      if (defendingTypes.length === 0) return [];
      return referenceData.types.map((attackingType) => {
        // Dual typing multiplies (e.g. quadruple damage when both types are
        // weak to the same attacker) — real game mechanic, not a guess.
        const multiplier = defendingTypes.reduce((product, defendingType) => {
          const eff = referenceData.typeEffectiveness.find(
            (t) => t.attackingTypeSlug === attackingType.slug && t.defendingTypeSlug === defendingType.slug,
          );
          return product * (eff?.multiplier ?? 1);
        }, 1);
        return { attackingType, multiplier };
      });
    },

    getSpeciesWithForms(speciesSlug: string): SpeciesWithForms {
      const species = speciesBySlug.get(speciesSlug);
      if (!species) throw new Error(`Unknown species: ${speciesSlug}`);
      const forms = formsBySpecies.get(speciesSlug) ?? [];
      return {
        species,
        personal: state.speciesPersonal[speciesSlug] ?? emptySpeciesPersonal(speciesSlug),
        forms: forms.map((form) => ({
          form,
          personal: state.formPersonal[form.slug] ?? emptyFormPersonal(form.slug),
        })),
      };
    },

    listSpeciesSummaries(filter: SpeciesFilter = {}): SpeciesSummary[] {
      return speciesByDexOrder
        .filter((s) => (filter.region ? s.regionSlug === filter.region : true))
        .filter((s) => (filter.search ? matchesSearch(s, filter.search) : true))
        .map((species) => {
          const personal = state.speciesPersonal[species.slug] ?? emptySpeciesPersonal(species.slug);
          const forms = formsBySpecies.get(species.slug) ?? [];
          const formPersonals = forms.map((f) => state.formPersonal[f.slug] ?? emptyFormPersonal(f.slug));
          const indicators = {} as Record<FormPersonalBooleanField, boolean>;
          for (const field of FORM_PERSONAL_BOOLEAN_FIELDS) {
            indicators[field] = formPersonals.some((fp) => fp[field]);
          }
          return { species, personal, caught: personal.registered, indicators };
        })
        .filter((s) => {
          if (!filter.caught || filter.caught === "all") return true;
          return filter.caught === "caught" ? s.caught : !s.caught;
        })
        .filter((s) => matchesFieldFilters(s.species, s.personal, s.indicators, filter.fieldFilters))
        .map(({ personal: _personal, ...summary }) => summary);
    },

    searchSpecies(query: string, limit = 8): Species[] {
      const q = query.trim();
      if (!q) return [];
      return speciesByDexOrder.filter((s) => matchesSearch(s, q)).slice(0, limit);
    },

    getAdjacentSpecies(speciesSlug: string) {
      const index = speciesByDexOrder.findIndex((s) => s.slug === speciesSlug);
      if (index === -1) return {};
      return {
        prev: index > 0 ? speciesByDexOrder[index - 1] : undefined,
        next: index < speciesByDexOrder.length - 1 ? speciesByDexOrder[index + 1] : undefined,
      };
    },

    // Catching an XXL/XXS/purified individual implies the species itself is
    // registered — that cascade (and the single-vs-bulk-shared apply step)
    // lives in applySpeciesPersonalField above.
    setSpeciesPersonalField(speciesSlug, field, value) {
      applySpeciesPersonalField(speciesSlug, field, value);
    },

    setFormPersonalField(formSlug, field, value) {
      applyFormPersonalField(formSlug, field, value);
    },

    getMegaVariantsForSpecies(speciesSlug: string): SpeciesMegaVariant[] {
      const variants = megaVariantsBySpecies.get(speciesSlug) ?? [];
      return variants.map((variant) => ({
        variant,
        personal: state.megaPersonal[variant.slug] ?? emptyMegaPersonal(variant.slug),
      }));
    },

    setMegaPersonalField(megaVariantSlug, field, value) {
      applyMegaPersonalField(megaVariantSlug, field, value);
    },

    // Bulk variants: loop the slugs applying the same per-row cascade path as
    // the single setters. Each row still fires its hook (that's what persists);
    // sqlite-repository.ts overrides these to batch those N writes into one
    // transaction + one flush instead of persisting per row.
    async bulkSetFormPersonalField(formSlugs, field, value) {
      for (const formSlug of formSlugs) applyFormPersonalField(formSlug, field, value);
    },

    async bulkSetSpeciesPersonalField(speciesSlugs, field, value) {
      for (const speciesSlug of speciesSlugs) applySpeciesPersonalField(speciesSlug, field, value);
    },

    getAppSetting(key) {
      return state.appSettings[key];
    },

    setAppSetting,

    listPokemonInstances(filter?: PokemonInstanceFilter): PokemonInstanceWithSpecies[] {
      const rows = filteredInstances(filter);
      const offset = filter?.offset ?? 0;
      const limit = filter?.limit;
      return limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit);
    },

    countPokemonInstances(filter?: PokemonInstanceFilter): number {
      return filteredInstances(filter).length;
    },

    getPokemonInstance(id: number): PokemonInstanceWithSpecies | undefined {
      const instance = state.pokemonInstances.find((i) => i.id === id);
      return instance ? formWithSpeciesForInstance(instance) : undefined;
    },

    async setPokemonInstanceStatus(id: number, status: PokemonInstanceStatus) {
      applyPokemonInstanceStatus(id, status);
    },

    listTags(): Tag[] {
      return getSharedTags();
    },

    getPlayerProgress(): PlayerProgressPersonal | undefined {
      return state.playerProgress;
    },

    setPlayerProgress(currentLevel: number | null, totalXp: number | null) {
      applyPlayerProgress(currentLevel, totalXp);
    },

    listPlayerProgressLog(): PlayerProgressLogEntry[] {
      // Already append-ordered (pushed in setPlayerProgress call order) —
      // re-sort defensively in case an import interleaved older entries in.
      return [...state.playerProgressLog].sort((a, b) => a.recordedAt - b.recordedAt);
    },

    listMedalProgress(): MedalProgress[] {
      return referenceData.medals.map((medal) => ({
        medal,
        tiers: medalTiersByMedalSlug.get(medal.slug) ?? [],
        progress: state.medalProgress[medal.slug] ?? emptyMedalProgress(medal.slug, state.profile.id),
      }));
    },

    setMedalProgress(medalSlug: string, currentRank: number, currentCount: number) {
      if (!medalSlugs.has(medalSlug)) return;
      applyMedalProgress(medalSlug, currentRank, currentCount);
    },

    getSpecimenStateCounts(): SpecimenStateCounts {
      const counts: SpecimenStateCounts = { shiny: 0, lucky: 0, shadow: 0, purified: 0 };
      for (const instance of state.pokemonInstances) {
        if (instance.shiny) counts.shiny++;
        if (instance.lucky) counts.lucky++;
        if (instance.shadow) counts.shadow++;
        if (instance.purified) counts.purified++;
      }
      return counts;
    },

    getTopTagCounts(limit = 10): TagCount[] {
      const counts = new Map<number, number>();
      for (const link of state.pokemonInstanceTags) counts.set(link.tagId, (counts.get(link.tagId) ?? 0) + 1);
      return getSharedTags()
        .map((tag) => ({ tag, count: counts.get(tag.id) ?? 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    },

    getIndicatorSelection(): FormPersonalBooleanField[] {
      const raw = state.appSettings[INDICATOR_SETTING_KEY];
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as FormPersonalBooleanField[]).slice(0, MAX_GRID_INDICATORS) : [];
      } catch {
        return [];
      }
    },

    setIndicatorSelection(fields: FormPersonalBooleanField[]) {
      setAppSetting(INDICATOR_SETTING_KEY, JSON.stringify(fields.slice(0, MAX_GRID_INDICATORS)));
    },

    exportPersonalData(): PersonalDataExport {
      return {
        exportedAt: new Date().toISOString(),
        schemaVersion: CURRENT_PERSONAL_SCHEMA_VERSION,
        speciesPersonal: { ...state.speciesPersonal },
        formPersonal: { ...state.formPersonal },
        appSettings: { ...state.appSettings },
        megaPersonal: { ...state.megaPersonal },
        formBackgroundPersonal: [...state.formBackgroundPersonal],
        medalProgress: { ...state.medalProgress },
        pokemonInstances: [...state.pokemonInstances],
        tags: [...getSharedTags()],
        pokemonInstanceTagNames: state.pokemonInstanceTags
          .map((link) => {
            const instance = state.pokemonInstances.find((i) => i.id === link.pokemonInstanceId);
            const tag = getSharedTags().find((t) => t.id === link.tagId);
            return instance && tag ? { instanceUuid: instance.uuid, tagName: tag.name } : undefined;
          })
          .filter((x): x is { instanceUuid: string; tagName: string } => x !== undefined),
        playerProgress: state.playerProgress,
        playerProgressLog: [...state.playerProgressLog],
      };
    },

    async importPersonalData(data: PersonalDataExport): Promise<ImportResult> {
      // Merge, not restore: a local row that isn't in the imported file is
      // left alone (this device may have caught/tracked things the other
      // export doesn't know about); a row present on both sides keeps
      // whichever one's updatedAt is newer, whole-row (not field by field —
      // a shiny flag set on device A and a lucky flag set on device B for
      // the same form can't both survive a merge of two single rows; the
      // more-recently-touched device's row wins entirely). App settings are
      // untouched here (see the appSettings loop below) — same as before.
      let skippedSpeciesSlugs = 0;
      let skippedFormSlugs = 0;
      for (const [slug, personal] of Object.entries(data.speciesPersonal)) {
        // Slug no longer resolves against the currently-loaded reference data
        // (e.g. imported from an older/newer reference.json) — writing it
        // anyway would violate the species_personal FK (silently, via the
        // swallowed write-queue error). Skip and count instead.
        if (!speciesBySlug.has(slug)) {
          skippedSpeciesSlugs++;
          continue;
        }
        const local = state.speciesPersonal[slug];
        if (local && local.updatedAt >= personal.updatedAt) continue;
        state.speciesPersonal[slug] = personal;
        hooks.onSpeciesPersonalChanged(slug, personal);
      }
      for (const [slug, personal] of Object.entries(data.formPersonal)) {
        if (!speciesSlugByFormSlug.has(slug)) {
          skippedFormSlugs++;
          continue;
        }
        const local = state.formPersonal[slug];
        if (local && local.updatedAt >= personal.updatedAt) continue;
        state.formPersonal[slug] = personal;
        hooks.onFormPersonalChanged(slug, personal);
      }
      // Optional: absent entirely on an export file from before this field
      // existed. Not counted in ImportResult's skip counts (that's about
      // rows that resolve to a stale/unknown slug, not a whole-field gap in
      // an older export) — silently skipped is correct here, since "not
      // present" just means the exporting device had never used mega yet.
      for (const [slug, personal] of Object.entries(data.megaPersonal ?? {})) {
        if (!speciesSlugByMegaVariantSlug.has(slug)) continue;
        const local = state.megaPersonal[slug];
        if (local && local.updatedAt >= personal.updatedAt) continue;
        state.megaPersonal[slug] = personal;
        hooks.onMegaPersonalChanged(slug, personal);
      }
      // No per-row "value" to merge here (composite PK — a link either
      // exists or it doesn't), so this is a straight union: add whichever
      // incoming links aren't already present, skip the rest.
      for (const [slug, progress] of Object.entries(data.medalProgress ?? {})) {
        if (!medalSlugs.has(slug)) continue;
        const local = state.medalProgress[slug];
        if (local && local.updatedAt >= progress.updatedAt) continue;
        // progress.profileId is whatever profile was current on the
        // EXPORTING device — meaningless (and FK-violating, migration 0004)
        // on this device. Re-stamp with this device's current profile, same
        // as every other imported table that carries its own profileId
        // field (see formBackgroundPersonal below).
        const remapped = { ...progress, profileId: state.profile.id };
        state.medalProgress[slug] = remapped;
        hooks.onMedalProgressChanged(slug, remapped);
      }
      if (data.playerProgress && (!state.playerProgress || state.playerProgress.updatedAt < data.playerProgress.updatedAt)) {
        const remapped = { ...data.playerProgress, profileId: state.profile.id };
        state.playerProgress = remapped;
        hooks.onPlayerProgressChanged(remapped);
      }
      // Union, not newer-wins — every log row is its own historical fact,
      // there's nothing to overwrite. Deduped by recordedAt (see
      // PersonalDataExport.playerProgressLog's doc comment for why not id).
      const knownRecordedAts = new Set(state.playerProgressLog.map((e) => e.recordedAt));
      for (const entry of data.playerProgressLog ?? []) {
        if (knownRecordedAts.has(entry.recordedAt)) continue;
        // Same re-stamp as medalProgress/playerProgress above — entry.profileId
        // is the exporting device's profile, not this one's.
        const remapped = { ...entry, profileId: state.profile.id };
        state.playerProgressLog.push(remapped);
        hooks.onPlayerProgressLogAppended(remapped);
      }
      // pokemon_instance merge-by-uuid happens in sqlite-repository.ts's
      // importPersonalData OVERRIDE, not here -- unlike every other row type
      // in this function, a genuinely new specimen needs a fresh
      // AUTOINCREMENT id back from a real INSERT before the in-memory cache
      // can be updated (same reason createPokemonInstances bypasses the
      // hook system entirely -- see that function). This function's job for
      // pokemonInstances/pokemonInstanceTagNames is just to leave them
      // alone; the override handles both directly against SQL.
      for (const row of data.formBackgroundPersonal ?? []) {
        if (!speciesSlugByFormSlug.has(row.formSlug)) continue;
        const alreadyPresent = state.formBackgroundPersonal.some(
          (b) => b.formSlug === row.formSlug && b.achievementField === row.achievementField && b.backgroundSlug === row.backgroundSlug,
        );
        if (alreadyPresent) continue;
        // row.profileId is whatever profile UUID was current on the
        // EXPORTING device — meaningless (and FK-violating) on this device.
        // Every other imported row is stamped with THIS device's current
        // profile at the point of application (see the hooks above, which
        // capture state.profile.id themselves); do the same here explicitly,
        // since FormBackgroundPersonal already carries its own profileId
        // field and the hook writes it as-is.
        const remapped = { ...row, profileId: state.profile.id };
        state.formBackgroundPersonal.push(remapped);
        hooks.onFormBackgroundPersonalAdded(remapped);
      }
      for (const [key, value] of Object.entries(data.appSettings)) {
        setAppSetting(key, value);
      }
      // Base implementation has nothing async to wait for — sqlite-repository.ts
      // overrides this to also await its pending write queue.
      return { skippedSpeciesSlugs, skippedFormSlugs };
    },
  };
}
