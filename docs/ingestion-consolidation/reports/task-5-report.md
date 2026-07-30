# Task 5 report: shiny schema extension

## What was implemented

Added a real, permanent `shiny_released_at TEXT` column to the `form`
reference table (ISO date `YYYY-MM-DD`, `NULL` = never released), and wired
the shiny-sheet `debut` date that Task 3 already carried through in the
`FormWithShinyDebut` intermediate shape all the way into the schema, the
sync insert, and the bundled-JSON write path. `shinyAvailable` is unchanged
in shape and semantics — still a plain boolean column, still derived
(`shinyReleasedAt !== null`), never independently set.

Files changed:
- `src/db/types.ts` — `Form.shinyReleasedAt: string | null` added, next to
  `shinyAvailable`.
- `src/db/schema.ts` (`REFERENCE_SCHEMA_SQL`, the DDL `reference-sync.ts`
  actually executes) — `shiny_released_at TEXT` added to the `form` table,
  nullable, no `CHECK`/`NOT NULL` (unlike the boolean columns).
- `src/db/schema/reference.ts` (Drizzle's typed-query-only schema, **not**
  part of `drizzle.config.ts`'s migration path — confirmed, see below) —
  `shinyReleasedAt: text("shiny_released_at")` added to the `form` table so
  `reference-sync.ts`'s typed insert compiles.
- `src/db/reference-sync.ts` — `form` insert mapping now includes
  `shinyReleasedAt: f.shinyReleasedAt ?? null`. The `?? null` isn't fixing a
  crash (verified drizzle already binds an `undefined` field value to SQL
  `NULL` — a test with the key deleted entirely from the object passes
  either way); it makes the "absent/undefined key means never released"
  contract explicit rather than relying on drizzle's undefined-handling as
  an implicit behavior, and matters concretely today because the *committed*
  `src/data/reference.json` on this branch predates this field (see
  Concerns).
- `scripts/ingest/ingest.ts` — the `Form[]` mapping in `build()` now carries
  `shinyReleasedAt: f.shinyReleasedAt` through instead of dropping it (the
  stale comment explaining the drop was removed).
- `scripts/ingest/transform/species.ts` — no build-logic change (Task 3 was
  right: nothing needed populating, it already flowed `standardShinyDebut` /
  `costumeDebut` / `regionDebut` / `gmaxDebut` into `shinyReleasedAt` on
  every form literal). `FormWithShinyDebut` is now `type FormWithShinyDebut
  = Form` (was `interface ... extends Form { shinyReleasedAt }`) since `Form`
  itself carries the field now; kept as a type alias rather than deleting it
  outright so the 4 in-file call sites and its exported name don't need to
  change, with an updated header comment explaining it's now vacuous-by-name
  only.
- `src/db/reference-data.ts` — **not touched**. `ReferenceData.forms: Form[]`
  already picks up the new field transitively through `Form`; there's no
  separate/duplicated Form-shaped literal in that file to update.
- Four existing test fixtures (`test/create-pokemon-instances-dex-sync.test.ts`,
  `test/dex-achievement-backfill.test.ts` (2 forms),
  `test/export-import-round-trip.test.ts`, `test/reference-sync.test.ts`'s
  `fixture()`) updated to satisfy the now-required `Form.shinyReleasedAt`
  field — `tsc --noEmit` caught all of these as compile errors before any
  test run was needed.

## `shinyAvailable`: kept, unchanged

Grepped every call site (`src/data/reference-csv-format.ts`,
`scripts/build-dummy-db.ts`, `src/db/reference-sync.ts`,
`scripts/ingest/ingest.ts`, `scripts/ingest/transform/species.ts`, plus test
fixtures) before deciding. All of them read/write `shinyAvailable` as a
plain boolean and none reference a debut date today — replacing it with a
derived getter or removing it would touch every one of those sites for no
functional gain, and the brief explicitly allows keeping both. Task 3 had
already established the derivation invariant
(`shinyAvailable === (shinyReleasedAt !== null)`) and pinned it with a test
(`test/transform-species.test.ts:39-42`); this task didn't need to add
anything to protect that invariant, just stop dropping the second field.

## Migration question: no migration file needed — confirmed

`drizzle.config.ts`:
```ts
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/personal.ts",
  out: "./src/db/migrations",
});
```
`schema` points only at `./src/db/schema/personal.ts` — `drizzle-kit
generate` never sees `src/db/schema/reference.ts` (the file I edited for
typed queries) and can't diff it. `src/db/schema/reference.ts` also states
this explicitly in its own header comment ("Deliberately NOT part of
drizzle.config.ts's schema path: these tables are wholesale
dropped/recreated by src/db/reference-sync.ts on every reference-data
update, never incrementally migrated, so drizzle-kit must never diff or
generate migrations for them"). Two independent, consistent sources — no
migration file was generated or needed.

Mechanically, `reference-sync.ts`'s `syncReferenceData` (lines ~124-209)
confirms the "how" too: it runs `CREATE TABLE IF NOT EXISTS` unconditionally
on every boot (a no-op against an already-created table on any device — the
new column would **not** silently backfill onto an existing DB this way),
then, only if the content-hash version differs from what's stored, drops
`form` (and every other reference table, in FK-safe order) and recreates
all of them from the now-updated `REFERENCE_SCHEMA_SQL`, which is where
`shiny_released_at` actually lands on an existing install. That version
check is why this task's DDL change is inert on its own: `REFERENCE_DATA_VERSION`
(`src/data/reference-version.ts`) is a content hash of `src/data/reference.json`,
auto-generated by `scripts/ingest/write/reference-json.ts` during a real
`npm run ingest` run — not something this task hand-bumps. See Concerns for
what that means about the current state of this branch.

## Testing

`test/reference-sync.test.ts` gained three new tests (all against a real
`:memory:` `DatabaseSync`, real migrations, real `syncReferenceData` — no
mocks):
1. **Round-trip, including null.** A fixture with one form dated
   `"2018-03-25"` plus a second form with `shinyReleasedAt: null` (no
   shiny-sheet match) syncs through and both values read back correctly via
   `SELECT slug, shiny_released_at FROM form`.
2. **Missing key (the real `reference.json` shape today).** Deletes the
   `shinyReleasedAt` key from a form object entirely (not just sets it to
   `null`) before passing it to `syncReferenceData`, simulating exactly what
   `sqlite-repository.ts`'s `referenceDataJson as unknown as ReferenceData`
   double-cast lets through unchecked at runtime today. Asserts it persists
   as SQL `NULL`, not a crash.
3. Existing round-trip/no-op/quarantine tests updated for the new required
   field, otherwise unchanged.

Also verified by temporarily reverting the `?? null` normalization and
re-running: both new tests still passed, confirming drizzle already handles
`undefined` safely — so the `?? null` is explicitness, not a bug fix. Put
it back afterward.

`npx tsc --noEmit -p tsconfig.json`: clean. `npm test`: **211/211 pass**
(209 before this task's changes; `reference-sync.test.ts` went from 3 tests
to 5, a net +2, matching 209 → 211). `npx eslint` on every touched file:
clean.

I did not run `npm run ingest` end-to-end — no `.cache-v2` exists in this
worktree (matches Task 3's report) and populating it requires network
fetches (GAME_MASTER, pokedex, shiny sheet) not available/cheap here.
`test/transform-species.test.ts` (Task 3's suite, unmodified, still passing)
already asserts real known shiny debut dates end-to-end through
`buildSpecies` for Bulbasaur (`"2018-03-25"`), a Pikachu costume
(`"2016-12-25"`), Pikachu Gigantamax (`"2024-10-26"`), and standard Pikachu
(`"2017-08-09"`) — combined with this task's new sync-level tests, the full
path (shiny sheet → transform → `Form.shinyReleasedAt` → DB column) is
covered end-to-end, just not via one single live `npm run ingest` process.

I also started `npm run build:dummy-db` to check the schema change doesn't
break dummy-DB generation (it uses `REFERENCE_SCHEMA_SQL` directly and
inserts into `form` with an explicit, unchanged column list that omits the
new nullable column — which is schema-safe by construction: SQLite defaults
an omitted nullable column to `NULL`). It ran past a 2-minute timeout
(unrelated to this change — it's a large synthetic dataset generator) so I
stopped it rather than block on it; reasoned about safety instead of
observing it directly. Removed the partial `dummy.sqlite`/
`dummy.sqlite-journal` artifacts it left behind before committing.

## Self-review findings (and fixes made in response)

An advisor review after the first pass (before committing) raised three
things my initial test suite didn't cover because every fixture set the
field explicitly:

1. **Committed `reference.json` has no `shinyReleasedAt` key at all** (not
   `null` — absent), so `f.shinyReleasedAt` reads as `undefined` at real app
   runtime today (`sqlite-repository.ts:65`,
   `referenceDataJson as unknown as ReferenceData` bypasses structural
   checking). Added the `?? null` normalization plus a test that deletes the
   key entirely. Confirmed (by temporarily reverting) that drizzle already
   handled this safely — the fix is explicitness/documentation of intent,
   not a crash fix — but it's still the right call: the alternative is
   depending on an unstated ORM behavior.
2. **Upgrade path for existing installs** — verified `form` is in
   `reference-sync.ts`'s DROP list (line ~201) and that the drop+recreate is
   gated on the content-hash version, not run unconditionally. Confirmed no
   separate action item: the version bump is automatic and tied to the next
   real `npm run ingest` run, not something this task hand-edits.
3. **`csv-authoring.ts`'s import path** — investigated per the advisor's
   flag that `reference-csv-format.ts`'s header comment references
   `scripts/ingest/csv-authoring.ts`'s "export/template/import" commands and
   a round-trip could silently drop the new field. That script **does not
   exist** in this worktree (`find` came up empty) — only an export path is
   wired today, from `CoverageReportPage.vue` via `formToCsvRow`/
   `REFERENCE_CSV_COLUMNS`, with no counterpart import command yet
   (`ingest:csv:import` is referenced in a status string as a future
   command, not implemented). Since there's no live round-trip today, adding
   `shinyReleasedAt` to `REFERENCE_CSV_COLUMNS` isn't required for
   correctness and is out of the brief's 5-file scope; left untouched. Flag
   for whoever builds `csv-authoring.ts` later: extend
   `reference-csv-format.ts`'s column list at that point if the new field
   should be authorable.
4. Also checked (per advisor) for `SELECT *`/positional/column-count
   dependencies on `form`'s column order, since I inserted
   `shiny_released_at` mid-table (between `shiny_available` and
   `shadow_available`) rather than at the end — only `form_personal` and
   `form_background_personal` use `SELECT *`, never the reference `form`
   table itself. No dependency found; left the column where it is (adjacent
   to `shiny_available`, most readable placement) rather than moving it to
   satisfy a risk that doesn't exist.
5. `build-dummy-db.ts` and `src/data/reference-csv-format.ts` were
   deliberately **not** touched: both are out of the brief's 5-touch-file
   scope, the new column is nullable so neither breaks, and the CSV file's
   only live consumer today is export-only (see #3 above).

## Concerns

- The committed `src/data/reference.json` and `REFERENCE_DATA_VERSION` are
  now **stale relative to this branch's schema**: the DDL has the column,
  but no form in the bundled JSON actually has real debut dates until a
  fresh `npm run ingest` regenerates it (this matches the state Task 3 left
  things in — its report says the same field was being silently dropped
  until this task). This is expected/by-design for how this consolidation
  plan is sequenced (schema now, real regenerated data later, presumably a
  later task in this plan), not a bug, but flagging it so it isn't mistaken
  for "done, data is live" — no end user sees real dates until that ingest
  run + a reference.json commit happens.
- `csv-authoring.ts` doesn't exist yet; when it's built, its author should
  check whether `shinyReleasedAt` needs a `REFERENCE_CSV_COLUMNS` entry
  (see self-review #3).
