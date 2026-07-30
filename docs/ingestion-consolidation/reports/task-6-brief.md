### Task 6: SQLite-studio output

Build a script/module that materializes a real `.sqlite` file from the
**real, fully-built** `reference.json` (post Task 3/4/5) — model it on
`scripts/build-dummy-db.ts`'s existing approach (`node:sqlite`'s
`DatabaseSync` + `test/node-sqlite-connection.ts` + `REFERENCE_SCHEMA_SQL`
— read both files first) but with **no fake personal-table demo seed**,
reference tables only. Name the output file `reference.sqlite` (gitignored
— add it to `.gitignore` next to the existing `dummy.sqlite` entry). Wire
it into `ingest.ts` (Task 4) as a `PipelineStep`, gated by `--skip-sqlite`.

Add a drizzle-kit studio config (e.g. `drizzle.config.studio.ts`) with
`dbCredentials.url` pointing at `reference.sqlite`, combining both
`schema/reference.ts` and `schema/personal.ts` as its `schema` (check
whether `drizzle-kit studio` needs both schemas listed even though this
file only has reference tables — if personal-table schema references cause
an error against a file that lacks those tables, scope the studio config's
`schema` field to `schema/reference.ts` only and note why in your report).
Add an `npm run studio` (or similarly named) script.

Once this works, confirm whether `scripts/build-dummy-db.ts` and its
`npm run build:dummy-db` script are now fully redundant (real data is a
superset of what it demonstrated) — if genuinely redundant and nothing
else references it, delete it and its script entry; if anything still
depends on the fake-personal-data variant specifically (check for
references first), leave it and explain why in your report.

