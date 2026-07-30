// Vendored medal display names/descriptions — the one thing GAME_MASTER's
// badgeSettings genuinely doesn't carry (only the BADGE_* id, rank and tier
// targets; no name, no description). Sourced from the committed
// vendor/pogoapi-snapshot/badges.json snapshot instead of a fresh
// pogoapi.net fetch (that source is unmaintained; see
// vendor/pogoapi-snapshot/README.md).
//
// pogoapi.net never published a badge id/type field, so this snapshot has
// no shared key to join against GAME_MASTER's badgeSettings on. What it
// has is *relative* order: GAME_MASTER's badgeSettings is alphabetical by
// badgeType, and the vendored snapshot was captured from a GAME_MASTER
// dump in that same order — but GAME_MASTER has since gained ~400 more
// badges, inserted alphabetically among the ones the snapshot captured,
// not appended after them. So a naive "index N in the snapshot is index N
// in badgeSettings" join drifts almost immediately (verified: the first
// mismatch is at index 19, and 67 of 597 vendored entries land on the
// wrong badge under naive positional indexing — see
// .superpowers/sdd/task-3-fix-medals-report.md for the full story).
//
// What actually holds is that the vendored snapshot is a *subsequence* of
// today's badgeSettings in the same relative order — nothing was
// reordered, only inserted. `alignVendorBadges` recovers the join with a
// two-pointer subsequence walk keyed on `badgeRank`/`rank` agreement:
// advance through badgeSettings, and whenever the current entry's rank
// matches the next unconsumed vendored entry's rank, consume it; otherwise
// treat the badgeSettings entry as one of the ~400 newer, unvendored
// badges and move on without consuming any vendored entry. Verified
// against a real 997-entry badgeSettings dump and the real 597-entry
// snapshot: this recovers all 597 vendored entries in order, and every one
// of the 183 medal slugs currently committed in src/data/reference.json
// comes back with its original name/description.
//
// Known limitation: the walk only advances its vendored-array pointer on a
// match, so if a badge present in the snapshot were ever *removed* from
// GAME_MASTER (as opposed to new badges being inserted around it, which is
// what's actually happened so far), that vendored entry — and everything
// vendored after it — would stop matching. Confirmed this doesn't occur in
// practice (all 597 vendored entries matched against real data), but it's
// a real edge the algorithm doesn't defend against on its own — which is
// why `alignVendorBadges` asserts every vendored entry got consumed and
// throws instead of returning a partial/misaligned result; see
// test/pogoapi-badges-source.test.ts.
//
// That assertion only narrows this edge, though — it doesn't close it.
// Simulating all 597 single-badge-removal scenarios against the real
// GAME_MASTER dump and vendored snapshot: the assertion fired in just 75 of
// 597 cases (13%). The vendored snapshot only has two distinct rank values
// (525 entries at rank 2, 72 at rank 5), so most removals have plenty of
// same-rank neighbors to re-sync onto — the walk quietly consumes a
// wrong-but-rank-compatible subsequence and finishes with every vendored
// entry accounted for, so the assertion never trips. In 504 of those 522
// silent completions, medal names ended up mis-paired. A real join key
// would be needed to close this fully; until then, treat the assertion as
// a partial safety net for this scenario, not a guarantee.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BadgeSettingsRecord } from "./game-master";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const VENDOR_BADGES_PATH = resolve(__dirname, "../../../vendor/pogoapi-snapshot/badges.json");

export interface VendorBadgeDisplay {
  name: string;
  description: string;
  /** pogoapi.net's `rank` — the only field `alignVendorBadges` can join on (badge id isn't published), and what `player-progression.ts`'s `medalDisplayName` re-checks against GAME_MASTER's `badgeRank` as a final integrity guard even after alignment. */
  rank: number;
}

interface RawVendorBadge {
  name: string;
  description: string;
  rank: number;
}

/**
 * I/O boundary: reads and parses the vendored snapshot once, in its
 * original (badgeType-alphabetical) file order. Callers pass the result
 * into `alignVendorBadges` (or `buildPlayerProgression`, which calls it
 * internally) — the transform itself stays a pure function of
 * already-loaded data, same as every other transform module.
 */
export function loadVendorBadgeDisplayNames(): VendorBadgeDisplay[] {
  const raw = JSON.parse(readFileSync(VENDOR_BADGES_PATH, "utf-8")) as RawVendorBadge[];
  return raw.map((entry) => ({ name: entry.name, description: entry.description, rank: entry.rank }));
}

/**
 * Realigns `vendorBadges` (in its own original order) against
 * `badgeSettings` (GAME_MASTER's order) by a two-pointer subsequence walk,
 * returning an array indexed exactly like `badgeSettings` — `result[i]` is
 * the vendored display data for `badgeSettings[i]`, or `undefined` if no
 * vendored entry matched (a badge added to GAME_MASTER after the snapshot
 * was taken). See the module comment for why positional indexing alone
 * doesn't work and why this does.
 *
 * Throws if the walk stalls before consuming every vendored entry — see
 * the module comment's "Why this needs a hard assertion" note for why a
 * silent partial alignment is worse than a loud failure here.
 */
export function alignVendorBadges(badgeSettings: BadgeSettingsRecord[], vendorBadges: VendorBadgeDisplay[]): (VendorBadgeDisplay | undefined)[] {
  const aligned: (VendorBadgeDisplay | undefined)[] = new Array(badgeSettings.length).fill(undefined);
  let vendorIndex = 0;
  for (let gmIndex = 0; gmIndex < badgeSettings.length && vendorIndex < vendorBadges.length; gmIndex++) {
    const candidate = vendorBadges[vendorIndex];
    if ((badgeSettings[gmIndex].badgeRank as number | undefined) === candidate.rank) {
      aligned[gmIndex] = candidate;
      vendorIndex++;
    }
  }
  if (vendorIndex !== vendorBadges.length) {
    const stalled = vendorBadges[vendorIndex];
    throw new Error(
      `alignVendorBadges: stalled at vendored index ${vendorIndex} of ${vendorBadges.length} ` +
        `("${stalled.name}", rank ${stalled.rank}) — no remaining badgeSettings entry matched its rank in order. ` +
        `This means the vendored snapshot is no longer a subsequence of GAME_MASTER's badgeSettings ` +
        `(a vendored badge was likely removed from GAME_MASTER, not just had new badges inserted around it — ` +
        `see the module comment's "Known limitation"). Refusing to return a partial/misaligned result: past this ` +
        `point, medal name/description could silently attach to the wrong badge while the slug set stays identical.`,
    );
  }
  return aligned;
}
