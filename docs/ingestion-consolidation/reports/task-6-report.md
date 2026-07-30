# Task 6: SQLite-studio output — report

## What was implemented

1. **`scripts/ingest/write/sqlite.ts`** — `writeReferenceSqlite(referenceData, outPath?)`:
   materializes **`reference.sqlite`** at the repo root from a built `ReferenceData`
   object, using `node:sqlite`'s `DatabaseSync` + `REFERENCE_SCHEMA_SQL` (same
   approach as `scripts/build-dummy-db.ts`), reference tables only — no
   personal tables, no demo seed. `outPath` defaults to the real repo-root
   path but is overridable, so tests can target a scratch file instead of
   clobbering a developer's real `reference.sqlite`.

   All inserts run inside one `BEGIN`/`COMMIT` transaction. This was not
   optional — without it, `node:sqlite`'s autocommit-per-statement mode fsyncs
   on every single `INSERT`, and inserting the ~2,700-row `form` table alone
   took several seconds of wall time in this sandbox (the full dataset,
   several minutes, effectively hanging under a 60s timeout while I was
   diagnosing it). Wrapped in one transaction, the full load (1024 species,
   2716 forms, 11131 form-move links, etc.) takes well under a second.
   `build-dummy-db.ts` has the same unwrapped-inserts shape but wasn't touched
   for this task (out of scope) — worth a look if it's ever felt slow.

2. **Wired into `ingest.ts`** as a real `PipelineStep` (`{ name: "sqlite", run, skip: (f) => f.skipSqlite }`)
   placed after `sprites`, before `manifest`. Replaced the old ad-hoc
   `if (flags.skipSqlite) console.log(...)` block entirely — `--skip-sqlite`
   now genuinely skips the step via the same `skip` predicate mechanism
   `--skip-sprites` already used.

   Also refactored the orchestrator's step-running loop out of `main()` into
   an exported `runPipeline(steps, flags)`, and exported `parseFlags` and the
   `PipelineStep` type, purely so the "does skip actually skip" behavior is
   unit-testable without invoking the real fetch/build pipeline. Guarded the
   `main().catch(...)` call behind
   `if (process.argv[1] === fileURLToPath(import.meta.url))` so importing the
   module from a test doesn't also kick off a real ingest run. **Verified
   this guard against the real `npm run ingest:check` invocation** (not just
   `npx tsx ingest.ts`) — it printed `=== check: fetch ===` and ran normally,
   confirming `argv[1]` arrives as an absolute path under the real npm-script
   invocation path, not just direct `tsx` calls.

3. **`.gitignore`**: added `reference.sqlite` next to the existing
   `dummy.sqlite` entry.

4. **`drizzle.config.studio.ts`** (new, sibling to `drizzle.config.ts`):
   `dialect: "sqlite"`, `schema: "./src/db/schema/reference.ts"` only,
   `dbCredentials.url: "./reference.sqlite"`. Added `npm run studio` ->
   `drizzle-kit studio --config drizzle.config.studio.ts`.

   **Schema-scoping decision and what I actually observed:** I tested a
   config combining both `schema/reference.ts` and `schema/personal.ts`
   against `reference.sqlite` (which has zero personal tables). It **did
   not error at startup** — `drizzle-kit studio` came up cleanly either way.
   I could not interact with the web UI in this environment (no browser), so
   I could not confirm whether *browsing* a personal table in the combined
   config would error at query time against a file that lacks those tables.
   Given that uncertainty, and since `reference.sqlite` genuinely has no
   personal-table data to show, I scoped the studio config to
   `schema/reference.ts` only — the correct schema for what the file actually
   contains, not because the combined config was observed to fail. If
   personal-table browsing against a *live on-device* export ever becomes a
   real need, a separate combined config could be added then.

5. **`build-dummy-db.ts` — kept, not deleted.** It's not redundant:
   `reference.sqlite` is a superset of it on reference-table content (real
   ingested data vs. build-dummy-db's same real data), but a **strict
   subset** on personal tables — `reference.sqlite` has none at all (schema
   or rows), while `build-dummy-db.ts` runs `runPersonalMigrations()` to
   create the personal schema and then seeds it with
   `src/data/personal-demo-seed.ts`'s hand-written demo toggles (registered
   species, caught forms, tag data, etc.). `personal-demo-seed.ts` is used
   nowhere else in the codebase (confirmed via grep) — `build-dummy-db.ts` is
   its only consumer, and that consumer still serves a purpose neither this
   task's step nor anything else does: showing what a populated personal
   schema looks like. `npm run build:dummy-db` and its docs (README.md,
   docs/commands.md, docs/architecture.md) were left in place;
   docs/commands.md and docs/architecture.md were both updated to
   distinguish the two outputs' purposes (see below).

6. **Docs updated:**
   - `docs/commands.md` — added `npm run studio` under Data Ingestion &
     Maintenance, noted `build:dummy-db`'s personal-demo-seed distinction,
     updated the ingest pipeline step list to include `sqlite`.
   - `docs/architecture.md` — updated the `ingest.ts` row's step list
     (fetch → build → slug-check → sprites → sqlite → manifest, including
     `ingest:check`'s skip list), added a new `ingest/write/sqlite.ts` row
     to the Scripts table.

## Scope addition: `better-sqlite3` devDependency

`npx drizzle-kit studio` refused to start against a SQLite file with neither
`better-sqlite3` nor `@libsql/client` installed — that's drizzle-kit's own
runtime requirement, not something this task's brief asked for or something
I chose gratuitously. I installed **`better-sqlite3` as a devDependency**
(chose it over `@libsql/client` since it's the more common/lighter local-file
driver and this app has no libSQL/remote-DB usage elsewhere). This is a new
native dependency and CLAUDE.md's invariants say to avoid unnecessary
external deps — flagging this as an explicit scope addition for the owner to
weigh in on, not burying it. Mitigating precedent: `sharp` is already a
native devDependency in this project, so a native devDependency isn't
unprecedented here. `package-lock.json`'s diff is purely additive (verified
via `git diff package-lock.json | grep -c '^-'` → only the diff-header line,
no real deletions), so the existing dependency tree wasn't disturbed.

## Tests

- **`test/write-sqlite.test.ts`** (new, 3 tests):
  - `writeReferenceSqlite` produces a valid, queryable SQLite file with the
    expected reference tables and rows (regions/species/form/form_types
    content-checked; confirms empty-array tables like `move` still exist
    with 0 rows).
  - Overwrites a pre-existing file at the same path rather than erroring or
    appending.
  - Rejects a row that violates the schema's FK constraints (`foreign_keys`
    enforcement verified, not just assumed).
  - Scratch path lives under the gitignored `CACHE_V2_ROOT` (matching
    `write-manifest.test.ts`'s existing pattern), not the repo root, so a
    hard abort mid-test can't leave stray untracked files at the repo root.

- **`test/ingest-pipeline.test.ts`** (new, 3 tests):
  - `parseFlags` recognizes `--skip-sqlite` independent of `--skip-sprites`/`--check`.
  - `runPipeline` never calls a skipped step's `run()` — asserts against an
    actual call-tracking array, not just checking the skip predicate's
    return value, so this genuinely tests "skip skips," not "logs skip."
  - `runPipeline` calls every step's `run()` when no skip flags are set.

## Verification run

- `npm test`: **221/221 pass** (215 pre-existing + 6 new), both before and
  after the post-review fixes below.
- `npx tsc -b`: clean.
- `npx eslint .`: clean (also ran automatically via the pre-commit hook).
- Full `npm run ingest -- --skip-sprites` (real network fetch, real GAME_MASTER/pokedex/shiny-sheet data): completed successfully end-to-end, including the new `sqlite` step (`Wrote reference SQLite file -> .../reference.sqlite`). Verified via `sqlite3 reference.sqlite ".tables"` and row counts (species=1024, form=2716, move=328, form_move=11131, player_level=80) — matches the console output from the `build` step. This run refreshed `src/data/reference.json`, `src/data/reference-version.ts`, and `scripts/ingest/.cache-v2/ingestion-manifest.json` with fresh upstream data (out of scope for this task) — reverted those three files with `git checkout --` before committing, so the commit only contains Task 6's actual changes.
- `npm run ingest:check`: ran cleanly, printed `=== check: fetch ===` and correctly reported no upstream changes — this specifically verifies the `main()` entry-point guard works under the real npm-script invocation path, not just direct `tsx` invocation.
- `npx drizzle-kit studio --config drizzle.config.studio.ts`: started cleanly (`Drizzle Studio is up and running on https://local.drizzle.studio`) against the real `reference.sqlite` produced by the ingest run above. **Could not verify**: actual browser-based interaction with the web UI (no browser available in this environment) — confirmed clean startup and the process staying up until manually timed out, which is the evidence available here.

## Self-review / post-advisor fixes

An advisor pass flagged four items before I wrote this report, all addressed:

1. Verified the `main()` guard against `npm run ingest:check` specifically
   (not just `npx tsx`) — confirmed working, no change needed.
2. Verified `package-lock.json`'s diff is purely additive — confirmed, no
   change needed.
3. Corrected this report to state precisely what was observed about the
   combined-schema studio config (starts cleanly either way; scoping to
   `reference.ts` was a data-correctness choice, not a reaction to an
   observed failure).
4. Explicitly flagged `better-sqlite3` as a scope addition (see section
   above) rather than treating it as an incidental footnote.
5. Moved `write-sqlite.test.ts`'s scratch path from the repo root into
   `CACHE_V2_ROOT` to match `write-manifest.test.ts`'s existing
   abort-safety pattern. Re-ran `npm test` after this fix: still 221/221
   pass.

## Files changed

- `scripts/ingest/write/sqlite.ts` (new)
- `scripts/ingest/ingest.ts` (modified — sqlite step wiring, `runPipeline`/`parseFlags`/`PipelineStep` exported, guarded entry point)
- `drizzle.config.studio.ts` (new)
- `.gitignore` (modified)
- `package.json` / `package-lock.json` (modified — `studio` script, `better-sqlite3` devDependency)
- `docs/commands.md`, `docs/architecture.md` (modified)
- `test/write-sqlite.test.ts` (new)
- `test/ingest-pipeline.test.ts` (new)

Not modified (deliberately): `scripts/build-dummy-db.ts`, `src/data/personal-demo-seed.ts` — see redundancy analysis above.

## Concerns for the owner

- New native devDependency (`better-sqlite3`) — see "Scope addition" section
  above. Alternative was `@libsql/client`; happy to switch if preferred.
- Drizzle Studio's actual web UI was never visually verified in this
  environment — only clean process startup was confirmed.
