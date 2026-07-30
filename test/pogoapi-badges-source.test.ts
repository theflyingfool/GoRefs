import { test } from "node:test";
import assert from "node:assert/strict";

import { alignVendorBadges, loadVendorBadgeDisplayNames, type VendorBadgeDisplay } from "../scripts/ingest/sources/pogoapi-badges";
import type { BadgeSettingsRecord } from "../scripts/ingest/sources/game-master";

function badge(badgeType: string, badgeRank: number): BadgeSettingsRecord {
  return { templateId: badgeType, badgeType, badgeRank };
}

function vendor(name: string, rank: number): VendorBadgeDisplay {
  return { name, description: `${name} description`, rank };
}

test("alignVendorBadges matches ranks in order when nothing was inserted", () => {
  const badgeSettings = [badge("BADGE_A", 5), badge("BADGE_B", 2)];
  const vendorBadges = [vendor("Alpha", 5), vendor("Beta", 2)];

  const aligned = alignVendorBadges(badgeSettings, vendorBadges);

  assert.equal(aligned[0]?.name, "Alpha");
  assert.equal(aligned[1]?.name, "Beta");
});

// This is the real-world shape the fix exists for: GAME_MASTER's
// badgeSettings is alphabetical by badgeType, and gains new badges over
// time by *insertion* into that order, not by appending. A snapshot taken
// before an insertion is therefore a subsequence of today's array, not a
// positionally-aligned twin of it. Naive `vendorBadges[index]` lookup
// would misattribute "Beta" to BADGE_INSERTED (or, worse, silently reuse
// whichever vendored entry happens to sit at that raw index) and never
// recover it for BADGE_C. The two-pointer walk here only advances past an
// unvendored entry without consuming a vendored one, so BADGE_C still
// finds "Beta" on the other side of the insertion.
test("a badge inserted between two vendored badges doesn't shift the alignment for badges after it", () => {
  const badgeSettings = [
    badge("BADGE_A", 5), // vendored
    badge("BADGE_INSERTED", 2), // added to GAME_MASTER after the snapshot; no vendored entry
    badge("BADGE_C", 5), // vendored
  ];
  const vendorBadges = [vendor("Alpha", 5), vendor("Beta", 5)];

  const aligned = alignVendorBadges(badgeSettings, vendorBadges);

  assert.equal(aligned[0]?.name, "Alpha");
  assert.equal(aligned[1], undefined);
  assert.equal(aligned[2]?.name, "Beta");
});

test("alignVendorBadges never consumes the same vendored entry twice, and stops once the vendored list is exhausted", () => {
  const badgeSettings = [badge("BADGE_A", 5), badge("BADGE_B", 5), badge("BADGE_C", 5)];
  const vendorBadges = [vendor("Alpha", 5)];

  const aligned = alignVendorBadges(badgeSettings, vendorBadges);

  assert.equal(aligned[0]?.name, "Alpha");
  assert.equal(aligned[1], undefined);
  assert.equal(aligned[2], undefined);
});

// Known limitation, documented rather than hidden: the walk only advances
// its vendor pointer on a match, so a vendored entry whose rank matches no
// *remaining* badgeSettings entry doesn't just get skipped — it never
// releases the pointer, so it (and everything vendored after it) goes
// unmatched too. This would only bite if a badge present in the snapshot
// were later removed from GAME_MASTER (not just had new badges inserted
// around it); verified against real data that this doesn't happen — all
// 597 vendored entries matched in order (see
// .superpowers/sdd/task-3-fix-medals-report.md). Recovering from a genuine
// deletion would need a real key (or a fuzzier match), which is out of
// scope for this fix — but silently returning a misaligned result for that
// case is worse than failing loudly, so `alignVendorBadges` now asserts
// every vendored entry was consumed and throws if the walk stalled.
test("a vendored entry whose rank matches nothing remaining throws instead of silently misaligning everything after it", () => {
  const badgeSettings = [badge("BADGE_A", 5)];
  const vendorBadges = [vendor("Alpha", 2), vendor("Beta", 5)];

  assert.throws(() => alignVendorBadges(badgeSettings, vendorBadges), /stalled at vendored index 0 of 2/);
});

// The specific failure mode the review flagged: a stall *partway through*
// the walk doesn't necessarily shrink the matched count in an obviously
// wrong-looking way — everything before the stall still matches cleanly,
// and (per the limitation above) once the pointer sticks, nothing after it
// gets a chance to re-sync even if a later rank would otherwise have
// matched. Confirms the assertion catches this mid-walk case too, not just
// a stall at index 0.
test("a stall partway through the walk (a gap the walk can't consume) throws, naming the stalled index", () => {
  const badgeSettings = [badge("BADGE_A", 5), badge("BADGE_B", 9), badge("BADGE_C", 2)];
  // "Beta" (rank 7) matches nothing remaining after "Alpha" is consumed —
  // BADGE_B is rank 9, BADGE_C is rank 2 — so the walk stalls with "Beta"
  // and "Gamma" both unconsumed, even though 1 of 3 vendored entries did
  // match.
  const vendorBadges = [vendor("Alpha", 5), vendor("Beta", 7), vendor("Gamma", 2)];

  assert.throws(() => alignVendorBadges(badgeSettings, vendorBadges), /stalled at vendored index 1 of 3/);
});

test("loadVendorBadgeDisplayNames reads the real committed snapshot in its own file order, index 0 is Triathlete", () => {
  const vendorBadges = loadVendorBadgeDisplayNames();

  assert.ok(vendorBadges.length > 0);
  assert.equal(vendorBadges[0].name, "Triathlete");
  assert.equal(vendorBadges[0].rank, 5);
  assert.ok(vendorBadges[0].description.length > 0);
});
