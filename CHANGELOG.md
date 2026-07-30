# Changelog

All notable shipped-version changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). This is the canonical home
for all shipped-version and feature history — see [docs/release-checklist.md](docs/release-checklist.md)
for how releases are cut.

Each entry corresponds to a `package.json`/`android/app/build.gradle`
version bump (see [docs/release-checklist.md](docs/release-checklist.md)'s release workflow), and
covers the commits between that bump and the previous one. Full historical content states can be checked out directly from git history.

## [1.2.0] — 2026-07-29

- Replaced pogoapi.net as an ingestion data source (stale/unmaintained;
  confirmed missing 222 species GAME_MASTER shows as shadow-eligible) with
  GAME_MASTER (`alexelgt/game_masters`) and the pokemongo-shiny community
  sheet for shiny release dates. Vendored a full pogoapi.net snapshot
  (`vendor/pogoapi-snapshot/`) before cutting the live dependency, since it
  uniquely had medal/badge display names GAME_MASTER doesn't publish.
- Consolidated the 9-script `scripts/ingest/` pipeline into one command,
  `npm run ingest` (flags: `--skip-sprites`, `--skip-sqlite`, `--check`).
  Removed the old `ingest:fetch`/`ingest:build`/`ingest:fetch-sprites`/
  `ingest:build-sprites`/`ingest:check-slugs`/`ingest:all`/`ingest:csv:*`
  scripts and the CSV manual-correction workflow.
- Added `form.shinyReleasedAt`: a real per-form shiny release date, not
  just a boolean, sourced from the pokemongo-shiny sheet's release-date
  tracking instead of an asset-presence heuristic confirmed to produce
  false positives.
- Added `npm run studio` — a dev tool that opens `drizzle-kit studio`
  against a freshly-regenerated `reference.sqlite` (real ingested
  reference data, no personal-table demo seed) for browsing ingested data
  directly.
- See [docs/ingestion-consolidation/summary.md](docs/ingestion-consolidation/summary.md)
  for the full writeup, including data differences accepted as intentional
  trade-offs and remaining follow-up items.

## [1.0.0] — 2026-07-19

- First tagged release. Both `docs/pre_launch_checklist.md` and
  `docs/release-checklist.md` verified item-by-item; all fixable items
  resolved. Two items remain open by nature (require a physical device at
  actual build/sideload time): Android in-place upgrade preservation and
  boot-rescue crash-path triggering — both are exercised as part of this
  release's own manual verification pass, not before it.

## [0.22.0] — 2026-07-16

- Verified both pre-launch and release checklists item-by-item and fixed
  what they flagged: 12 remaining stale code-comment references to deleted
  `docs/v1-tasks`/`docs/v1-roadmap`/`docs/features/` paths, one stale
  release-checklist wording leftover. Confirmed clean: slug stability
  check, downgrade guard (unit test), and the Settings "About" DB-version
  display (already implemented, checklist was stale on that one).
- Expanded `docs/install-guide.md` to cover the desktop/browser install
  path alongside Android sideloading; README now links to it as the
  canonical install doc instead of duplicating the steps.
- Recovered the quarantine-visibility spec and two deferred UI items that
  were lost when `docs/features/next.md`/`planned.md` were deleted by the
  prior docs restructure but missed by its recovery pass.
- Moved the live-walkthrough-script idea from the review dossier into
  `docs/roadmap.md` as a named, deferred item.

## [0.21.1] — 2026-07-15

- Consolidated documentation: flattened `docs/features/*`, `docs/v1-roadmap/*`,
  and `docs/v1-tasks/*` into `docs/features.md` and `docs/roadmap.md`, with a
  new `docs/pre_launch_checklist.md` tracking V1.0.0-specific pre-tag
  blockers. All still-open items from the deleted files (V2 watchlist,
  open polish items, status-TBD decisions) were carried forward into
  `docs/roadmap.md` rather than dropped. Fixed a dangling `docs/features/`
  reference in the release-checklist's git-add step.

## [0.21.0] — 2026-07-15

- Fixed Bulk Edit's Caught/Uncaught filter matching at species level instead
  of form level — "Caught" showed every form of any registered species
  (including forms not individually caught), and "Uncaught" hid a
  genuinely-uncaught form whose species happened to be registered because a
  different sibling form was caught. Added a per-tile check against each
  form's own `caught` boolean, closing the last of three known instances of
  this species-vs-form leakage pattern in Bulk Edit (see #26, #32).

## [0.20.0] — 2026-07-15

- Fixed Bulk Edit's field filters (Lucky, Shiny, 4★, etc.) matching at
  species level and then showing every form of that species, instead of
  just the form(s) actually matching — filtering "Lucky" showed all of a
  species with any one lucky form, not just the lucky one. Added a
  per-tile check for per-form fields; species-level-only filters
  (registered/rarity/mega-capable/etc.) are unaffected, since they don't
  vary per form.

## [0.19.0] — 2026-07-15

- Fixed a root-cause bug in the achievement cascade logic
  (`src/db/cascades.ts`): the case-sensitive suffix matching used to find
  each section's shiny/floor/4-star/shundo fields never matched Standard's
  own bare field names (`"shiny"`, not `"standardShiny"`) — only the other
  four sections' compound names (`luckyShiny`, `shadowShundo`, etc.)
  matched. This meant Standard's entire within-section cascade never
  worked: checking Shiny, Floor, 4-Star, or Shundo on a Standard catch
  never actually checked Caught, for any user, ever. Fixed by matching
  case-insensitively.
- Added cross-section cascade rules: any achievement in any section now
  implies Standard/Caught (previously only worked within one section at a
  time); Lucky Shiny/Shundo additionally promote Standard's own Shiny/
  Shundo, since Lucky is a trait added to an existing catch rather than a
  separate individual (unlike Shadow/Dynamax, which deliberately don't get
  the same promotion).

## [0.18.0] — 2026-07-14

- Species-detail form-tile touch targets bumped from 1.4rem (22.4px, below
  WCAG 2.2's 24px minimum) to 1.8rem (28.8px); sprites now scale to 90% of
  the tile's inner width instead of a fixed 56px. The filter-chip Legend
  (a real `<details>`/`<summary>`, already functionally tappable) now reads
  as interactive — accent-colored instead of muted/uppercase, scoped so
  real Settings-page accordions are unaffected.
- Dex grid tiles: sprite now fills the tile edge-to-edge (was a fixed
  64×64px); dex #/name moved into a separate box below the tile instead of
  sharing it with the image; grid column width tuned so exactly 3 tiles
  render per row on both a 400px phone width and a 730px desktop width,
  measured against the real rendered layout (accounting for the persistent
  sidebar at the 720px+ breakpoint) rather than assumed. Bulk Edit/
  species-detail's form-tile grid column width synced to match, so both
  pages' tiles read as the same size.

## [0.17.0] — 2026-07-14

- Meltan/Melmetal now show a real "Unidentified" region instead of "Alola."
  Pokémon GO's own Pokédex never ties them to a mainline region, but this
  app assigns regions purely by dex-number origin, which had put them under
  Alola (dex #808–809 falls in the Gen-7 range). Owner call: model them
  honestly with their own region rather than override the app's systematic
  rule with a one-off special case.
- Fixed a real bug in the reference-data CSV-correction tool
  (`scripts/ingest/csv-authoring.ts`) found while making the above change:
  `ingest:csv:import` only ever set species-level fields (region,
  mega-capability, gender availability, rarity, generation, gigantamax) when
  creating a brand-new species — re-importing an *existing* species with a
  hand-edited field silently left those fields untouched. Existing species
  now sync their fields on import the same way new ones do. Also added
  regions-table auto-sync to the same import path, so a correction that
  introduces a genuinely new region doesn't need a second manual edit.
- Closed out all three carried-over open questions from the V1 roadmap: the
  "bogus mega-capable" tracker flags (Uxie/Mesprit/Azelf/Malamar/Falinks)
  question was already resolved back on 2026-07-10 but never marked closed,
  and had the confirmed-bogus species backwards in its own writeup (fixed:
  the real five are Uxie/Mesprit/Azelf/Butterfree/Lugia, not Malamar/
  Falinks, which are real); the `001-Bulbasaur/Standard.md` Obsidian-refs
  question turned out to be moot (no such file exists); the
  unverified-genderless/inherited-availability question is explicitly
  deferred to post-V1, folded into a planned DB rework.

## [0.16.1] — 2026-07-14

- Removed Bulk Edit's `MAX_SPECIES_SHOWN = 120` display cap and its
  truncation note — Bulk Edit now renders every species a query matches,
  however large the list gets. As a side effect, this also fixed the
  select-all/apply bar's scope: it already only ever operated on
  currently-visible tiles, so once "visible" always equals the full match
  set, "Select visible" genuinely means all of it. Adjustable page-size/real
  pagination logged as a deferred idea in `docs/features/planned.md`.

## [0.16.0] — 2026-07-14

- Fixed Bulk Edit's `!costume` search hiding costume-having species (e.g.
  Pikachu) entirely instead of just hiding their costume-form tiles. It
  shared a species-level filter with the Dex grid, where `!costume` means
  "species that never had a costume" — negated, that's the wrong question
  for Bulk Edit, whose tiles are per-form, not per-species. A correct
  per-tile filter already existed in `bulk-form-edit.ts` but was
  unreachable because the species-level gate discarded the species before
  the tile loop ever ran. Fix is scoped to Bulk Edit; the Dex grid's own
  `!costume` meaning is untouched. Found by the owner while bulk-entering
  Shundos.

## [0.15.0] — 2026-07-14

- Reverses the earlier "ship debug-signed indefinitely, no release keystore"
  decision (D4). A dedicated release keystore now exists, backed up outside
  the repo, and `android/app/build.gradle` wires a `signingConfigs.release`
  block from credentials at a fixed home-directory path
  (`~/.android-keystores/keystore.properties`) — never checked into the
  repo, and not read from anywhere inside the checkout, so it works
  identically regardless of which worktree or clone is building. A missing
  properties file logs a build warning and falls back to an unsigned
  release build rather than failing silently.
- New `npm run android:release` (`android:sync` + `gradlew assembleRelease`,
  signed) alongside the existing `android:build` (debug).
- `docs/install-guide.md` updated: friends no longer need to export before
  *every* update solely to guard against a signing-key change, since the
  key is now stable. Exporting regularly remains good practice for other
  failure modes (migrations, corruption) and stays the recommended habit.
- Verified end-to-end: a clean `gradlew clean assembleRelease --rerun-tasks`
  build succeeds and `apksigner verify` confirms the output APK's signer
  fingerprint matches the keystore's, with zero `keystore.properties`
  anywhere in the repo tree.

## [0.14.0] — 2026-07-14

- Added a Playwright smoke suite (`e2e/*.spec.ts`, Chromium only) covering
  boot, toggle-and-reload persistence, Stats KPI counts, settings toggles,
  and the personal-data export/import round-trip — all driving the real
  `npm run dev` Vite server against its real IndexedDB-backed SQLite
  (jeep-sqlite + sql.js), not a mock backend. Wired into CI
  (`npm run test:e2e`) alongside the existing lint/typecheck/unit-test steps.
- Closes out the release-candidate checklist's smoke-suite/CI gate and the
  upgrade-over-install test (satisfied by the owner's ongoing regular
  debug-APK update cadence across 0.9.0→0.13.3, real on-device data each
  time, no data loss or boot-brick observed) — see
  `docs/v1-tasks/08-release-candidate.md`.

## [0.13.3] — 2026-07-14

- Fixed personal-data Export on web always reporting "Cancelled" with no
  save dialog ever appearing — the File System Access picker
  (`showSaveFilePicker`) was silently failing to open in some environments,
  and its `AbortError` was indistinguishable from a genuine user-cancel. Web
  export now always uses a plain Blob + anchor download instead of the FSA
  picker.
- Fixed a second export bug surfaced by the above fix: the downloaded file
  could fail to actually land on disk because `URL.revokeObjectURL` was
  called synchronously right after triggering the download, racing the
  browser's blob read. Now revokes on a deferred tick after the anchor is
  clicked and removed.
- Moved the "Back up before import" toggle to appear above the Export
  button in Settings, so it's visible before exporting rather than after.
- Added a note under Settings' "Collapse gender-split forms" toggle
  explaining why Bulk Edit's selection counter can jump by more than one
  per tap — Bulk Edit always groups a species' gender-split forms into one
  tile regardless of that setting, so tapping one tile there selects every
  underlying form.

## [0.13.2] — 2026-07-14

- Fixed Bulk Edit's tile-selection highlight being completely invisible —
  `.form-tile.selected` had no CSS rule at all, so tapping a tile to select
  it for bulk-apply had zero visible effect.
- Added a tap-reachable filter-chip "Legend" (Dex grid and Bulk Edit) mapping
  every badge glyph to its full name — hover-only tooltips were the only
  disambiguation before this.
- Species-detail's form grid now rebuilds only the toggled tile in place
  instead of the whole page.
- Search-matching change: an all-digit query now matches the dex number
  exactly instead of as a substring (no more "25" also matching #125/#225/
  #250-259/...); name matching became fuzzy (subsequence-based, tolerates
  typos) and punctuation-forgiving (handles Farfetch'd's curly apostrophe,
  Mr. Mime's period).
- Docs audit: fixed dead `TODO.md` cross-references, a stale "dual-backend"
  claim, 404ing relative links in `docs/features/history/`, and two
  install-guide sections that framed already-shipped features as still open.

## [0.13.0] — 2026-07-13

- Minimal keyword search: type `costume`, `legendary`, `mythical`, or
  `ultrabeast` alone into any search box (Dex grid, Bulk Edit,
  species-detail's own form filter) to filter by it instead of a plain
  name/dex match — prefix with `!` to negate (e.g. `!costume`). Bulk Edit
  additionally filters costume/non-costume at the individual form-tile
  level, not just which species show up. Documented on the Help page.
  Deliberately not the full AND-of-OR search-string builder specced for
  post-V1 — just enough to answer "show me only X" in the box that's
  already there.
- Audited search across the app while building the above; found and fixed
  a regression in the new feature itself before shipping (a `!`-prefixed
  query that isn't a recognized keyword, e.g. `!raichu`, used to silently
  match nothing instead of falling back to a plain search). Other gaps
  found (dex-number substring noise, curly-apostrophe name mismatches,
  keyword-vs-chip duplication) are reported in `docs/v1-tasks/03-visual-
  and-legibility.md`, not yet fixed.

## [0.12.3] — 2026-07-13

- **Fixed a second real import crash**: `CommitTransaction: Cannot perform
  this operation because there is no current transaction`, firing on
  effectively every import (any real export includes app settings).
  `onAppSettingChanged` was the one write hook in `sqlite-repository.ts`
  that never adopted the `inBulk` transaction-guard convention the other
  four hooks use, so writing an app setting mid-import closed the outer
  transaction early. Fixed to mirror the existing pattern.

## [0.12.2] — 2026-07-12

- **Fixed a real-device crash**: importing personal data could throw
  "Couldn't open the on-device database" right after a successful import.
  Root cause: a `window.location.reload()` after import raced
  `capacitor-community/sqlite`'s native connection registry, which survives
  a WebView reload — the fresh boot found the connection already marked
  open and calling `.open()` on it again failed. Removed the reload
  (unnecessary — the in-memory cache every screen reads from was already
  updated) and hardened `getDb()` to skip re-opening an already-open
  connection, covering other reload-shaped scenarios too.
- Backup-before-import is now a persistent Settings toggle ("Back up
  before import," default off) instead of a confirmation dialog asked on
  every import.

## [0.12.1] — 2026-07-12

- Visual polish from the first real on-device pass: species-detail header
  splits into an identity box (sprite/name/nav) and a new Region + Type(s)
  box, form-tile and hero sprites sized up to actually show the real art
  from the image pipeline, desktop now uses the full screen width instead
  of a capped column, Settings' "Grid badges" fieldset is collapsible and
  starts collapsed, and the About section now shows the personal-data
  schema version and reference-data hash alongside the app version.
- Adds `Repository.getFormTypes()`, backed by reference data already
  resident in memory — no new DB round-trip.

## [0.12.0] — 2026-07-12

- Mega Evolution + Gigantamax/form-complete semantics: species-wide Mega
  tracking (Evolved/Shiny Evolved per variant, X/Y/Primal support), Mega
  and Gigantamax stats lenses, and a form-complete denominator fix
  (Gigantamax/regional-exclusive forms handled correctly rather than
  inflating the "missing" count).
- Mobile ergonomics redesign: bottom tab bar / persistent sidebar nav
  (replacing the hamburger drawer at every width), filters moved into a
  callable bottom sheet / anchored panel instead of always-visible chips,
  and quick-toggle tiles on the dex grid.
- Data-entry legibility/accessibility polish pass, and a Stats page
  rebuild (PowerBI-style dashboard with a drillable missing-species grid),
  plus a real performance fix (missing SQL index on `form.species_slug`
  that was making the Stats page slow).
- Image pipeline (§7): swapped the entire species sprite set for
  PokeMiners-sourced art (953 species, up from 809), auto-matched ~230
  regional-form and costume sprites plus all 57 Mega/Primal variants, and
  added a shiny-art view toggle. Along the way, fixed a real
  `build-reference.ts` bug where Pokémon GO-exclusive Mega Evolutions
  (Dragonite, Skarmory, Raichu, Malamar, Victreebel, Falinks) were being
  silently rejected by a mainline-game-only version filter, and fixed a
  single mislabeled spreadsheet row that had made Espurr (#677) invisible
  to the entire reference-data pipeline.
- Dead-code cleanup (removed the unused localStorage dummy-repository
  backend and its in-memory completion-stats path now that real SQL
  covers it), a real unit-test suite (migrations, reference-sync,
  export/import round-trip), and a CI workflow (lint + typecheck + tests
  on every push) plus an on-demand GitHub Actions APK build.
- New in-app Help page (badge-glyph legend, stats-lens definitions,
  Floor/Shundo glossary, filter-chip explanation), the app version now
  shown in Settings, and backup guidance text next to the Export button.
- Personal-data import is now a real restore instead of a merge — it
  wipes the existing collection before applying an imported file's rows,
  so data that only exists locally (and isn't in the file being imported)
  no longer silently survives underneath it. The pre-import safety backup
  is now an explicit opt-in prompt instead of a forced dialog on every
  import.

## [0.11.0] — 2026-07-09

- Applied a full visual design system ("Night Studio": dark-first ink-blue/
  teal palette, soft radii, hairline borders, monospace reserved for numeric
  data) across the app shell, species grid/detail, stats, and Settings —
  replacing the previous browser-default styling. Added a manual
  System/Light/Dark theme override, and widened the app's layout above a
  720px viewport so tablet/desktop use more of the screen.
- Reference-data correction pass: fixed Necrozma fusion names, gen-9 slug/
  name typos, phantom "Standard" form rows (with a shiny-flag migration to
  the real default form), added the six missing mega-variant rows (incl.
  Mega Mewtwo X/Y) and Crowned Sword/Shield Zacian/Zamazenta. Found and
  fixed further data-quality bugs via a systematic scan: a duplicate
  Armored Mewtwo (modeled both as a Forme and a costume), Grimer/Muk/
  Slowking region mislabels, a bogus Persian regional form, and a Tauros
  breed-name mismatch that was silently defaulting three forms to the wrong
  type.
- Data-safety net: boot-failure rescue export, reference-sync orphan
  quarantine, hardened migration runner (per-migration transactions +
  downgrade guard), a persistent write-failure banner, import skip
  reporting, pre-import auto-snapshot, and an ingestion-time slug-stability
  check.
- Reorganized `docs/` into a navigable, cross-linked structure; retired
  `TODO.md` in favor of the versioned `docs/v1-tasks/`/`CHANGELOG.md` split.

## [0.10.0] — 2026-07-08

- Modeled Gigantamax as distinct catchable form rows (not a separate
  personal-data field).
- Made Coverage Report actionable via a CSV export/template/import
  round-trip, with auto-refreshing gap counts.
- Added bulk-edit UI: grid select-mode + form-level quick-entry.
- Added forward-only cascading checkbox updates (checking a combined
  achievement like Shundo auto-checks its components).
- Fixed a DB-open crash on reference re-sync when personal data exists.
- Reorganized `TODO.md` so actionable work sits at the top.
- Added branch/versioning development workflow, ESLint, and a pre-commit
  lint hook (`.githooks/pre-commit`).
- Split `CLAUDE.md` into working invariants + `docs/`; added the V1 planning
  roadmap and task breakdown.
- Fleshed out README with prerequisites, clone step, and a features overview.
- Added CI workflows (Claude Code Review, Claude PR Assistant).

## [0.9.0] — 2026-07-01

- Completion-stats tracking (Stats page).
- Native Android scaffolding; fixed a stale Coverage Report.
- Fixed the grid Dynamax filter bug, improved data quality, added a real
  app icon.
- Manual cross-device export/import, toggle-availability gating, and
  versioning docs.

## [0.0.1] — 2026-07-01

- Initial dex-tracking foundation with real ingested reference data.
- Fixed Unown's spurious Standard form; ingested Bulbapedia costume data;
  reworked the forms UI.
- Grid tri-state filters + real SQLite persistence.
