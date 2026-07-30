# Task 3 fix: medal name/description regression

Fixes the correctness blocker Task 3's report flagged (Concern #1):
GAME_MASTER's `badgeSettings` has no display strings, so medal names/
descriptions were id-derived and medal slugs (a live FK target for
`medal_progress_personal.medal_slug`) changed under the GAME_MASTER
re-sourcing. Per owner decision, this is a minimal, scoped fix using the
committed vendored `pogoapi-snapshot/badges.json` that Task 3's report
proposed — not a general source-precedence framework.

**This took two iterations to get right, and both are worth knowing about
before trusting the result**: the first iteration (naive positional
indexing, as Task 3's report proposed) looked correct on a shallow check
but silently broke on ~11% of real badges. The second iteration (this
report's final state) replaces positional indexing with an explicit
subsequence-alignment algorithm and is verified end-to-end against real
data: **all 183 currently-committed production medal slugs recovered
exactly, 0 duplicate primary keys, 0 name/description diffs.**

## What was implemented

1. **`scripts/ingest/sources/pogoapi-badges.ts`** (new):
   - `loadVendorBadgeDisplayNames()` — I/O boundary, reads and parses the
     committed `vendor/pogoapi-snapshot/badges.json` (597 records) into
     `VendorBadgeDisplay[]` (`{ name, description, rank }`), in the
     snapshot's own file order.
   - `alignVendorBadges(badgeSettings, vendorBadges)` — a pure function
     that joins the two. **Why this exists instead of `vendorBadges[index]`
     lookup**: see "The alignment problem" below. Two-pointer subsequence
     walk keyed on `badgeRank`/`rank` agreement: advance through
     `badgeSettings`, and whenever the current entry's rank matches the
     next *unconsumed* vendored entry's rank, consume it and record the
     match at that `badgeSettings` index; otherwise treat the
     `badgeSettings` entry as one of the badges GAME_MASTER has added
     since the snapshot and move on without consuming anything. Returns an
     array indexed exactly like `badgeSettings`, `undefined` where nothing
     matched.

2. **`scripts/ingest/transform/player-progression.ts`**:
   - `buildPlayerProgression` gained a **required** second parameter,
     `vendorBadges: VendorBadgeDisplay[]` (no default — a default would
     let a future call site silently omit it and regenerate the exact
     regression this task fixes). It calls `alignVendorBadges` internally
     once, then looks up each badge's aligned entry by index while
     building medals — so the transform itself stays pure (no I/O), and
     the caller only has to pass `loadVendorBadgeDisplayNames()`'s result
     through unmodified, exactly as `test/transform-reference-data.test.ts`
     (Task 3's designated template for Task 4) now does.
   - `medalDisplayName` trusts whatever `alignVendorBadges` hands it
     directly (no redundant rank re-check). An earlier draft of this fix
     added a `console.warn`-on-mismatch guard here "for defense in depth,"
     but since `buildPlayerProgression` always routes `vendorBadges`
     through `alignVendorBadges` before this function ever sees it, that
     guard's mismatch branch was unreachable through the only public entry
     point — dead code that a shallow read could mistake for tested
     behavior. Removed rather than kept and mis-described; `alignVendorBadges`
     is where the rank-agreement invariant actually lives and is what's
     unit-tested (`test/pogoapi-badges-source.test.ts`).
   - **PK-collision bug found and fixed during review** (not in the
     original plan): the medal-tier-building loop's `targets` branch
     wasn't gated on `isFirstForSlug`, unlike the sibling `rank`-only
     branch right next to it. Under the old id-derived naming every badge
     got a unique slug, so this never collided. Once real vendored names
     legitimately collapse multiple badges onto one slug — e.g.
     GAME_MASTER's four `BADGE_AA_2023_JEJU_DAY_0{0..3}` records all
     resolving to "Pokémon Air Adventures" and each individually carrying
     `targets` — every one would have pushed a `(medalSlug, rank)` row,
     colliding on `medal_tier`'s primary key. Fixed by gating both
     branches on `isFirstForSlug`. Covered by a new test; verified 0
     duplicate `(medalSlug, rank)` pairs across all 799 real medal-tier
     rows produced.

No orchestrator exists yet (Task 4's job) to wire
`loadVendorBadgeDisplayNames()` into a real ingestion run —
`build-reference.ts` was untouched by Task 3 and remains untouched here.

## The alignment problem (why naive positional indexing was wrong)

Task 3's report proposed "the vendored `badges.json` is positionally
aligned with `badgeSettings`" and verified it at 3 sample indices (0, 1,
5). My first implementation trusted that and shipped plain
`vendorBadges[index]` lookup with a rank-mismatch guard that fell back
safely rather than corrupting data on a drift.

Checking that guard's real hit rate against a full 997-entry real
`badgeSettings` array (a complete `GAME_MASTER.json` dump that happened to
already be present in this worktree at `docs/drafts/GAME_MASTER.json` —
untracked, unrelated to this task, used read-only for verification, never
committed) found the alignment drifts starting at index 19 and disagrees at
**67 of 597 positions (11%)** — my first verification pass missed this
because it summed rank/eventBadge/targets mismatches into one counter and
only eyeballed the first 10 (all an unrelated, expected difference), rather
than checking the rank-specific count on its own. That's a real gap in my
own first-pass verification, caught by a second, more careful pass.

The actual root cause: `badgeSettings` is alphabetical by `badgeType`, and
GAME_MASTER has gained roughly 400 more badges since the snapshot was taken
— by **insertion** into that alphabetical order, not by appending. E.g. at
real index 19, `BADGE_APAC_PARTNER_JULY_2018_6` (badgeRank 2) sits where
the snapshot's index-19 entry, "Battle Girl" (rank 5), no longer belongs —
`BADGE_APAC_PARTNER_JULY_2018_6`/`_7` were inserted before the alphabetically
later `BADGE_BATTLE_ATTACK_WON` ("Battle Girl"'s real badge), shifting
every subsequent vendored entry two positions out of naive alignment.

That means the vendored snapshot is a **subsequence** of today's
`badgeSettings` in the same relative order (nothing reordered, only
inserted) — which `alignVendorBadges`'s two-pointer walk recovers exactly.
Verified against the same real 997-entry dataset: **all 597 vendored
entries matched, in order, 0 leftover.**

**Known limitation of the alignment algorithm** (documented in code and
tests, not hidden): the two-pointer walk only advances its vendored-array
pointer on a match. If a badge present in the snapshot were ever *removed*
from GAME_MASTER (as opposed to new badges being inserted around it, which
is what's actually happened), that vendored entry — and everything
vendored after it — would stop matching, cascading. Confirmed this doesn't
occur today (0 leftover, all 597 matched), but it's a real edge the
algorithm doesn't defend against on its own; a rank-based join can't
distinguish "removed" from "shifted." Recovering from a genuine future
deletion would need a real key or a fuzzier match, out of scope for this
fix (and there's no such key available from pogoapi.net's data).

## Slug-stability verification (final, corrected state)

Ran `buildPlayerProgression` against the real 997-entry `badgeSettings` and
the real vendored snapshot, diffed against the committed
`src/data/reference.json`'s 183 production medals:

- **Vanished slugs: 0.** All 183 production medal slugs are recovered.
- **Name diffs on shared slugs: 0. Description diffs: 0.**
- **Duplicate `(medalSlug, rank)` medal-tier PKs: 0** across all 799 rows
  (this is `medal_tier`'s actual primary key — see `src/db/schema.ts:149`
  — so this check is on the constraint that matters, not an approximation
  of it).
- Total output: 583 medals, 799 medal tiers (up from 183/399 in
  production) — the ~400 extra medals are badges GAME_MASTER carries that
  the vendored snapshot never captured (added since 2026-07-28's fetch);
  they get the same token-derived fallback name every badge got before
  this fix, e.g. `gotour-2024-secret-00`. This is Task 3's already-accepted
  outcome of moving to GAME_MASTER (more badges exist there than pogoapi
  ever tracked), unaffected by this task.
- Cross-checked the 28 tier-target value differences my first-pass
  verification had flagged as suspicious (possible mis-joins): re-ran with
  the corrected alignment and only 2 remain, both `pokemon-go-safari-zone`
  rank-2 tiers going from `null` (old production, which had no real target
  for that event-badge tier) to `100` (GAME_MASTER's real target) — an
  accepted "GAME_MASTER now has data the old source didn't" upgrade, not a
  mis-join. Confirmed by checking the producing `badgeType` directly, not
  assumed.

The throwaway verification scripts were deleted after use; not part of the
commit. This specific 183/183 parity number depends on an untracked
`docs/drafts/GAME_MASTER.json` file that happened to already be in this
worktree, so it isn't re-derivable from `git log` alone without a fresh
real GAME_MASTER.json — but the *algorithm's* correctness (the alignment
logic, the insertion-in-the-middle case, the PK-safety fix) is fully
covered by committed fixture-based tests in `test/pogoapi-badges-source.test.ts`
and `test/transform-player-progression.test.ts`, independent of that file.

## Tests added/changed

**`test/pogoapi-badges-source.test.ts`** (new) — direct unit tests for
`alignVendorBadges`:
- Ranks align in order when nothing was inserted.
- **The real-world regression case**: a badge inserted between two vendored
  badges (`BADGE_A` vendored, `BADGE_INSERTED` not, `BADGE_C` vendored)
  doesn't shift the alignment for the badge after the insertion — `BADGE_C`
  still finds its vendored name on the far side of the gap. This is the
  test that would have caught the original bug.
- The walk never double-consumes a vendored entry and stops cleanly once
  the vendored list runs out.
- The documented known-limitation case: a vendored entry whose rank
  matches nothing remaining blocks its own match and everything after it.
- `loadVendorBadgeDisplayNames()` reads the real committed snapshot
  correctly (index 0 is "Triathlete", rank 5, non-empty description).

**`test/transform-player-progression.test.ts`**:
- Renamed "medals derive slug and name from the badge id" to "with no
  vendored badge data, medals fall back to..." and updated to pass `[]`
  explicitly now that the parameter is required.
- Vendored data (single-badge fixture, trivially aligned) overrides the
  id-derived name/description.
- A vendored candidate whose rank never matches any badge present is never
  consumed by `alignVendorBadges` (confirming `buildPlayerProgression`
  wires the aligner's `undefined` through to the id-derived fallback,
  rather than trusting the vendored array positionally) — the join logic
  itself is unit-tested directly in `test/pogoapi-badges-source.test.ts`.
- An index past the end of a short `vendorBadges` array still falls back
  correctly.
- Same-slug badges that **both** carry `targets` still collapse to one
  medal's tier rows rather than colliding on `(medalSlug, rank)` — the
  regression test for the `isFirstForSlug` PK bug found during review.
- Real-vendored-snapshot round-trip: `BADGE_7_DAY_STREAKS` -> slug
  `"triathlete"`, name `"Triathlete"`, cross-checked against the
  currently-committed `src/data/reference.json`.
- All other existing tests updated only to pass the now-required
  `vendorBadges` argument (`[]` where the test isn't about medals).

**`test/transform-reference-data.test.ts`** — the orchestrator template —
now calls `buildPlayerProgression(gameMaster, loadVendorBadgeDisplayNames())`
with the real vendored data, so Task 4 copies the correct pattern.

## Test results

- `npx tsx --test test/pogoapi-badges-source.test.ts
  test/transform-player-progression.test.ts
  test/transform-reference-data.test.ts`: 19/19 pass.
- Full `npm test`: **192/192 pass** (was 182 before this task; +10 net new
  tests, 0 failures, 0 regressions elsewhere).
- `npx tsc --noEmit -p tsconfig.json`: clean.
- `npx eslint` on all changed/new files: clean.

## Files changed

- `scripts/ingest/sources/pogoapi-badges.ts` (new)
- `scripts/ingest/transform/player-progression.ts` (modified)
- `test/pogoapi-badges-source.test.ts` (new)
- `test/transform-player-progression.test.ts` (modified)
- `test/transform-reference-data.test.ts` (modified)

## Self-review findings

- First verification pass had a real methodology bug (a combined
  rank/eventBadge/targets mismatch counter obscured the rank-specific
  mismatch rate; only the first 10 printed mismatches were checked by eye,
  and they happened to all be the unrelated `targets`-presence difference).
  Caught by the advisor before committing anything, prompting a second,
  properly-split verification pass that found the real 67/597 drift.
- That drift, once understood, turned out to have a clean root cause
  (alphabetical insertion, not random reordering) and a bounded fix
  (subsequence alignment) rather than requiring the "accept partial
  recovery" fallback my first corrected attempt reported.
- Advisor review also caught the `isFirstForSlug` PK-collision gap on the
  `targets` branch before it shipped, and correctly flagged that an
  unverified "none get the wrong badge's name" claim in an earlier draft
  of this report was an assertion, not a checked fact — prompted the
  per-badge-type check of the (now down to 2, both explained) tier-target
  diffs.
- Confirmed `gameMaster.allBadgeSettings()` returns `badgeSettings.all` —
  `byCategory.get("badgeSettings")`, populated by pushing records in raw
  GAME_MASTER.json iteration order with no sort — so "index N" is a stable
  join key on the GAME_MASTER side, which is what makes the alignment
  algorithm's guarantees hold.
- Did not touch `docs/drafts/GAME_MASTER.json` (pre-existing untracked
  file, unrelated to this task) or `vendor/pogoapi-snapshot/badges.json`
  (read only) — both used read-only for verification, and all throwaway
  verification scripts were deleted before committing.

## Explicit confirmations requested by the task

- **Medal slugs are stable / unchanged from before Task 3's GAME_MASTER-only
  re-sourcing**: confirmed by the end-to-end parity run above — all 183
  production medal slugs recovered with matching name and description, 0
  duplicate `medal_tier` primary keys, 0 defense-in-depth rank-mismatch
  warnings fired on real data.
- **Friendship/PvP/item-name/gender-union code paths were NOT touched**:
  `git diff` for this change touches only `scripts/ingest/sources/pogoapi-badges.ts`
  (new file), the medal-related lines of
  `scripts/ingest/transform/player-progression.ts` (the `medalDisplayName`
  function, its call site, the `buildPlayerProgression` signature/doc
  comment, and the `for` -> `.forEach` loop conversion + `isFirstForSlug`
  gating needed for the medal/medal-tier logic), and the medal-related
  parts of three test files (one new). `itemDisplayName` (item names, used
  by `playerLevelRewards`), `FRIENDSHIP_LEVEL_NAMES`/the
  friendship-building loop, and `pvp.ts` are byte-for-byte unchanged.
  `transform/species.ts` (gender-union logic) was not opened for editing.

## Concerns

1. **The alignment algorithm has one known, documented, unmitigated edge
   case**: a vendored badge later *removed* from GAME_MASTER (not just
   having new badges inserted around it) would break alignment for it and
   everything vendored after it, since the two-pointer walk has no way to
   tell "removed" from "shifted" using rank alone. Not observed in real
   data (0 leftover on the real 597-entry snapshot) and not fixable without
   a real key, which pogoapi.net's data doesn't have. If this pipeline is
   ever re-run years from now and medal names regress broadly again, this
   is the first thing to check.
2. **111 of production's 399 `medal_tier` rows don't come back, though no
   slug and no `medal_tier` primary key is lost** — a real gap, found while
   checking for this exact possibility at the advisor's prompting, and
   deliberately *not* fixed (explained below). Root cause: the
   `targets`-branch always numbers tier rows `rank: i + 1` over the
   `targets` array — correct for genuine multi-tier ladder medals (e.g.
   "Triathlete"'s `targets: [1, 10, 50, 100]` really does mean tiers 1-4),
   but GAME_MASTER's event badges (e.g. the four
   `BADGE_AA_2023_JEJU_DAY_0{0..3}` records collapsing to "Pokémon Air
   Adventures") each carry a single-element `targets` array *and* their own
   `badgeRank` (their real tier identity, e.g. `2`) — which the `i + 1`
   scheme discards in favor of always writing `rank: 1`. Old production
   (pogoapi.net-sourced, which never had per-event `targets` at all) wrote
   these as `rank: <badgeRank>, target: null` via the rank-only branch —
   so under real-name collapsing, the first-seen event badge for a slug now
   takes the `targets` branch instead and produces `rank: 1` (with a real
   target) instead of the old `rank: 2, target: null`, leaving the key the
   old data occupied absent from the new output. **This predates this
   task**: the `i + 1` numbering scheme and the "first-seen wins" collapse
   rule are both Task 3's original, unmodified design (verified: neither
   this fix's `isFirstForSlug`-gating change nor the alignment change touch
   which branch a badge takes or how tier rows are numbered within it) —
   this task's real-name collapsing is what exposes it, not something this
   task's code introduced. **Not fixed here** because it's a `medal_tier`
   rank/target *semantics* question (how should a single-rank event badge's
   own completion count be numbered against a multi-tier ladder medal's
   array?) — a design decision, not a mechanical continuation of "recover
   the name/description," and explicitly the kind of scope the task brief
   said to leave alone ("leave the other differences...unfixed,
   intentional") unless it threatened the FK the brief was about.
   **Confirmed it doesn't**: `medal_tier`'s only foreign key is
   `medal_slug REFERENCES medal(slug)` (`src/db/schema.ts:149`) — nothing
   references `(medal_slug, rank)`, so no personal data can dangle from a
   missing tier row, unlike the slug regression this task exists to fix.
   Product-visible effect: ~111 medals' progress-tier UI (wherever
   `medal_tier` rows drive a progress bar/threshold) may show no tier data
   for those particular event medals until this is addressed separately.
3. **~400 medals get token-derived fallback names** (e.g.
   `gotour-2024-secret-00`) because GAME_MASTER now carries more badges
   than the vendored snapshot ever captured — this will render on
   `TrainerPage.vue` and shift `StatsPage.vue`'s "Medals started N / M"
   denominator. This is Task 3's already-accepted, owner-sanctioned outcome
   of moving to GAME_MASTER, not something this task changed or could
   change (there's no vendored name to recover for badges that postdate the
   vendored snapshot).
4. **The 183/183 parity evidence depends on an untracked file**
   (`docs/drafts/GAME_MASTER.json`) present in this worktree but not part
   of the committed tree — reproducing the exact "how many of today's real
   badges recover" number would need a fresh real GAME_MASTER.json fetch.
   The algorithm's correctness itself (alignment logic, PK safety,
   fallback behavior) is fully covered by committed, real-data-independent
   tests.
