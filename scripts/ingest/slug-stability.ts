// Pure slug-diffing logic behind ingest.ts's inline slug-stability check —
// split out from ingest.ts so it's testable without importing ingest.ts's
// module (which runs the real pipeline as a side effect of being loaded).
//
// Ported from the old check-slug-stability.ts, plus medal slugs (added per
// Task 3's review): medal slugs now depend on a subsequence-alignment join
// between GAME_MASTER's badgeSettings and the vendored badges.json snapshot
// (sources/pogoapi-badges.ts). If that alignment ever silently degrades
// (e.g. a future GAME_MASTER fetch reorders/drops a vendored badge), medal
// slugs could drift — medal_progress_personal.medal_slug is a live FK
// (src/db/migrations/0004_empty_vapor.sql:144) that reference-sync.ts's
// quarantineOrphans does NOT cover, so a stale slug there rolls back the
// entire sync transaction at COMMIT for any user with medal progress. No
// other automated check catches this today.

import type { ReferenceData } from "../../src/db/reference-data";

export interface SlugSets {
  species: Set<string>;
  forms: Set<string>;
  megaVariants: Set<string>;
  medals: Set<string>;
}

export function slugsOf(data: ReferenceData): SlugSets {
  return {
    species: new Set(data.species.map((s) => s.slug)),
    forms: new Set(data.forms.map((f) => f.slug)),
    megaVariants: new Set(data.megaVariants.map((m) => m.slug)),
    medals: new Set(data.medals.map((m) => m.slug)),
  };
}

/**
 * Returns one human-readable problem string per slug that existed in
 * `before` but not `after`, except species/form slugs covered by a
 * `renamedSpeciesSlugs`/`renamedFormSlugs` entry (from
 * src/db/slug-renames.ts). Mega-variant and medal slugs have no rename
 * mechanism at all, so any disappearance there is always reported.
 */
export function findVanishedSlugProblems(before: SlugSets, after: SlugSets, renamedSpeciesSlugs: Set<string>, renamedFormSlugs: Set<string>): string[] {
  const problems: string[] = [];

  for (const slug of before.species) {
    if (after.species.has(slug)) continue;
    if (renamedSpeciesSlugs.has(slug)) continue;
    problems.push(`species slug disappeared without a matching src/db/slug-renames.ts entry: "${slug}"`);
  }
  for (const slug of before.forms) {
    if (after.forms.has(slug)) continue;
    if (renamedFormSlugs.has(slug)) continue;
    problems.push(`form slug disappeared without a matching src/db/slug-renames.ts entry: "${slug}"`);
  }
  for (const slug of before.megaVariants) {
    if (!after.megaVariants.has(slug)) problems.push(`mega_variant slug disappeared (no rename mechanism exists for mega variants): "${slug}"`);
  }
  for (const slug of before.medals) {
    if (!after.medals.has(slug)) problems.push(`medal slug disappeared (medal_progress_personal has a live FK, no rename mechanism exists, no other automated detection): "${slug}"`);
  }

  return problems;
}
