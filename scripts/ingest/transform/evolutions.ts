// Species-level evolution edges, from pokemon-go-api's evolutions[] data.
// Unchanged in sourcing from build-reference.ts — the only difference is
// that the id -> entry resolution now reuses PokedexSource's shared index
// instead of a second linear scan per evolution edge (the family-grouping
// pass in transform/species.ts uses the same one).

import type { PokedexSource } from "../sources/pokemon-go-api";
import type { Species, SpeciesEvolution } from "../../../src/db/types";

// Same regionForms-evolutions handling as the family-grouping pass in
// transform/species.ts — an evolution edge declared only on a regional form
// still counts. Matches by `id`, not `formId`, for the same reason
// documented on familySlugFor there.
export function buildSpeciesEvolutions(pokedex: PokedexSource, species: Species[]): SpeciesEvolution[] {
  const slugByDex = new Map(species.map((s) => [s.dexNumber, s.slug]));
  // Keyed by "from|to" — species_evolution's PK is species-level (this
  // table's deliberate Tier-1 granularity, see docs/v2-schema-design.md), so
  // a base entry and a regional form of the same species agreeing on the
  // same evolution edge (e.g. Rattata -> Raticate declared once on the base
  // entry, once on the Alolan regionForm) must collapse to one row, not
  // produce a duplicate PK.
  const byKey = new Map<string, SpeciesEvolution>();
  for (const entry of pokedex.all()) {
    const fromSlug = slugByDex.get(entry.dexNr);
    if (!fromSlug) continue;
    const sources = [entry, ...Object.values(entry.regionForms ?? {})];
    for (const source of sources) {
      for (const evo of source.evolutions ?? []) {
        const target = pokedex.byId(evo.id);
        const toSlug = target ? slugByDex.get(target.dexNr) : undefined;
        if (!toSlug) continue;
        const key = `${fromSlug}|${toSlug}`;
        const candidate: SpeciesEvolution = { fromSpeciesSlug: fromSlug, toSpeciesSlug: toSlug, candyRequired: evo.candies ?? null, itemRequired: evo.item?.id ?? null };
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, candidate);
          continue;
        }
        if (existing.candyRequired === candidate.candyRequired && existing.itemRequired === candidate.itemRequired) continue;
        // Prefer whichever record is more complete (has an item where the
        // other is missing one) when the candy cost otherwise agrees — this
        // is filling a gap in one source record, not choosing between two
        // real different costs.
        if (existing.itemRequired === null && candidate.itemRequired !== null && existing.candyRequired === candidate.candyRequired) {
          byKey.set(key, candidate);
          continue;
        }
        if (candidate.itemRequired === null && existing.itemRequired !== null && existing.candyRequired === candidate.candyRequired) {
          continue;
        }
        // A handful of species (e.g. Sinistea/Polteageist's Phony vs
        // Antique form, 50 vs 400 candy) have a real form-specific cost this
        // species-level table can't represent as two rows under one PK.
        // Rather than silently assert which one is "correct" (a real
        // Pokémon GO mechanics claim, not an ingestion detail), keep the
        // first-seen value and log the conflict so it's visible at build
        // time and can be verified against a real source.
        console.warn(
          `[transform/evolutions] species_evolution conflict ${fromSlug} -> ${toSlug}: keeping candy=${existing.candyRequired}/item=${existing.itemRequired}, discarding candy=${candidate.candyRequired}/item=${candidate.itemRequired} (species-level table can't hold both — verify before relying on either for a form-specific cost)`,
        );
      }
    }
  }
  return [...byKey.values()];
}
