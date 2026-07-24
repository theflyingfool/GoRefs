// Extracted out of sqlite-repository.ts's renameTag/deleteTag so the exact
// SQL they produce can be exercised directly in a node:test file against a
// real DatabaseSync connection. sqlite-repository.ts can't be imported from
// a plain Node test: it transitively pulls in src/db/sqlite-client.ts's
// browser-only jeep-sqlite loader, which throws at import time outside a DOM
// environment. This file deliberately imports nothing from sqlite-client.ts
// (or anything else Capacitor/jeep-sqlite-related) so it stays
// test-importable in isolation.
import type { SqlStatement } from "./pokemon-instance-update-sql";
import type { Tag, PokemonInstanceTag } from "../db/types";
import type { TagCount } from "./repository";

export function buildRenameTagStatement(id: number, name: string): SqlStatement {
  return { sql: "UPDATE tag SET name = ? WHERE id = ?", params: [name, id] };
}

/**
 * Builds the statements needed to delete a tag: the `pokemon_instance_tag`
 * link rows must be removed BEFORE the `tag` row itself --
 * pokemon_instance_tag.tag_id REFERENCES tag(id) with no ON DELETE CASCADE
 * (see src/db/migrations/0000_baseline.sql), so deleting the tag row first
 * throws a FOREIGN KEY constraint failure once foreign keys are enforced.
 */
export function buildDeleteTagStatements(id: number): SqlStatement[] {
  return [
    { sql: "DELETE FROM pokemon_instance_tag WHERE tag_id = ?", params: [id] },
    { sql: "DELETE FROM tag WHERE id = ?", params: [id] },
  ];
}

/**
 * Pure in-memory computation behind Repository.getTagUsageCounts -- no SQL
 * involved, so extracted purely to keep it directly unit-testable alongside
 * the SQL-producing functions above, rather than for jeep-sqlite-avoidance
 * reasons. Sorted alphabetically by tag name (unlike getTopTagCounts, which
 * ranks by count descending for the Stats page) since this backs a
 * management UI listing all tags, not a "top N" chart.
 */
export function computeTagUsageCounts(tags: Tag[], links: PokemonInstanceTag[]): TagCount[] {
  const counts = new Map<number, number>();
  for (const link of links) counts.set(link.tagId, (counts.get(link.tagId) ?? 0) + 1);
  return tags.map((tag) => ({ tag, count: counts.get(tag.id) ?? 0 })).sort((a, b) => a.tag.name.localeCompare(b.tag.name));
}
