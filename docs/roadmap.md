# Future Roadmap (PoGo Buddy)

This is the canonical future roadmap for PoGo Buddy: planned features, enhancement checklists, target versions, the V2 watchlist, open polish items, and items still awaiting an owner decision.

**Versioning reset (post-1.0.0)**: every `v1.1.0`/`v1.2.0`/`v2.0.0` target in
§2's table below was placeholder numbering, not a commitment. Going forward:
`1.0.Y` is the only version that ships as a public release, and covers fixes
only. All new feature work happens under internal `1.X` versions with no
public release attached — it accumulates toward `2.0`, the next real release.
§2 "V2 Phased Plan" below is the current plan for that `1.X → 2.0` gap.

---

## 1. Master Roadmap Checklist

A high-density list of planned features grouped by functional area.

### Progression & Stat Trackers
- [ ] **Multi-Account & Sharing**: Allow importing databases from friends to show completion comparisons and trade gap analysis.
- [ ] **Level Tracker**: Track total XP progression to level 80 and display required level-up tasks.
- [ ] **Medal Tracker**: Medal progress metrics, checklists, and strategic advice for unlocking achievements.
- [ ] **Best Buddy Tracker**: Track buddy status, ribbon achievements, and active CP level boosts.
- [ ] **Buddy Heart Daily Tracker**: Log daily buddy points (play, feed, snapshot, battle, walk) with calculators estimating days remaining to Best Buddy.
- [ ] **Routes & Zygarde Cell Tracker**: Track Route completions and daily Zygarde Cell progression toward 50% and 100% Zygarde Formes.
- [ ] **Gym Badge Tracker**: Track personal Gym badges (Bronze, Silver, Gold) with custom name and location markers.

### Battle & PvP Reference Tools
- [ ] **PVP/PVE Team Builder**: Simulator for building optimized team compositions based on movesets, type matchups, and IV stats.
- [ ] **PVP Stat Product / Rank Calculator**: Offline rank calculator taking a species and IV spread to calculate exact stat product and PvP rank (1–4096) for Great/Ultra Leagues.
- [ ] **Type Effectiveness Matrix**: Offline quick-reference battle helper for checking weaknesses, resistances, and immunities.
- [ ] **Raid Counter Simulator**: Select a raid boss and show the top offline-recommended counter species and optimal movesets.

### Capture & Encounter Utilities
- [ ] **Wild 100% IV CP Lookup**: Offline tables showing exact CP values signaling a potential wild 100% IV encounter for levels 1–35 (standard & weather-boosted).
- [ ] **Wild CP OCR Assistant**: Fully offline client-side OCR (e.g. Tesseract.js) parsing wild encounter screenshots to instantly flag matching possible 100% IV CPs.
- [ ] **Raid Boss 4★ CPs**: Display maximum CP thresholds for perfect-IV (4★) Raid boss encounters to simplify capture checks.
- [ ] **Showcase Score Calculator**: Calculate estimated showcase points (0-1000) for weight, height, and IV combinations to identify top showcase contenders.
- [ ] **Catch Rate Calculator**: Input species, ball type, throw quality, berry, and medal tiers to calculate the exact catch percentage.
- [ ] **Shadow Purification Calculator**: Predicts if a shadow Pokémon's IVs will result in a perfect 100% (4★) IV upon purification (+2 to all stats).

### Collection & Data Helpers
- [ ] **Caught Notes**: Ability to attach custom notes/stamps to individual caught forms (e.g., date caught, trade origin, location).
- [ ] **Trade Board Registry (LF/FT)**: Local trade board logging duplicate shinies/costumes "For Trade" (FT) and missing dex requirements "Looking For" (LF).
- [ ] **Evolution Candy Calculator**: Local resource planner estimating total candies, candy XLs, and special items required to complete living-dex evolutions.
- [ ] **Egg Hatch Checklist**: Track current egg pool reference lists (2km, 5km, 7km, 10km, 12km) and tick off hatch-only achievements.
- [ ] **Manual Search Builder**: Tri-state toggle UI (off → include → exclude) generating valid GO search strings with `&`/`,`/`!` operators.
- [ ] **Auto-Declutter Engine**: SQL-based reduction engine generating a single grouped transfer query (e.g. `1,3,25&!4*&1*,2*,3*`).
- [ ] **Background Legality**: Track form-specific background legality instead of assuming every background is legal on every form.
- [ ] **Coverage Report Persistence**: Save gap-reviewed state via `coverage_reviewed` settings flags.
- [ ] **Bulk Edit Pagination**: Introduce pagination controls or an adjustable display cap setting to optimize rendering speed.
- [ ] **Page-Mode Consolidation**: Collapse Dex Grid and Bulk Edit into a single route, using a toggled "Browse vs Edit" layout mode.
- [ ] **UI Tile Unification**: Refactor Dex `.species-tile` and Bulk Edit/Detail `.form-tile` into a shared component.

---

## 2. Detailed Roadmap Table

Use this table during development to track progress status, notes, and target version releases.

| Feature Name | Phase / Target | Status | Development & Versioning Notes |
| :--- | :---: | :---: | :--- |
| **Multi-Account & Sharing** | Phase 2 | Planned | Widened scope (see §3 below): local profile switching for multiple GO accounts in one app instance, plus exporting/comparing a profile against a friend's for completion/trade-gap analysis. |
| **Caught Notes** | `TBD` | Planned | Store notes inside a new `personal_notes` table keyed by form slug. |
| **Raid Boss 4★ CPs** | `TBD` | Planned | Reference dataset mapping raid boss species to their perfect CP encounters at level 20 (and level 25 weather boosted). |
| **Showcase Score Calculator** | `TBD` | Planned | Local math helper taking species, height, weight, and IV stats to compute local showcase score. |
| **Shadow Purification** | `TBD` | Planned | Quick UI lookup to see if shadow IV stats are >= 13/13/13 (resulting in 15/15/15 when purified). |
| **Evolution Resource Calc** | `TBD` | Planned | Candy/Item calculator to estimate the resources needed to finish regional dex evolutions. |
| **Type Matchup Matrix** | `TBD` | Planned | Simple grid interface mapping offense/defense multipliers on species view pages. |
| **Best Buddy Tracker** | `TBD` | Planned | Checkboxes tracking best buddy ribbons and daily buddy activity logs. |
| **PVP/PVE Team Builder** | `TBD` | Planned | Simulation engine calculating type matchup coverages and ideal movesets. |
| **PVP Rank Calculator** | `TBD` | Planned | Offline stat-product calculator matching custom IVs against the optimal PvP level stats. |
| **Wild 100% IV Lookup** | `TBD` | Planned | Wild encounter CP guide for perfect stats at levels 1 to 35. |
| **Wild CP OCR Assistant** | `TBD` | Planned | OCR tool scanning overlay captures to parse CP values offline. |
| **Trade Board LF/FT** | `TBD` | Planned | Interface to export a small "trade checklist" text sheet to share with local communities. |
| **Zygarde / Routes Tracker** | `TBD` | Planned | Progress checklist showing route completions and Zygarde Cell counts. |
| **Gym Badge Tracker** | `TBD` | Planned | Basic local list of visited gyms and badge tiers. |

Only **Multi-Account & Sharing** currently has a phase assignment (Phase 2,
below) — everything else in this table is unsequenced backlog until it's
slotted into a future phase.

---

## 3. V2 Phased Plan

The concrete plan for the `1.X → 2.0` gap. Phases run **strictly sequentially,
one at a time** — not in parallel — to keep scope and cost bounded. Each
phase should be finished and confirmed before the next starts.

### Phase 0 — Ingestion & Reference Data Overhaul

Runs first: richer backend data makes it easier to see which follow-on
features are cheapest to build.

- Spike: pull data from [pogoapi.net](https://pogoapi.net/documentation/) and
  [pokemon-go-api/pokemon-go-api](https://github.com/pokemon-go-api/pokemon-go-api),
  and compare field coverage/quality/freshness against the current
  PokeAPI + CSV + wikitext pipeline (see [ingestion-runbook.md](ingestion-runbook.md)).
  Spike findings, sample payloads, and a table-design starting point:
  [v2-data-source-findings.md](v2-data-source-findings.md). Current read:
  pogoapi.net covers species/forms/costumes *and* the previously-uncovered
  player-progression data (XP, levels, medals, friendship, battle league);
  sprites are not in pogoapi.net at all but are available from
  pokemon-go-api's companion `assets` repo — likely both sources end up used,
  each for what it's actually good at.
- Decision gate: replace the current pipeline if the new sources are
  equal-or-better coverage and simpler to maintain; otherwise use them as
  supplemental sources for fields we currently lack. Don't assume the
  outcome — actually check coverage before deciding.
- While rebuilding ingestion, store broader reference fields than we
  currently surface in `reference.json`, even for fields nothing uses yet —
  cheap to capture now, avoids re-scraping later.
- Fix known ingestion footguns while the pipeline is already being touched:
  `ingest:build` wiping previously-imported event-costume rows on every run,
  silent stale-intermediate-file bugs, and CSV corrections silently no-op'ing
  on fields not covered by `reference-csv-format.ts`.
- Output feeds updates to `docs/ingestion-runbook.md` and `docs/data-model.md`.

### Phase 1 — Personal Data Timestamps & Migration/Update-Script Fixes

Separate subject matter from Phase 0 (ingestion/reference data vs. personal
collection data) but still runs sequentially after it, not concurrently.

- Add timestamp column(s) (e.g. `created_at`/`updated_at`) to the personal
  tables (`species_personal`, `form_personal`, `form_background_personal`,
  `mega_personal`) — currently none exist. Needed as a foundation for Phase
  2's multi-account merge/comparison logic.
- Extend the migration system (`src/db/migrations.ts`'s
  `runPersonalMigrations()`, or a parallel mechanism) so a migration step can
  **backfill/re-infer** data into existing rows, not just alter table shape.
  Concrete known bug to fix: a personal-data row was found with 4★
  (perfect-IV) checked and `registered` checked, but `caught` unchecked — an
  inconsistent state given the app's own inference rules (4★/registered
  should imply caught). This needs the actual inference rules defined between
  these boolean fields, and a one-time consistency sweep over existing rows,
  not just handling for future schema-version bumps.
- Open question, not yet resolved: whether "let user tables at any version
  use the update script" describes a gap beyond what
  `runPersonalMigrations()` already does (it already replays migrations from
  any stored `schema_version` forward) — possibly refers to exported/backed-up
  DB files from very old installs, or DBs that skipped migrations somehow.

### Phase 2 — Multi-Account

This phase was split into two sub-projects during the V2 consolidation
brainstorm (`docs/superpowers/specs/2026-07-23-v2-consolidation-roadmap.md`'s
Sub-project 7 split): **7a**, local multi-account only, and **7b**,
cross-device comparison/merge. The single-DB-with-`profile_id` vs.
multiple-files decision below was resolved in 7a's favor (single DB file,
`profile_id` widened onto every personal table's PK, `profile.id` retyped to
a UUID) — see
`docs/superpowers/specs/2026-07-25-sub-project-7a-local-multi-account-design.md`
and [data-model.md](data-model.md)'s migration `0004` writeup for the
resulting schema.

**Sub-project 7a (local multi-account: create/switch/rename/delete a
profile, each with fully independent Dex/Collection/tags/progress) is
complete.** Sub-project 7b (cross-device comparison/merge, stable
`pokemon_instance`/`tag` identity) is next in sequence.

Closing out both items carried forward from Sub-project 2 (originally
tracked in `docs/superpowers/specs/2026-07-23-v2-consolidation-roadmap.md`'s
"Carried forward from Sub-project 2" section) — both are now moot as of
Sub-project 7a's migration:
- **"Trainer-level FK fix needs live confirmation."** Resolved: the FK is
  now genuinely enforced (`profile_id` columns carry a real
  `REFERENCES profile(id)` constraint) and covered by a dedicated regression
  test that inserts a row with a bad `profile_id` and asserts the FK rejects
  it — a stronger confirmation than the originally-requested live device
  check.
- **"Possible latent `profile_id` mismatch on existing rows."** Resolved:
  Sub-project 7a's migration unconditionally rewrites every pre-existing
  row's `profile_id` to a freshly-generated real UUID, regardless of what
  integer value it held before — there is no longer a by-value match that
  could be wrong.

Deferred items from Sub-project 7a's design doc (see that doc's "Out of
scope / deferred" section), logged here per that doc's instruction:
- **Copy/duplicate-an-existing-profile option** at profile-creation time —
  new profiles always start blank today; a copy option was explicitly
  deferred by the owner, to revisit after real-world use.
- **Quick-switch UI outside the Trainer page** (e.g. a header/nav dropdown)
  — switching lives on the Trainer page only for now; the header only got a
  read-only current-trainer indicator. Deferred to revisit once the app has
  been used for a while and it's clearer whether switching needs to be
  available everywhere.

Sub-project 7b's scope (not yet brainstormed):
- **Sharing/comparison**: export a profile (or subset) to hand to a friend
  for read-only completion/trade-gap comparison.
  - **Stats page**: add a "compare" section to select the current account
    plus one other account and view both side by side.
- **Stable identity for `pokemon_instance`/`tag`**: both currently stay local
  `AUTOINCREMENT` integers (deliberately untouched by 7a); giving them a
  stable, cross-device-meaningful identity is a prerequisite for real merge
  semantics and is 7b's job.
- Depends on Phase 0 (richer reference data may change what's worth
  comparing) and Phase 1 (timestamps needed for merge/diff logic) having
  already landed — both are done.

### Not yet committed

- **Identity/slug rework** and **reference/personal DB file split** — see §4
  V2 Watchlist below. Phase 2's profile-storage decision is now made (single
  DB with `profile_id` widened onto every affected table's PK, per
  Sub-project 7a) — these two items can be revisited against that resolved
  schema, since they touch the same surface.
- **Vue 3 (or similar) for the stats page** — worth considering once the
  Stats-page compare view above is built, not a requirement.

---

## 4. V2 Watchlist (Deferred, With Rationale)

These items were deliberately pushed past V1, each for a specific reason —
not just "later." Recovered from the pre-restructure `docs/v1-tasks/09-v2-watchlist.md`
and `docs/data-model.md`'s "Future direction" section (git history at
`f7cb308^`).

- **Identity/slug rework**: Move the stable identity key for species/forms/costumes
  off the current cosmetic `slug` column and onto something durable — most likely
  Niantic's own game-master form/costume ID enum — with `slug` demoted to a
  purely display-only column. Deferred because it's entangled with the
  image-pipeline's numeric-ID matching work and would force a migration of
  every downstream reference (sprite manifests, exports, costume-lookup
  overrides); doing it now would block other in-flight V1 work rather than
  simplify it. Cross-reference: §3 Phase 2 ("Not yet committed") flags this
  as worth revisiting once the multi-account profile-storage decision lands,
  since both touch the same schema surface.
- **Reference/personal database file split**: Split the single SQLite file
  into two physical files — one for bundled reference data, one for personal
  collection data. Deferred alongside the slug rework since both are the same
  "heavier DB rework" the owner is planning post-V1; bundling them together
  is less total churn than doing either alone first. Cross-reference: §3
  Phase 2 ("Not yet committed") flags this the same way as the slug rework
  above.
- **Purified-form branch**: A dedicated purified-lucky/purified-shiny/purified-hundo
  branch of achievement tracking, distinct from the existing Shadow/Purified
  boolean. Not scoped or schema-designed yet.
- **`paradox` rarity classification**: A new rarity bucket for Paradox
  Pokémon, alongside the existing legendary/mythical/ultrabeast keywords and
  chips. Deferred as an extension of the same rarity-taxonomy work, not
  urgent for V1's dex-tracking scope.
- **Mega level column**: A `Base`/`High`/`Max` mega-level column is not yet
  modeled anywhere in the schema. Deferred pending real in-game data on how
  mega levels should factor into completion lenses.
- **Z-A megas ingestion-filter update**: `build-reference.ts`'s mega-variant
  filter needs a follow-up pass once *Legends: Z-A*'s new Mega Evolutions
  actually ship in GO (they're official DLC content, not fan content — see
  the ingestion pipeline notes) so they get picked up rather than filtered
  out by the current mainline-`version_group` matching rule.
- **Reference/informational content beyond dex-tracking**: per the owner,
  a much larger tier of static game-reference content is wanted eventually —
  Mega/Gigantamax candy cost per species (note: this isn't a separate
  currency — Mega/Gigantamax leveling uses the same candy/candy XL as any
  other form, so this is really "how much of that shared resource does this
  species' Mega/G-max form need," not a new cost type), Pokédex flavor text
  (species descriptions), CP at max level, full learnable-moveset lists
  (fast + charged, per species/form), and an XP-optimization guide for
  reaching level 80 efficiently. None of this is personal per-catch data,
  so per CLAUDE.md's data-ownership principles it belongs in its own
  reference-ingestion-fed table(s)/feature area rather than bolted onto
  `species`/`form`. Route candy-cost/CP/movesets/dex-text through the same
  ingestion pipeline ([docs/ingestion-runbook.md](ingestion-runbook.md)) once
  a data source is picked. The XP-optimization piece is related to this
  document's existing **Level Tracker** checklist item above but is a
  distinct feature (progression tracking vs. an efficiency guide) — keep
  both as separate roadmap items, not a merge candidate.
- **Other identified-but-unscoped V2 items**, kept here so they aren't
  silently dropped: full adoption of `executeSet`/`importFromJson`/`copyFromAssets`
  for bulk writes (a V1 contingency that was evaluated and explicitly not
  pulled forward — see CHANGELOG); a manual verification pass over roughly
  65 unverified-genderless species and 385 inherited-availability forms
  currently riding as Coverage-Report-flagged caveats (deferred because it
  makes more sense folded into the DB rework above than done standalone);
  Coverage Report review-state persistence so a reviewed gap stays reviewed
  across `ingest:build` re-runs; the tri-state Manual Search Builder and
  Auto-Declutter Engine already listed above in the Master Roadmap Checklist
  (their safety-clause spec work — protecting shiny/lucky/costume/legendary
  from accidental transfer, and excluding `favorite`/`specialbackground` by
  default — is already written up; the multi-rule priority order is still
  undecided); and a dark-mode manual toggle plus a dedicated ≥768px desktop
  breakpoint, if not already finished as part of ongoing legibility work.

---

## 5. Open Polish Items (Not Blocking V1 Tag)

Known rough edges, not release blockers. Recovered from the pre-restructure
`docs/v1-tasks/03-visual-and-legibility.md`, `05-image-pipeline.md`, and
`07-documentation-and-release.md`.

- **Species-detail perf**: toggling a field on the species-detail page still
  triggers a full-page rerender of the entire form-tile grid
  (`src/features/data-entry/species-detail.ts`). Should rebuild only the
  toggled tile in place instead.
- **Search-quality bugs** (four distinct issues, all in the search path):
  - Dex-number search is unanchored substring matching rather than
    prefix/exact — typing `25` to jump to #25 Pikachu also matches #125,
    #225, #250–259, #325, #425, etc. Affects the grid, Bulk Edit, and the
    header's species-detail "jump to" box
    (`String(species.dexNumber).includes(q)` in `src/data/in-memory-store.ts`).
  - No apostrophe/punctuation normalization anywhere in the search path:
    `reference.json` stores Farfetch'd/Sirfetch'd with a curly quote
    (U+2019), so typing the ordinary keyboard apostrophe never matches;
    `Mr. Mime`/`Mr. Rime`/`Type: Null` require typing the exact
    period/colon.
  - The `legendary`/`mythical`/`ultrabeast` search keywords duplicate the
    existing classification filter chips exactly and compose by AND with
    them — typing `legendary` while the L chip is set to Exclude silently
    produces zero results with no indication why.
  - The header's "jump to species" search box (species-detail route only,
    `src/app-shell/header.ts`) isn't debounced (unlike the grid's filter
    input in the same file), has no "no matches" empty state, and no
    truncation indicator past its 8-result cap.
- **Delete a specimen from Collection**: there's no way to permanently remove
  a `pokemon_instance` row — only status changes (kept/traded/released/evolved)
  exist (`repo.setPokemonInstanceStatus`, `CollectionPage.vue`'s action menu).
  "Release" changes status but doesn't delete the row; there's no
  `deletePokemonInstance` repository method at all. Owner-reported
  2026-07-24, explicitly deferred (not urgent) alongside the evolution item
  below.
- **Evolving a specimen doesn't change its species/form**: marking a
  specimen "Evolved" via Collection's action menu only flips
  `pokemon_instance.status` to `'evolved'` — the row's `form_slug` is never
  updated to the evolved species/form, so an evolved specimen still shows as
  its pre-evolution species everywhere (Collection, Edit details, tags).
  Needs its own scoping: which evolution target (species can have multiple
  evolution paths — `species_evolution` reference table already models
  `from_species_slug`/`to_species_slug`/candy or item requirements, but not
  a specific *form* target when the destination has multiple forms/costumes),
  whether IVs/shiny/lucky/shadow/tags/nickname carry over to the new row
  (real Pokémon GO behavior: they do, for the same individual), and whether
  this is an in-place `form_slug` update or a new row replacing the old one.
  Owner-reported 2026-07-24, explicitly deferred (not urgent).
- **`form.imageRef` cross-referencing**: the reserved `form.imageRef` column
  is still not wired up into `build-reference.ts`'s ingestion output — the
  sprite-slug manifest (`src/data/form-sprite-slugs.json`) currently serves
  the same "does this form have art" purpose without needing it. Revisit
  once `costume-lookup.json` has more real entries and the extra-images
  backlog shrinks.
- **`docs/data-model.md` DDL-vs-`schema.ts` divergence**: the documented DDL
  has drifted from the actual `schema.ts` (e.g. the Gigantamax modeling
  decision, mega columns, and `form_personal`'s shiny fields aren't fully
  reflected). Needs a dedicated sync pass.
- **Settings "Grid badges" fieldset**: it's the longest fieldset on the
  Settings page (up to `MAX_GRID_INDICATORS` pickable rows) and currently
  pushes everything below it down by default. Should be collapsible and
  start collapsed.
- **Rebuild e2e coverage on `tauri-driver`**: Sub-project 6 (Capacitor →
  Tauri) retired the Playwright suite (`e2e/*.spec.ts`, 10 spec files
  covering boot, Dex grid, log-catch, edit-instance, persistence, settings
  export, species detail, tags) because Playwright can't drive a
  Tauri-hosted webview (it speaks CDP; Tauri's own testing story is
  `tauri-driver`, a WebDriver-protocol tool needing a different test
  runner — `webdriverio` or `selenium-webdriver`, not Playwright). No
  WebDriver spike has been run yet. Needs its own brainstorm: which
  runner, whether all 10 specs get 1:1 ports or the coverage gets
  re-scoped, and whether `webkit2gtk` (the Linux Tauri webview's engine)
  behaves differently from the Chromium the old suite drove for any of
  the ported specs. Deferred 2026-07-24 (accepted as an e2e gap during
  the Tauri migration, owner call).
- **Desktop packaging/distribution format**: Sub-project 6 only verified
  `cargo tauri build` produces a working host-platform (Linux) bundle.
  Installer format, code signing, and how a desktop build would actually
  reach a user (vs. Android's existing sideload-an-APK flow) are
  undecided. Deferred 2026-07-24 (explicit non-goal of Sub-project 6,
  owner call).
- **Android release APK is unsigned**: `npm run android:release` (`cargo
  tauri android build`) produces `app-universal-release-unsigned.apk` —
  Tauri's generated `src-tauri/gen/android/app/build.gradle.kts` has no
  `signingConfigs` block at all, unlike the old Capacitor-era Gradle setup
  which read `~/.android-keystores/keystore.properties` automatically.
  Verified during Sub-project 6's final build check by signing the APK
  out-of-band with `zipalign`/`apksigner` for verification purposes only —
  that manual step isn't a real release process. Needs either a Gradle
  `signingConfigs` block wired to `keystore.properties` (matching the old
  setup) added to the Tauri-generated file (note: `cargo tauri android
  init` regenerates this file, so the fix needs to survive re-init, e.g.
  via a documented post-init step or a Tauri hook), or the manual
  `apksigner` step documented as the interim release process in
  `docs/release-checklist.md`. Found 2026-07-25, not urgent (no release
  has shipped since the migration; blocks only actual distribution, not
  development).
- **Desktop catch-logging UI never click-tested end-to-end**: Sub-project
  6's final verification confirmed the desktop build's SQLite/transaction
  layer (reference-sync succeeding, surviving process restarts) via direct
  database inspection, and confirmed a real user-driven "log a catch, see
  it persist" flow on Android — but never combined both (real UI clicks on
  desktop specifically) because this dev machine has no `xdotool`/
  `ydotool`/`wmctrl` and KDE's Wayland input-consent dialog blocks the one
  workaround found. The underlying IPC/DB code path is identical to
  Android's (same vendored plugin, same `tauri-sqlite-connection.ts`), so
  this is a low-risk gap, not an unverified core mechanism — but a
  desktop-specific frontend regression in the catch-logging UI wouldn't
  have been caught by this migration's verification. Worth a manual
  smoke-test next time a desktop build is available to click through.
  Found 2026-07-25, not urgent.

---

## 6. Status-TBD Items (Needs an Owner Decision: V1 or V2)

These are explicitly *not* bucketed as V1 or V2 yet — flagging them here so
they get a deliberate decision instead of silently defaulting to either.

- **Desktop packaging story**: this was originally scoped (v1-roadmap Theme 6
  / task D3) against an old web/PWA deployment model — a launcher script,
  `navigator.storage.persist()`, dev-server port pinning against
  origin-keyed browser storage, and a PWA manifest. None of that applies
  anymore: the app is a real Tauri desktop build with native SQLite
  storage, not a browser-hosted PWA. The actual open question now is
  installer/distribution format (how a desktop build reaches a user, vs.
  Android's sideload-an-APK flow) — already tracked as its own item, see
  §5's "Desktop packaging/distribution format" entry; not duplicated here.
- **Rotating Android auto-export**: a once-daily auto-export, keeping the
  last 3 snapshots, via `@tauri-apps/plugin-fs` (not currently integrated for
  this purpose — only used today for the manual Export/Import file I/O, see
  `src/shared/file-download.ts`). Scaffolding-adjacent work exists (manual
  Export/Import), but the automatic rotating version was never built.
- **On-device restore test**: an actual uninstall/reinstall test of
  Android's `allowBackup` auto-backup restore path has never been run on
  real hardware (only doable on a real device, not in this environment).
  The `allowBackup` stance itself was decided (kept on, treated as a
  supplementary net on top of manual Export), but whether it actually
  restores a sideloaded app's DB is unverified.
- **Gigantamax availability/shiny gating**: all 32 canonical G-max species
  are currently marked available (shiny included) in reference data, but
  GO's real in-game rollout since late 2024 is a subset, and shiny G-max is
  event-gated per species. This is a data-pass issue, not a code change.
  **Note**: this is only about the gating/availability data — the
  *architecture* decision to model Gigantamax as ordinary form rows (not a
  separate personal field) is already settled and unaffected.

---

## 7. Carried Forward from Deleted `docs/features/` Files

These lived in `docs/features/next.md` and `docs/features/planned.md`,
deleted by the same restructure as `v1-tasks`/`v1-roadmap` but missed by the
first recovery pass since they weren't part of that sweep. Recovered
2026-07-16 so nothing already-decided gets silently lost.

- **Quarantine visibility** (deferred past V1 — not building for the tag):
  `personal_data_quarantine` is currently invisible — a reference-sync that
  drops a slug still referenced by personal data lands the orphaned row
  here, but nothing in the app surfaces it; a dev would have to inspect the
  raw SQLite file. Decided design, scoped small on purpose: a status line at
  the top of the Settings page, always visible ("0 import data issues
  found"), rendered bold with the real count when non-zero, plus an export
  button (send the result back to the owner) that only makes sense to
  show/enable when the count is non-zero. No popup/modal, no dismiss-state,
  no new personal-data schema — deliberately rejected as over-building for
  how rare this should be with a small, personally-onboarded initial user
  group. Needs: a repository read method for the count (none exists yet),
  and a dedicated export function, since `personal_data_quarantine` isn't
  part of the existing `PersonalDataExport` shape. Owner call 2026-07-15:
  real risk if it ever fires, but not worth building before the v1.0.0 tag —
  revisit post-V1.
- **Unify Dex-grid and form-tile rendering into a shared component**:
  owner-proposed 2026-07-14. The Dex grid's `.species-tile`/`.species-sprite`
  (`species-grid.ts`) and Bulk Edit/species-detail's `.form-tile`/
  `.form-tile-sprite` (`bulk-form-edit.ts`, `species-detail.ts`) are two
  independent implementations of what is visually the same kind of tile —
  sprite + overlay badges + a label box underneath. A 2026-07-14 tile-sizing
  pass (matching column widths and sprite-fill behavior across both) had to
  apply the same CSS values twice in two places, and any future tile-visual
  change will keep needing to be made twice unless refactored onto one
  shared rendering/CSS codebase. Not designed yet — just flagging the
  duplication before a third tile variant makes it worse.
- **Consolidate Dex grid and Bulk Edit into one page, toggled**:
  owner-proposed 2026-07-15, prompted by noticing similar logic between the
  Dex grid and Bulk Edit while the Caught/Uncaught bug fix (#33) was in
  flight — related to, but distinct from, the tile-rendering duplication
  item above. Idea: instead of two separate pages/routes for browsing (Dex
  grid) and editing (Bulk Edit), collapse them into a single page with a
  toggle to swap between "browse" and "edit" modes over the same underlying
  data/filter state. Not designed — no toggle UX, no decision on what
  search/filter state should or shouldn't carry across the toggle, no
  confirmation the two pages' data-fetching actually share enough to make
  this cheap rather than just visually tidier. Bigger and riskier than the
  logic-level tile unification above (merging two pages' UI/routing, not
  just deduplicating a shared helper), so it stays deferred past V1
  regardless of what any future investigation into the species-vs-form
  logic finds.
- **Open item carried forward**: whether `form_background_personal`
  assuming every background is possible on every form (rather than modeling
  real legality) causes any actual UI problems worth revisiting later —
  cross-reference: this document's own "Background Legality" item in §1
  already tracks the fix itself; this note is the original open question
  behind it.

---

## 8. Deferred Onboarding Material

- **In-person onboarding script for desktop-uncomfortable friends**:
  previously tracked as "write a live-walkthrough script." A short
  checklist to run through in person with friends who won't self-serve from
  `docs/install-guide.md` — distinct from that doc, which is written for
  someone reading it alone. Not written yet; not blocking the v1.0.0 tag,
  since the owner can currently walk people through it from memory. Moved
  here 2026-07-16 as a later-not-never item rather than an open dossier
  task.
