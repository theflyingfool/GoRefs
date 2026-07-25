# GoBuddy Source Code Comments Audit

> [!WARNING]
> **Stale as of the Capacitor → Tauri migration (Sub-project 6).** This is a
> point-in-time audit snapshot, not a living document. Its descriptions of
> `sqlite-client.ts` (native vs. web/jeep-sqlite+sql.js split) and
> `file-download.ts` (Capacitor Android share-sheet path) refer to code that
> has since been rewritten for Tauri, and the jeep-sqlite/sql.js layers it
> describes were deleted entirely. Read this file for historical context
> only; it was not updated to match the current source.

> [!NOTE]
> This audit reviews all source code comments in the `GoBuddy` codebase across `src`, `test`, `e2e`, and `scripts` directories. Out of **320 total comments**, **303 comments** represent critical design rationale and are recommended to be kept. **17 comments** contain historical git-level tracking context (PRs, dates, resolved issues) or references to since-deleted components and are recommended for updates.

## Summary of Categories

| Category | Count | Action | Recommendation |
| --- | --- | --- | --- |
| **Architectural Decision / Important Rationale** | 303 | **Keep** | Retain these comments as they detail non-obvious engineering decisions, platform-specific workarounds (e.g., native SQLite WebView locks, download picker AbortErrors), and database constraints. |
| **Outdated Implementation Note** | 17 | **Update** | Modify comments to remove references to historical task files (`TODO.md`, `TODO`), specific PR numbers, commit dates, or since-deleted systems. |
| **Historical Context already in Git** | 0 | **Remove** | No comment blocks should be fully removed. Rationale is embedded alongside history; updates to prune the history are preferred. |
| **Unclear / Ambiguous** | 0 | **Flag** | None. All audited comments are clear and technical. |

## Outdated Comments Requiring Updates

The following 17 comments contain references to development tasks (`TODO.md`), PRs, dates, or defunct code layers. They should be pruned to keep the codebase clean.

### 1. [cascades.ts:L22-31](file:///home/nick/Repos/GoBuddy/src/db/cascades.ts#L22-L31)
- **File Path:** [src/db/cascades.ts](file:///home/nick/Repos/GoBuddy/src/db/cascades.ts)
- **Recommendation:** Remove the debugging history detail: `(found via a failing unit test, 2026-07-14): checking Shiny/Floor/FourStar/Shundo there never actually cascaded to Caught in production, for any user, ever.`.

```typescript
// The base field is always listed first per section (caught/lucky/shadow/
// dynamax/luckyDynamax); the other four vary in listed order between
// sections (e.g. Dynamax lists floor before shiny, unlike Standard/Lucky/
// Shadow), so match the shiny/floor/fourStar/shundo-equivalents by name
// suffix rather than assuming a fixed position. Case-insensitive because
// Standard's own fields are the bare, unprefixed names ("shiny", not
// "standardShiny") — a case-sensitive endsWith("Shiny") silently matched
// nothing for the entire Standard section (found via a failing unit
// test, 2026-07-14): checking Shiny/Floor/FourStar/Shundo there never
// actually cascaded to Caught in production, for any user, ever.
```

---

### 2. [cascades.ts:L47-50](file:///home/nick/Repos/GoBuddy/src/db/cascades.ts#L47-L50)
- **File Path:** [src/db/cascades.ts](file:///home/nick/Repos/GoBuddy/src/db/cascades.ts)
- **Recommendation:** Remove date and file references: `(owner-specced, docs/issues.md, 2026-07-14)`.

```typescript
// Cross-section cascades (owner-specced, docs/issues.md, 2026-07-14). The
// loop above only ever cascades a section up to *its own* base — these
// bridge across sections, which the loop structurally can't do since it
// only ever sees one group at a time.
```

---

### 3. [in-memory-store.ts:L1-11](file:///home/nick/Repos/GoBuddy/src/data/in-memory-store.ts#L1-L11)
- **File Path:** [src/data/in-memory-store.ts](file:///home/nick/Repos/GoBuddy/src/data/in-memory-store.ts)
- **Recommendation:** Remove references to the deleted localStorage-backed dummy repository and task list: `This module used to also carry an equivalent plain-JS implementation for a since-deleted localStorage-backed dummy repository; see docs/v1-tasks/06-performance-and-quality-infra.md.`.

```typescript
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
// repository; see docs/v1-tasks/06-performance-and-quality-infra.md.
```

---

### 4. [in-memory-store.ts:L180-187](file:///home/nick/Repos/GoBuddy/src/data/in-memory-store.ts#L180-L187)
- **File Path:** [src/data/in-memory-store.ts](file:///home/nick/Repos/GoBuddy/src/data/in-memory-store.ts)
- **Recommendation:** Update statement referring to the bulk-edit feature: change `so a future bulk-edit feature can call this...` to reflect that it is currently used by the bulk-edit feature.

```typescript
// Reusable merge step: given the current record and one field being set,
// returns the record with that field applied PLUS every field its cascade
// implies (transitively — see resolveFormFieldCascade), all merged into a
// single object. Pure/no side effects, so a future bulk-edit feature can
// call this once per row and batch the writes, rather than duplicating the
// cascade-resolution logic. Only `true`-valued boolean fields cascade —
// unchecking (false) and non-boolean fields (bestShiny/etc.) pass through
// unchanged, per the forward-only cascade rule.
```

---

### 5. [indicator-labels.ts:L59-62](file:///home/nick/Repos/GoBuddy/src/features/data-entry/indicator-labels.ts#L59-L62)
- **File Path:** [src/features/data-entry/indicator-labels.ts](file:///home/nick/Repos/GoBuddy/src/features/data-entry/indicator-labels.ts)
- **Recommendation:** Remove historical labeling mention: `it used to share a "Dynamax" label with`.

```typescript
// Reference-data availability ("can this ever be Mega Evolved/Dynamaxed/
// Gigantamaxed") — grouped with rarity below as "species classification",
// not mixed into the achievement filter list it used to share a "Dynamax"
// label with.
```

---

### 6. [species-grid.ts:L119-123](file:///home/nick/Repos/GoBuddy/src/features/data-entry/species-grid.ts#L119-L123)
- **File Path:** [src/features/data-entry/species-grid.ts](file:///home/nick/Repos/GoBuddy/src/features/data-entry/species-grid.ts)
- **Recommendation:** Remove historical mention of inline grid filters: `Filter content used to live inline at the top of the grid;`.

```typescript
// Filter content used to live inline at the top of the grid; it's now the
// contents of the callable filter sheet/panel (rendered into a container
// that lives outside the grid's own `clear()` cycle, so opening/closing it
// doesn't fight the grid's rerenders). Select-mode + the bulk bar stay on
// the grid page itself — they're a selection tool, not a filter.
```

---

### 7. [bulk-form-edit.ts:L257-268](file:///home/nick/Repos/GoBuddy/src/features/data-entry/bulk-form-edit.ts#L257-L268)
- **File Path:** [src/features/data-entry/bulk-form-edit.ts](file:///home/nick/Repos/GoBuddy/src/features/data-entry/bulk-form-edit.ts)
- **Recommendation:** Remove PR reference: `(same class of bug as the "!costume" search above and the field-filter bug fixed in PR #32)`.

```typescript
// Repository.listSpeciesSummaries's "caught" filter means
// personal.registered — species-wide "you've registered at least one
// form" (see SpeciesSummary's doc comment in repository.ts), not this
// specific form's own caught state. That's correct for the Dex grid
// (species-level tiles), but Bulk Edit's tiles are per-form: passing
// state.caught through here would filter at the wrong granularity
// (same class of bug as the "!costume" search above and the field-filter
// bug fixed in PR #32) — e.g. "Caught" would show every form of any
// registered species, including forms that individually aren't caught,
// and "Uncaught" would hide a genuinely-uncaught form whose species is
// registered because a *different* form was caught. Always query "all"
// here and apply the real per-form caught check below instead.
```

---

### 8. [personal-data-transfer.ts:L1-7](file:///home/nick/Repos/GoBuddy/src/features/settings/personal-data-transfer.ts#L1-L7)
- **File Path:** [src/features/settings/personal-data-transfer.ts](file:///home/nick/Repos/GoBuddy/src/features/settings/personal-data-transfer.ts)
- **Recommendation:** Remove the developer plan reference: `(see TODO.md / the plan that added this)`.

```typescript
// Manual cross-device transfer of personal data (see TODO.md / the plan that
// added this) — deliberately not a live sync. Export writes a file the user
// places wherever they like (Drive, email, USB — the app never talks to any
// cloud service directly); import reads one back in. The platform-specific
// file I/O is shared (src/shared/file-download.ts); the format itself comes
// from Repository.exportPersonalData/importPersonalData, defined once in
// src/data/in-memory-store.ts so both backends get it for free.
```

---

### 9. [stats-page.ts:L12-15](file:///home/nick/Repos/GoBuddy/src/features/stats/stats-page.ts#L12-L15)
- **File Path:** [src/features/stats/stats-page.ts](file:///home/nick/Repos/GoBuddy/src/features/stats/stats-page.ts)
- **Recommendation:** Remove the historical details about the V1 cap removal: `Bulk Edit's equivalent cap was removed in v1 (owner call: show everything there, however large), but Stats' drill-down list keeps this one for now.` -> simplify to: `Stats' drill-down list retains this display guard to prevent rendering unusably long/slow grids.`.

```typescript
// A "missing" drill-down can be hundreds of species (e.g. "Shiny" globally) —
// showing every tile would be unusably long/slow. Display-only guard; Bulk
// Edit's equivalent cap was removed in v1 (owner call: show everything there,
// however large), but Stats' drill-down list keeps this one for now.
```

---

### 10. [write-failure-banner.ts:L1-5](file:///home/nick/Repos/GoBuddy/src/app-shell/write-failure-banner.ts#L1-L5)
- **File Path:** [src/app-shell/write-failure-banner.ts](file:///home/nick/Repos/GoBuddy/src/app-shell/write-failure-banner.ts)
- **Recommendation:** Remove historical console-only details: `— previously only console.error'd, so a write could silently fail to persist while the UI (reading from the in-memory cache) looked fine.`.

```typescript
// Persistent banner for a failed SQLite write-through (see
// src/data/sqlite-repository.ts's enqueueWrite) — previously only
// console.error'd, so a write could silently fail to persist while the UI
// (reading from the in-memory cache) looked fine. Mounted once at boot;
// shown/updated by report(), hidden again once a retry actually succeeds.
```

---

### 11. [file-download.ts:L1-17](file:///home/nick/Repos/GoBuddy/src/shared/file-download.ts#L1-L17)
- **File Path:** [src/shared/file-download.ts](file:///home/nick/Repos/GoBuddy/src/shared/file-download.ts)
- **Recommendation:** Remove file lineage details: `Originally lived only in personal-data-transfer.ts; extracted so Coverage Report's CSV export can reuse the exact same mechanism instead of re-implementing it.`.

```typescript
// Generic "hand the user a file" flow, shared by any feature that needs to
// let the user save a file for later use outside the app (Settings' personal
// data export, Coverage Report's per-gap CSV export). Two paths depending on
// platform:
// - Web: Blob + `<a download>`, straight to the browser's Downloads folder.
// Used to try `showSaveFilePicker` first for a real save-location dialog,
// but on some setups (observed on Linux/Chromium — likely a desktop-portal
// issue) the picker never opens and immediately rejects with `AbortError`,
// which is indistinguishable from a genuine user-cancel — every web export
// silently "failed" as "Cancelled." with no dialog ever shown. Not worth
// chasing per-environment: the plain download always works.
// - Native (Capacitor Android): write to the cache dir, then hand off to the
// native share sheet ("Save to Drive", email, etc. — the app never talks
// to any cloud service directly).
// Originally lived only in personal-data-transfer.ts; extracted so
// Coverage Report's CSV export can reuse the exact same mechanism instead of
// re-implementing it.
```

---

### 12. [gap-detection.ts:L1-15](file:///home/nick/Repos/GoBuddy/scripts/ingest/gap-detection.ts#L1-L15)
- **File Path:** [scripts/ingest/gap-detection.ts](file:///home/nick/Repos/GoBuddy/scripts/ingest/gap-detection.ts)
- **Recommendation:** Remove obsolete reference to V1 task list: `(see TODO.md's "Coverage Report was stale" entry — this closes that standing gap for the stateless kinds below)`.

```typescript
// Gap checks that are purely a function of the CURRENT reference.json
// contents — no PokeAPI fetch, no Forms-CSV skeleton, no Bulbapedia
// wikitext needed to (re)derive them. build-reference.ts calls these once
// at the end of a full ingest; csv-authoring.ts's `import` command calls
// them again after every manual CSV fix, so a gap a human just fixed by
// hand stops showing up in the Coverage Report without needing a full
// `npm run ingest:build` re-run (see TODO.md's "Coverage Report was stale"
// entry — this closes that standing gap for the stateless kinds below).
// 
// Other ReferenceGap kinds (mega-discrepancy, possible-bogus-form,
// guessed-costume-name) depend on external sources reference.json doesn't
// carry (PokeAPI's mega varieties, the Forms CSV's raw tokens, Bulbapedia's
// sprite codes) — those are NOT recomputed here, and are left untouched by
// csv-authoring.ts; only re-running the script that originally produced
// them can refresh those entries.
```

---

### 13. [parse-event-pokemon.ts:L1-45](file:///home/nick/Repos/GoBuddy/scripts/ingest/parse-event-pokemon.ts#L1-L45)
- **File Path:** [scripts/ingest/parse-event-pokemon.ts](file:///home/nick/Repos/GoBuddy/scripts/ingest/parse-event-pokemon.ts)
- **Recommendation:** Update historical sentence `as of this writing, src/data/reference.json has zero forms with a costumeName set at all — costumes were never modeled...` to reflect that costumes are now supported.

```typescript
// Parses Bulbapedia's "Event Pokémon (GO)" article into costume `form` rows.
// 
// This is a genuinely new data source, not a cross-check of an existing one:
// as of this writing, src/data/reference.json has zero forms with a
// costumeName set at all — costumes were never modeled by the Forms-CSV/
// PokeAPI pipeline (that pipeline only knows about regional variants,
// letters, and other "form" tokens, never event costumes).
// 
// Source file: scripts/ingest/sources/event-pokemon-go.wikitext — a raw
// wikitext snapshot, fetched via:
// curl 'https://bulbapedia.bulbagarden.net/w/index.php?title=Event_Pok%C3%A9mon_(GO)&action=raw'
// Committed so ingestion is reproducible without a live fetch; re-fetch and
// overwrite it to pick up new costumes later.
// 
// The article's table groups rows under a shared "Form" column (rowspan),
// e.g. every Festive-hat Pichu/Pikachu/Raichu row shares one "Festive hat"
// label. Columns: Form | Pokémon (directly obtainable) | Evolution only
// (only reachable by evolving a costumed pre-evolution) | Availability
// (bulleted event history, {{Shinystar/GO}} marking a shiny-possible event).
// 
// Output is the same CSV shape `csv-authoring.ts` reads, so costumes get
// reviewed/merged through the existing authoring workflow rather than a
// bespoke merge path:
// npm run ingest:events
// npm run ingest:csv:import -- data-authoring/event-pokemon.csv
// 
// Known simplifications (flagged to stdout, not silently assumed correct):
// - Shiny availability is tracked per **row**, not per bullet: if any event
// bullet in a row's Availability cell mentions Shinystar/GO, every species
// in that row (direct + evolution-only) is marked shinyAvailable. Some
// rows restrict a specific bullet to one species via a "** X only"
// sub-note — those nuances are not parsed; the row-level OR is a
// deliberate over-approximation, consistent with the "Shiny available at
// all" boolean the schema actually stores (not "since which event").
// - `evolves` for a directly-caught species is true iff its row lists any
// evolution-only species; evolution-only species themselves are always
// marked non-evolving (doesn't handle 3-stage chains where the middle
// stage can still evolve further in costume) — flagged per-species below.
// - A handful of species get the *same* Form label across multiple rows in
// the source (e.g. Cosplay Pikachu's Libre/Rock Star/Pop Star/Ph.D. rows
// all say "Cosplay Pikachu") — these would collide on one form slug, so a
// suffix is derived from Bulbapedia's own MSP sprite code. Two codes are
// already known (Cosplay Pikachu, Pumpkaboo/Gourgeist size); anything else
// falls back to the raw code and is flagged for a human to give it a
// proper name.
```

---

### 14. [build-reference.ts:L75-83](file:///home/nick/Repos/GoBuddy/scripts/ingest/build-reference.ts#L75-L83)
- **File Path:** [scripts/ingest/build-reference.ts](file:///home/nick/Repos/GoBuddy/scripts/ingest/build-reference.ts)
- **Recommendation:** Remove historical trace: `previously never got a match attempt at all — guessVarietyName only recognizes the four regional prefixes, so anything else fell straight through to a "missing-types" gap.`.

```typescript
// Non-regional form tokens (letters, formes like Deoxys' Attack/Defense/
// Speed or Rotom's Heat/Wash, Alcremie flavors, ...) previously never got a
// match attempt at all — guessVarietyName only recognizes the four regional
// prefixes, so anything else fell straight through to a "missing-types" gap.
// PokeAPI's own variety names for these are near-always
// "${species}-${slugified-token}", but not always a byte-for-byte match —
// e.g. the Forms CSV's "Sandy Cloak" token slugifies to "sandy-cloak" while
// PokeAPI's actual variety is just "wormadam-sandy". Match bidirectionally:
// either the token or the variety's own suffix may be a prefix of the other.
```

---

### 15. [build-reference.ts:L239-257](file:///home/nick/Repos/GoBuddy/scripts/ingest/build-reference.ts#L239-L257)
- **File Path:** [scripts/ingest/build-reference.ts](file:///home/nick/Repos/GoBuddy/scripts/ingest/build-reference.ts)
- **Recommendation:** Prune metadata comments such as `this used to require` and `contrary to an earlier version of this comment` to make the explanation direct.

```typescript
// Mega variants: the GO tracker (Forms CSV)'s per-species Mega column is
// the source of truth for whether a species has one at all — Pokémon
// GO's Mega roster is Niantic's own release schedule, which can (and
// does) run ahead of or diverge from the mainline games PokeAPI mirrors.
// A version_group allowlist here (this used to require "x-y" or
// "omega-ruby-alpha-sapphire") silently rejects every GO-exclusive Mega
// release, since those can never belong to a mainline version group —
// confirmed wrong for Dragonite/Skarmory/Raichu/Malamar/Victreebel/
// Falinks, all real in GO despite PokeAPI only ever tagging their mega
// varieties under its "Mega Dimension" pack — which, contrary to an
// earlier version of this comment, is the **official Pokémon Legends:
// Z-A DLC** (~21 new megas), not fan content. So: once the tracker says
// yes, use PokeAPI's variety list (whatever pack it's tagged under)
// purely to figure out the variant *shape* (plain/X/Y/Primal) — still
// gated behind the tracker flag, since not every Mega Dimension entry
// has actually reached GO yet. Owner-confirmed (2026-07-10) still-bogus
// despite Mega Dimension listing them: Uxie, Mesprit, Azelf, Butterfree,
// Lugia — re-verify against a real Z-A mega list before trusting any of
// these again, per docs/v1-roadmap/02-reference-data-corrections.md §6.
```

---

### 16. [build-sprite-mapping.ts:L1-24](file:///home/nick/Repos/GoBuddy/scripts/ingest/build-sprite-mapping.ts#L1-L24)
- **File Path:** [scripts/ingest/build-sprite-mapping.ts](file:///home/nick/Repos/GoBuddy/scripts/ingest/build-sprite-mapping.ts)
- **Recommendation:** Remove references to development task items, reviewer feedback (`loop the reviewer asked for`), and local file triaging.

```typescript
// Bootstraps the §7 image pipeline (docs/v1-tasks/05-image-pipeline.md) from
// PokeMiners/pogo_assets's "Addressable Assets" icon set — a human-readable
// naming convention (pm{dex}.f{FORM}.c{COSTUME}.g{gender}.s.icon.png) rather
// than the opaque numeric form/costume IDs the task doc originally expected,
// discovered while triaging this task. Deliberately conservative: only ships
// art this script can match with real confidence (species base icons; a
// small whitelist of unambiguous regional/Mega/Gigantamax form tokens;
// costumes previously confirmed via costume-lookup.json; gender-tagged
// files — see below). Everything else — every unwhitelisted/ambiguous form
// token (Unown's bare letters collide with Mewtwo's "A" = Armored,
// Deoxys/Rotom/Vivillon/Burmy multiforms, etc.) — goes to a scratch-dir CSV
// for hand review instead of being guessed.
// 
// Gender tag convention (owner-confirmed, and independently verified against
// the dump — every .g file found is .g2, .g1 never appears): the untagged
// file already serves as the "male" (or only/unknown-gender) art; .g2 is
// specifically the "female" variant. `parsed` is processed male-first
// (see the sort below) so a later .g2 match can correct a slug a male-first
// pass provisionally filled in, rather than racily depending on directory
// order.
// 
// Re-run after adding entries to costume-lookup.json (committed, starts
// empty) to auto-match previously-unresolved costumes — this is the
// "only ever check new things" loop the reviewer asked for.
```

---

### 17. [csv-authoring.ts:L206-220](file:///home/nick/Repos/GoBuddy/scripts/ingest/csv-authoring.ts#L206-L220)
- **File Path:** [scripts/ingest/csv-authoring.ts](file:///home/nick/Repos/GoBuddy/scripts/ingest/csv-authoring.ts)
- **Recommendation:** Remove development TODO log mention: `(see TODO.md's "Coverage Report was stale" entry)`.

```typescript
// Keep the Coverage Report in sync: without this, a gap a human just fixed
// by hand via this exact CSV round-trip would keep showing up until the
// next full `npm run ingest:build` (see TODO.md's "Coverage Report was
// stale" entry). Only the stateless gap kinds (derivable purely from
// reference.json — see gap-detection.ts) can be refreshed here; kinds that
// depend on PokeAPI/the Forms CSV/Bulbapedia are left as whatever the last
// full build or event-parse run recorded.
// 
// Scoped to the species/forms this import actually touched, not a full
// recompute over the whole dataset: several forms elsewhere in
// reference.json carry a "missing-types" gap for a placeholder types list
// that's non-empty (just wrong) — see gap-detection.ts's header comment —
// so a dataset-wide recompute would silently drop those still-unresolved
// gaps just because an unrelated row got imported. Only entries for rows
// this run actually reviewed are safe to replace.
```

---

## Sample of Critical Architectural Rationale (To Keep)

These comments explain vital platform workarounds, performance guarantees, and database constraints. They are key to preventing regression bugs.

### [sqlite-client.ts:L1-20](file:///home/nick/Repos/GoBuddy/src/db/sqlite-client.ts#L1-L20) — *Native vs Web SQLite Client & jeep-sqlite/IndexedDB persistence model.*
```typescript
// Bootstraps the real @capacitor-community/sqlite connection. On native
// Android (milestone D: `android/`, added via `npx cap add android`), the
// plugin talks straight to real on-device SQLite — no extra setup needed. On
// Web (no native project, or just running `npm run dev`), the same plugin
// instead runs its Web implementation: jeep-sqlite, backed by sql.js +
// IndexedDB via localforage — a genuine, persistent SQLite database, just
// running in the browser. Every call in this module is guarded by
// `Capacitor.getPlatform()` so the jeep-sqlite/sql.js setup only ever runs on
// Web; getDb()/persistDb()'s callers (src/data/sqlite-repository.ts) don't
// need to know or care which platform they're on.
// 
// package.json pins `sql.js` to exactly 1.11.0, not a caret range: jeep-sqlite
// vendors its own compiled sql.js glue JS (matching the ~1.11 line it was
// built against), and the plain sql-wasm.wasm binary this repo copies into
// public/assets/ has to match that glue's WASM ABI. Confirmed the hard way —
// sql.js 1.14.1's wasm binary against jeep-sqlite's glue throws
// "WebAssembly.instantiate(): ... function import requires a callable" and
// the app never gets past "Loading your dex…". Don't bump sql.js without
// re-verifying the app still boots. This only matters on Web — native builds
// never touch sql.js/jeep-sqlite at all.
```

### [reference-sync.ts:L84-92](file:///home/nick/Repos/GoBuddy/src/db/reference-sync.ts#L84-L92) — *Deferred Foreign Key enforcement to COMMIT during reference synchronization.*
```typescript
// Defer foreign-key enforcement to COMMIT. Personal tables
// (species_personal, form_personal, …) hold FKs into the reference
// tables we're about to drop/recreate; without deferral, the implicit
// row-delete of a DROP TABLE (or a DELETE FROM) trips "FOREIGN KEY
// constraint failed" the moment any personal data references a reference
// row — which is every returning user the first time an app update
// changes reference.json. Because we re-insert the same slugs below, the
// constraints are satisfied again by commit time. Resets automatically
// at the end of the transaction.
```

### [settings-page.ts:L187-194](file:///home/nick/Repos/GoBuddy/src/features/settings/settings-page.ts#L187-L194) — *Workaround for WebView reload and open SQLite connection lock on Native Android.*
```typescript
// No page reload: importPersonalData already mutates the live
// in-memory cache every read in this session goes through, so nothing
// needs a fresh boot to see the new data. This used to reload here,
// which on-device (capacitor-community/sqlite on native Android) hit
// "Couldn't open the on-device database" — the plugin's native
// connection registry survives a WebView reload, so the fresh boot's
// getDb() found the old connection still marked open and calling
// .open() on it again failed. See src/db/sqlite-client.ts.
```

### [file-download.ts:L1-17](file:///home/nick/Repos/GoBuddy/src/shared/file-download.ts#L1-L17) — *Fallback from `showSaveFilePicker` (fails in Linux Chromium) to plain anchor downloads.*
```typescript
// Generic "hand the user a file" flow, shared by any feature that needs to
// let the user save a file for later use outside the app (Settings' personal
// data export, Coverage Report's per-gap CSV export). Two paths depending on
// platform:
// - Web: Blob + `<a download>`, straight to the browser's Downloads folder.
// Used to try `showSaveFilePicker` first for a real save-location dialog,
// but on some setups (observed on Linux/Chromium — likely a desktop-portal
// issue) the picker never opens and immediately rejects with `AbortError`,
// which is indistinguishable from a genuine user-cancel — every web export
// silently "failed" as "Cancelled." with no dialog ever shown. Not worth
// chasing per-environment: the plain download always works.
// - Native (Capacitor Android): write to the cache dir, then hand off to the
// native share sheet ("Save to Drive", email, etc. — the app never talks
// to any cloud service directly).
// Originally lived only in personal-data-transfer.ts; extracted so
// Coverage Report's CSV export can reuse the exact same mechanism instead of
// re-implementing it.
```

### [sqlite-repository.ts:L126-134](file:///home/nick/Repos/GoBuddy/src/data/sqlite-repository.ts#L126-L134) — *Bulk operation transaction & persist suppression pipeline.*
```typescript
// When > 0, a bulk operation is in flight (see runBulk below). The
// personal-changed hooks below fire synchronously — one per row — while the
// in-memory bulk method loops, so each reads this flag at enqueue time and,
// if inside a bulk, (a) skips its own per-statement transaction (runBulk
// wraps the whole batch in ONE explicit transaction instead — and the
// plugin's default per-statement BEGIN would error nested inside that) and
// (b) skips its per-row persistDb, leaving runBulk to do a single flush at
// the end. Outside a bulk, behavior is unchanged: per-statement transaction
// + a persist flush per edit.
```

