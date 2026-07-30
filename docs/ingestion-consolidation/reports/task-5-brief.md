### Task 5: Shiny schema extension

Store the pokemongo-shiny sheet's `debut` date, not just a boolean. Touch:
- `src/db/types.ts` — extend the `Form` (or wherever `shinyAvailable`
  currently lives — confirm by reading the file) type with a new field,
  e.g. `shinyReleasedAt: string | null` (ISO date, null = not released).
  Keep `shinyAvailable` as a derived boolean (`shinyReleasedAt !== null`)
  if other code reads it directly — check call sites before deciding
  whether to keep both fields or replace one with the other.
- **`src/db/schema.ts`** (the hand-maintained `REFERENCE_SCHEMA_SQL` SQL
  string — NOT `src/db/schema/reference.ts`, which is Drizzle's own schema
  definition used only for typed queries and is not the DDL
  `reference-sync.ts` actually executes; this distinction was a real error
  caught in plan review, don't repeat it) — add the new column to the
  `form` table's DDL.
- `src/db/reference-data.ts` — extend the `Form`-shaped entry in
  `ReferenceData` to match.
- `src/db/reference-sync.ts` — add the new field to the `form` insert
  mapping (the `referenceData.forms.map(...)` block).
- Task 3's `transform/species.ts` (or wherever form-building logic landed)
  — populate the new field from the shiny-sheet source instead of leaving
  it null; this may require a small follow-up edit to Task 3's output if
  Task 3 already ran without this column existing — check.

This needs a real drizzle-kit migration if `form` is part of the
drizzle-managed migration path — check whether `form`/reference tables are
excluded from `drizzle-kit generate`'s diffing (a prior SDD ledger entry in
this repo's history noted reference tables are excluded from that path);
if excluded, no migration file is needed since `reference-sync.ts`'s
`DROP TABLE`+recreate-from-`REFERENCE_SCHEMA_SQL` handles the DDL change
automatically on next sync — confirm this explicitly in your report rather
than assuming either way.

Write/update tests covering: the new column round-trips through
`reference-sync.ts`'s sync correctly, and a form with no `debut` match in
the shiny sheet gets `shinyReleasedAt: null` (not a crash).

