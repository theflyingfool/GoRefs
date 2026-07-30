# SQLite Storage Architecture Options

*Discussion draft — not canonical, not an implementation plan. Lives in
`docs/drafts/` alongside other exploratory material from this session. See
`docs/architecture.md` for the actual current architecture doc; this file
does not supersede it.*

## Summary / recommendation

The current single-file design (`src/db/reference-sync.ts`) has one real
structural weakness — reference-data resync does a JSON-parse-then-chunked-ORM-insert
of ~24 tables on every version bump, which is the slowest part of the whole
mechanism — but it has a genuinely strong safety property: SQLite's deferred
foreign-key check at `COMMIT` is a hard backstop against orphaned personal
data, enforced by the database engine itself, not by application code that
could have a bug. Splitting into two physical files (`reference.sqlite` +
`user.sqlite`) trades that backstop away — `ATTACH DATABASE` does not enforce
FKs across attached databases — for benefits (independent update cadence,
smaller/simpler migration surface per file) that don't correspond to any
currently stated goal in `docs/roadmap.md` or `docs/v1-tasks.md`. Shipping a
**prebuilt `reference.sqlite`** (built by the ingestion pipeline, much like
`scripts/build-dummy-db.ts` already does) is worth doing on its own merits —
it cuts boot-time cost from O(rows) parse+insert to O(file size) I/O — but is
best applied as a source format change *inside* the existing single-file,
single-transaction, deferred-FK architecture (attach the prebuilt file
temporarily inside the same transaction, bulk-copy with `INSERT ... SELECT`,
detach) rather than as a reason to split files. That hybrid is this
document's recommendation for near-term work; the two-file split should stay
a documented option, revisited only if a real need for independently
distributable reference-data packs shows up.

---

## Option 1: Status quo

One physical file. `src/db/schema/reference.ts` and `src/db/schema/personal.ts`
are separate Drizzle schema files purely for code organization — both sets of
tables live in the same SQLite connection. Reference data ships as
`src/data/reference.json` (baked into the bundle at build time) and is loaded
by `src/db/reference-sync.ts` at boot: version-check against `app_meta`,
apply `SLUG_RENAMES`, quarantine any personal row whose FK target won't
survive the swap, `DROP TABLE`+recreate every reference table, insert fresh
rows in 90-row chunks, all inside one transaction with
`PRAGMA defer_foreign_keys = true`.

### Pros
- **The deferred-FK check is a real safety net, enforced by SQLite, not app
  code.** If `quarantineOrphans` ever misses a case (a bug, an edge case in
  `SLUG_RENAMES`), the `COMMIT` itself fails and the whole resync rolls back —
  the user's existing data is never left half-migrated. This property is not
  something the two-file option can replicate for free.
- **`DROP TABLE` (not `DELETE FROM`) handles DDL drift for free.** Any
  column added/removed/renamed in a reference table on a new app version is
  picked up automatically, because the old table object is actually gone
  before recreation — no separate "did the schema change" detection needed.
- **One file = one thing to back up, restore, or hand to the user.** Simplest
  possible mental model for "your data," matching CLAUDE.md's data-portability
  invariant.
- **Already built, tested, and working** — zero migration risk from adopting
  it further; the whole app already assumes this shape.

### Cons
- **Boot-time cost scales with reference-table size**, not with whether
  anything actually changed. On a version bump, the app parses the full
  `reference.json` (multi-MB, ~10k rows in `form_move` alone) and does
  per-row ORM inserts in 90-row batches — synchronous work on the boot path.
- **JSON-parse-then-insert has real CPU cost** that a prebuilt binary format
  wouldn't: `JSON.parse` on the whole payload, then Drizzle's insert-builder
  overhead per chunk, versus a raw byte copy.
- **Single connection couples reference-resync risk to personal-data
  availability during the transaction window** — mitigated by the
  transaction/rollback, but the DDL for 24 reference tables and the personal
  tables' data are inseparable operationally; a bug in
  `REFERENCE_SCHEMA_SQL` blocks the whole boot, not just reference-data
  freshness.

---

## Option 2: Two physical files (`reference.sqlite` + `user.sqlite`)

`reference.sqlite` holds only the reference tables, replaced wholesale on
every app update (possibly as a prebuilt binary asset rather than JSON —
see Option 3). `user.sqlite` holds only personal data, managed exclusively
by drizzle-kit's incremental migrations, never touched by a reference
update. The app would open `user.sqlite` and `ATTACH DATABASE
'reference.sqlite' AS ref` to query across both in one connection.

### What breaks: FK enforcement across attached databases

SQLite does not enforce foreign keys across `ATTACH`ed databases — this is a
documented engine limitation, not a configuration option. `PRAGMA
defer_foreign_keys` and `PRAGMA foreign_keys = ON` only apply to
same-database constraints. That means the exact mechanism `reference-sync.ts`
leans on today — "if the resync would leave an orphaned personal row, refuse
to commit" — has no equivalent once `species_personal.species_slug` points
into a different physical file than `species.slug`.

Something has to replace it. Two realistic options:
1. **Application-level validation pass**, structurally similar to today's
   `quarantineOrphans`, but now needs to run on *every* boot (not just on a
   detected version change), because SQLite itself will never again catch a
   drift between the two files — there's no engine-level trigger for "the
   attached file changed since last checked."
2. **Trust the pipeline** (slug stability + `SLUG_RENAMES`) and accept that a
   genuinely missed rename shows up as a silently missing join result in the
   UI (a Pokémon that "disappears") rather than a hard, loud failure at boot.
   This is a meaningfully worse failure mode for the single highest-stakes
   property this app has (never lose or corrupt a user's already-collected
   data) — a silent UI gap is much easier to ship unnoticed than a failed
   transaction.

Either way, `SLUG_RENAMES` and the rename-application step still need to
exist identically to today — this option does not reduce that maintenance
burden, it only relocates where (or whether) orphan detection is enforced.

### Update mechanics per platform
- **Tauri (desktop):** `reference.sqlite` swap is a plain file replace in the
  app's resource directory. Needs care around not swapping the file out from
  under a live `ATTACH` handle — either swap before first attach (fresh
  process) or force a restart after replacing it, since SQLite doesn't
  gracefully hot-swap an attached file's on-disk identity mid-session.
- **Android/Capacitor:** `reference.sqlite` ships as a bundled asset,
  extracted via the same asset-extraction path already used for
  `reference.json` today (Capacitor's asset bundling / the
  `@capacitor-community/sqlite` plugin's own asset-import flow). Changing the
  file format doesn't simplify or complicate this step — it's the same
  bundled-asset-extraction problem either way.

### Pros
- `user.sqlite` is structurally guaranteed untouched by any reference-data
  operation, ever — removes the (currently small, since it's already wrapped
  in one transaction) risk surface of a reference-resync bug reaching
  personal tables.
- `reference.sqlite` becomes independently cacheable, diffable, and
  redistributable between app versions — relevant *if* the app ever wants to
  update reference data without a full app update (not a current goal per
  `docs/roadmap.md`/`docs/v1-tasks.md`).
- `user.sqlite`'s drizzle-kit migration history becomes easier to reason
  about in isolation, since the file only ever contains what drizzle-kit
  manages — no more "this file also has 24 tables drizzle-kit is told to
  ignore."

### Cons
- **Loses the deferred-FK safety net** — the single most load-bearing
  correctness mechanism in the current design — and requires rebuilding an
  equivalent guarantee entirely in application code, with a worse default
  failure mode (silent UI gap vs. hard rollback) if that code has a bug.
- **Two files instead of one for backup/restore/export**, complicating the
  "user owns their data" story: a user backing up "their data" now needs to
  either bundle both files or understand which one actually matters to them.
- **`ATTACH` overhead and a new failure mode** on every connection open — if
  `reference.sqlite` is missing, corrupted, or fails to attach, that's a new
  way for the app to fail to boot that doesn't exist when there's only one
  file to open.
- **No reduction in `SLUG_RENAMES`/rename-application maintenance** — this
  option changes *where* orphan-safety is enforced, not whether the rename
  registry needs to keep being hand-maintained.

---

## Option 3: Ship a prebuilt SQLite file instead of JSON

Skip `reference.json` and the runtime JSON.parse + chunked-insert loop
entirely. The ingestion pipeline (`scripts/ingest/build-reference.ts`)
outputs a ready-to-use `reference.sqlite` directly — this is very close to
what `scripts/build-dummy-db.ts` already does today (uses `node:sqlite`'s
`DatabaseSync` to build a real `.sqlite` file from `reference.json`, proving
the mechanics work in this exact toolchain). The app then either attaches
this file (Option 2) or bulk-copies its rows into the live single file
(Option 1's shape, see Option 4).

### Bundle size, boot time, cross-platform asset shipping
- **Bundle size:** a prebuilt SQLite file with its own page overhead and any
  indexes will likely be *larger on disk* than the equivalent JSON — SQLite's
  format is not optimized for minimal size the way compact JSON can be. Net
  effect on installed app size is workload-dependent (compression at the
  bundle/APK level changes the picture too) and worth measuring rather than
  assuming either direction.
- **Boot time:** this is the concrete win. Copying or attaching a file is
  I/O proportional to file size; the current approach is CPU proportional to
  row count (parse + per-row insert through the ORM). For a dataset with
  `form_move` alone at ~10k rows, skipping the insert loop is the single
  biggest lever available for reducing resync-triggered boot latency.
- **Tauri:** a prebuilt file placed in the bundle's resource directory,
  read/copied via Tauri's resource-resolution APIs — straightforward, no new
  concepts versus what's already needed to ship any bundled asset.
- **Android/Capacitor:** `@capacitor-community/sqlite` has first-class
  support for importing a prebuilt database from a bundled asset — this is a
  well-trodden path for that specific plugin and is arguably *simpler* than
  today's JSON-asset-then-runtime-build approach on Android specifically,
  since the plugin already expects "here's a prebuilt db, import it" as a
  supported operation.

### Cons
- **Does not replace the orphan-safety mechanism** — a prebuilt file changes
  how reference data is *produced and shipped*, not how the app reconciles
  it against existing personal data. `quarantineOrphans` and
  `SLUG_RENAMES` are still required regardless of source format; this option
  is complementary to, not a substitute for, the Option 1 vs. Option 2
  safety-net discussion.
- **New build-time step** — compiling `reference.sqlite` (presumably still
  via `node:sqlite`, same as `build-dummy-db.ts`) that must be kept in sync
  with `REFERENCE_SCHEMA_SQL`'s DDL by construction, adding one more thing
  the ingestion pipeline owns.
- **If used to bulk-copy into a live single file rather than fully replace
  it, needs an explicit merge strategy for column-shape changes.** The
  current `DROP TABLE`-then-recreate approach is simple precisely because it
  starts from a blank slate inside the same file; copying rows from an
  external prebuilt file into a live table is not equivalently simple if the
  column set has changed shape (has to `DROP`+recreate the target table
  first anyway, same as today, then bulk-copy instead of chunked-insert —
  see Option 4).

---

## Option 4: Attach-and-bulk-copy hybrid (Option 1 + Option 3 combined)

Keep the current single-file, single-connection, single-transaction
architecture completely intact — same `PRAGMA defer_foreign_keys`, same
`quarantineOrphans`, same `DROP TABLE`-then-recreate, same `SLUG_RENAMES`
application order — but replace the *body* of the insert step in
`syncReferenceData` with a bulk copy from a prebuilt `reference.sqlite`
instead of a JSON-parse-then-chunked-ORM-insert loop:

```
ATTACH DATABASE 'reference.sqlite' AS ref_import;
INSERT INTO species SELECT * FROM ref_import.species;
-- ...one INSERT...SELECT per reference table...
DETACH DATABASE ref_import;
```

...all still inside the same transaction that already has
`defer_foreign_keys` on and already runs `quarantineOrphans` first. Because
the `ATTACH` here is scoped to *inside* the existing resync transaction and
immediately detached, it never becomes a permanent part of the app's runtime
connection topology — it sidesteps Option 2's cross-attached-database FK gap
entirely, since the FK-bearing personal tables are never queried against the
attached database; only reference tables are populated from it, and the
existing same-file FK check at `COMMIT` still covers personal-to-reference
references exactly as it does today.

This is the option worth calling out explicitly because it is the only one
that improves boot time **without** touching the FK-safety architecture at
all — it changes only how `reference-sync.ts` populates rows, not what
guarantees the transaction provides.

*(A single-file-with-two-connections variant is not worth its own section —
same file, same FK enforcement, no structural difference from Option 1
worth naming. A `sqlite3_load_extension` virtual-table-over-JSON approach is
also not worth pursuing here: nothing in the runtime path queries reference
data directly out of JSON today, the data is always fully materialized into
tables either way, and loading a native extension adds real platform-variance
risk on Android/Capacitor's SQLite build for no corresponding benefit.)*

---

## Comparison table

| Option | Data-safety-on-update | Boot-time | Implementation complexity | Cross-platform parity |
|---|---|---|---|---|
| 1. Status quo | High — engine-enforced deferred-FK backstop | Medium — JSON parse + chunked insert on every version bump | Low — already built | High — identical connection/file model on Tauri and Capacitor |
| 2. Two files (reference.sqlite + user.sqlite) | Lower — cross-attached-db FKs unenforced; needs new app-level validation to match today's guarantee | Medium — same insert cost unless combined with Option 3 | High — new attach lifecycle, new validation logic, two-file backup story | Medium — asset extraction differs enough in character (two files, attach timing) to need platform-specific care |
| 3. Prebuilt reference.sqlite (as source format only) | Unchanged from whichever file-layout option it's paired with | High improvement — I/O-bound copy vs. CPU-bound parse+insert | Medium — new build-time compilation step, precedent exists in `build-dummy-db.ts` | High on Android (plugin has native prebuilt-db import support); straightforward on Tauri |
| 4. Attach-and-bulk-copy hybrid (1+3) | High — identical guarantees to Option 1, same transaction/FK check | High improvement — same I/O-bound win as Option 3 | Low-Medium — incremental change to `reference-sync.ts`'s insert step only | High — same as Option 1, plus Option 3's Android import path for the source asset |

---

## Recommendation

Pursue **Option 4** (attach-and-bulk-copy hybrid) as the concrete near-term
move if boot-time on reference-data updates becomes a real pain point: it
preserves every safety property the app currently has — the deferred-FK
backstop, the single-file backup story, the unchanged `quarantineOrphans`/
`SLUG_RENAMES` logic — while replacing only the slowest part
(JSON-parse-then-chunked-insert) with a bulk `INSERT ... SELECT` from a
prebuilt `reference.sqlite`, which `scripts/build-dummy-db.ts` already
demonstrates is buildable with this toolchain. It's a small, contained,
low-risk change to `reference-sync.ts` rather than a file-layout
rearchitecture.

Treat **Option 2** (the full two-file split) as a documented-but-deferred
idea, not a near-term recommendation. Its main advantage — independently
shippable/updatable reference data without a full app update — doesn't map
to any goal currently stated in `docs/roadmap.md` or `docs/v1-tasks.md`, and
its cost is real: it requires reimplementing, in application code, the exact
correctness guarantee (no orphaned personal data survives a reference
update) that CLAUDE.md and this app's whole design currently treat as the
highest-stakes property in the system. Revisit it only if a concrete need
for independent reference-data distribution actually shows up.
