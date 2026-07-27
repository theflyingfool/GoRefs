# Sub-project 7b: Stable Identity & Merge-Gap Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `pokemon_instance`/`tag` a stable cross-device identity, add a `referenced_trainer` trainer-identity registry, and build the single export/import mechanism (with friend-code/name reconciliation) that makes merging two trainers' data — whether the same person's two devices, a friend's file, or two local profiles — work as one code path.

**Architecture:** One additive/rebuild migration (`0005`) adds the new columns/table and backfills them. `referenced_trainer` mirrors every real `profile` row (kept in sync inside `createProfile`/`renameProfile`, the same atomic operations Sub-project 7a built) plus placeholder rows for trainers referenced but never fully imported. A pure reconciliation function decides, given friend-code/name signals, whether an incoming trainer is new, a placeholder to promote, or a real profile to merge or keep separate; a SQL-statement-builder function (same shape as `profile-management-sql.ts`) executes the resulting UUID rewrite. `tag` moves from per-profile to a single device-wide list. Export gains a per-trainer function and a bundle wrapper; import runs the existing per-row merge (`importPersonalData`) once per trainer in a bundle, after reconciliation.

**Tech Stack:** TypeScript, Drizzle ORM (schema/migration generation only — a hand-rolled runner applies them, see `src/db/migrations.ts`), `@tauri-apps/plugin-sql` on-device / `node:sqlite` in tests, Vue 3 `<script setup>`, `node:test` + `node:assert/strict`.

## Global Constraints

- Every existing `id` integer PK (`pokemon_instance.id`, `tag.id`) stays exactly as-is — no route, join, or FK changes. New UUID columns are additive only.
- `originalTrainerId` is **never** a SQL foreign key (soft link only) — see design spec §3.1 for why (a specimen may travel to a device that has never heard of its named original trainer).
- The incoming UUID always wins on any reconciliation merge or promotion (design spec §4.3) — never the local/placeholder UUID.
- `referenced_trainer` is a complete registry: every real `profile` row has a mirrored row with the same `uuid`/`name`/`friendCode`, kept in sync in `createProfile`/`renameProfile`; `deleteProfile` does **not** remove the mirrored row (design spec §4.2).
- One export function per trainer (`exportTrainer(profileId)`), one import/merge function per trainer (`importPersonalData`, unchanged core logic) — "export current" / "export all" and "sync device" / "merge friend" / "compare profiles" are never separate code paths (design spec §2).
- Follow this codebase's existing write-discipline patterns exactly: `enqueueSerialized` (not `enqueueWrite`) for any write whose caller must see a real commit/rollback outcome before mutating in-memory state (see `sqlite-repository.ts`'s `createProfile`/`renameProfile`/`deleteProfile` for the established pattern and its rationale comments).
- Design doc: `docs/superpowers/specs/2026-07-26-sub-project-7b-identity-and-merge-design.md`. Read it before starting — this plan implements it section by section but does not restate every rationale.

---

## File Structure

- `src/db/schema/personal.ts` — add `referencedTrainer` table; add `pokemonInstance.uuid`/`originalTrainerName`/`originalTrainerId`; rename `pokemonInstance.status`'s `released` enum value to `transferred`; change `tag`'s unique constraint from `(profileId, name)` to `(name)` alone.
- `src/db/schema.ts` — bump `CURRENT_PERSONAL_SCHEMA_VERSION`.
- `src/db/migrations/0005_<generated-name>.sql` + `src/db/migrations-data.ts` — new migration, generated then hand-fixed per the established `0004` pattern.
- `src/db/types.ts` — add `ReferencedTrainer` interface; extend `PokemonInstance`; update `PokemonInstanceStatus`.
- `src/data/referenced-trainer-sql.ts` (new) — pure SQL-builder functions for `referenced_trainer` CRUD, mirroring `profile-management-sql.ts`'s style.
- `src/data/trainer-reconciliation.ts` (new) — pure reconciliation decision function + the UUID-rewrite statement builder.
- `src/data/repository.ts` — interface additions: `ReferencedTrainer` import, `TrainerExport`/`ExportBundle` types, `exportTrainer`, `planTrainerImport`, `applyTrainerImport`.
- `src/data/sqlite-repository.ts` — wire `referenced_trainer` sync into `createProfile`/`renameProfile`; add `exportTrainer`/`planTrainerImport`/`applyTrainerImport`; move `tags` out of per-profile `PersonalState`.
- `src/data/in-memory-store.ts` — `PersonalState` interface changes (drop `tags` from the per-profile shape — see Task 6); `pokemon_instance` creation defaults for `uuid`/`originalTrainerName`/`originalTrainerId`.
- `src/features/settings/personal-data-transfer.ts` — `buildExportBundle`/`readExportBundleFile` helpers.
- `src/features/settings/SettingsPage.vue` — "Export current" / "Export all trainers" buttons; bundle-aware import flow with reconciliation prompts.
- `src/features/collection/EditInstancePage.vue` — "Original Trainer" text field.
- `src/features/collection/CollectionPage.vue`, `src/features/log-catch/LogCatchPage.vue` — `released` → `transferred` label/value rename.
- Tests: `test/referenced-trainer-sql.test.ts`, `test/trainer-reconciliation.test.ts`, `test/sqlite-repository-trainer-export-import.test.ts`, `test/migrations.test.ts` (extended), `test/tag-management.test.ts` (updated for global tags).

---

### Task 1: Migration 0005 — schema, types, and backfill

**Files:**
- Modify: `src/db/schema/personal.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/types.ts`
- Create: `src/db/migrations/0005_<name>.sql` (name assigned by drizzle-kit)
- Modify: `src/db/migrations-data.ts` (regenerated by `npm run db:generate-data`)
- Test: `test/migrations.test.ts`

**Interfaces:**
- Produces: `referencedTrainer` Drizzle table; `ReferencedTrainer` TS interface `{ uuid: string; name: string; friendCode: string | null }`; `PokemonInstance.uuid: string`, `PokemonInstance.originalTrainerName: string`, `PokemonInstance.originalTrainerId: string | null`; `PokemonInstanceStatus = "kept" | "traded" | "transferred" | "evolved"`; `tag_name_unique` constraint (device-wide).

- [ ] **Step 1: Add `referencedTrainer` to the Drizzle schema**

In `src/db/schema/personal.ts`, add after the `profile` table definition:

```ts
// The complete trainer-identity registry -- every real `profile` row has a
// mirrored row here (kept in sync by createProfile/renameProfile), plus
// placeholder rows for trainers referenced (via pokemon_instance.original_trainer_id
// or an import name-match) but never promoted to a real local profile. See
// docs/superpowers/specs/2026-07-26-sub-project-7b-identity-and-merge-design.md
// section 4 for why this is a separate table rather than a flag on `profile`.
export const referencedTrainer = sqliteTable("referenced_trainer", {
  uuid: text("uuid").primaryKey(),
  name: text("name").notNull(),
  friendCode: text("friend_code"),
});
```

- [ ] **Step 2: Add `pokemon_instance`'s new columns and rename the `status` enum value**

In `src/db/schema/personal.ts`, in the `pokemonInstance` table's column list, change:

```ts
    status: text("status", { enum: ["kept", "traded", "released", "evolved"] }).notNull().default("kept"),
```

to:

```ts
    status: text("status", { enum: ["kept", "traded", "transferred", "evolved"] }).notNull().default("kept"),
```

and immediately after the `backgroundSlug: text("background_slug"),` line, add:

```ts
    uuid: text("uuid").notNull(),
    originalTrainerName: text("original_trainer_name").notNull(),
    // Soft link into referenced_trainer.uuid -- deliberately NOT `.references()`.
    // See docs/superpowers/specs/2026-07-26-sub-project-7b-identity-and-merge-design.md
    // section 3.1: a specimen naming a trainer this device has never imported
    // must not fail or silently drop on write.
    originalTrainerId: text("original_trainer_id"),
```

In the same table's constraints callback, change the `statusCheck` line to:

```ts
    statusCheck: check("pokemon_instance_status_enum", sql`${table.status} IN ('kept', 'traded', 'transferred', 'evolved')`),
```

and add a unique index on the new `uuid` column by changing the constraints callback's return object to also include:

```ts
    uuidUnique: unique("pokemon_instance_uuid_unique").on(table.uuid),
```

- [ ] **Step 3: Change `tag`'s uniqueness from per-profile to device-wide**

In `src/db/schema/personal.ts`, change:

```ts
  (table) => ({
    profileNameUnique: unique("tag_profile_id_name_unique").on(table.profileId, table.name),
  }),
```

to:

```ts
  (table) => ({
    nameUnique: unique("tag_name_unique").on(table.name),
  }),
```

- [ ] **Step 4: Bump the personal-data schema version**

In `src/db/schema.ts`, find `export const CURRENT_PERSONAL_SCHEMA_VERSION = 10;` and change it to `11`. Add a one-line comment above it noting what changed, matching the file's existing convention (check the comment above the current `= 10` line and follow its style) — e.g. `// 11: pokemon_instance gains uuid/original_trainer_name/original_trainer_id, status's 'released' renamed to 'transferred', tag uniqueness becomes device-wide, new referenced_trainer table (Sub-project 7b).`

- [ ] **Step 5: Update `src/db/types.ts`**

Add after the `Profile` interface:

```ts
// The complete trainer-identity registry -- see schema.ts's referencedTrainer
// table comment. Every real Profile has a mirrored row here.
export interface ReferencedTrainer {
  uuid: string;
  name: string;
  friendCode: string | null;
}
```

Change:

```ts
export type PokemonInstanceStatus = "kept" | "traded" | "released" | "evolved";
```

to:

```ts
export type PokemonInstanceStatus = "kept" | "traded" | "transferred" | "evolved";
```

In the `PokemonInstance` interface, after `backgroundSlug: string | null;`, add:

```ts
  uuid: string;
  originalTrainerName: string;
  originalTrainerId: string | null;
```

- [ ] **Step 6: Generate and hand-fix the migration**

Run:

```bash
npm run db:generate
```

This produces `src/db/migrations/0005_<generated-name>.sql`. Open it and apply the **exact same class of hand-fixes documented in `src/db/migrations/0004_empty_vapor.sql`'s header comment**: restore every `REFERENCES` clause drizzle-kit drops on columns that point at `schema/reference.ts` tables or `profile(id)` (compare against `schema/personal.ts`'s actual column definitions to know which — `pokemon_instance.form_slug` → `form(slug)`, `pokemon_instance.profile_id` → `profile(id)`, `pokemon_instance.background_slug` → `backgrounds(slug)`, `pokemon_instance.original_trainer_id` → **no REFERENCES** (soft link, per Global Constraints) — leave this one plain); drop `iv_percent` from the rebuilt `pokemon_instance`'s INSERT/SELECT column lists (generated column, same fix as every prior `pokemon_instance` rebuild); bracket the whole file with `PRAGMA foreign_keys=OFF;` at the top and `PRAGMA foreign_keys=ON;` at the end if drizzle-kit didn't already place them correctly (check for the same multi-table bracketing bug `0004`'s header describes).

Beyond that mechanical rebuild, this migration needs real backfill logic drizzle-kit cannot generate. Add these as additional statements **after** the rebuilt `pokemon_instance` table is renamed back from `__new_pokemon_instance` (so they run against the real `pokemon_instance` name), each on its own `--> statement-breakpoint` line:

```sql
UPDATE pokemon_instance SET uuid = lower(hex(randomblob(16))) WHERE uuid = '' OR uuid IS NULL;
UPDATE pokemon_instance SET original_trainer_name = (SELECT username FROM profile WHERE profile.id = pokemon_instance.profile_id) WHERE original_trainer_name = '' OR original_trainer_name IS NULL;
UPDATE pokemon_instance SET original_trainer_id = profile_id WHERE original_trainer_id IS NULL;
UPDATE pokemon_instance SET status = 'transferred' WHERE status = 'released';
```

(`uuid`/`original_trainer_name` are `NOT NULL` columns with no default in the schema, so drizzle-kit's generated `INSERT INTO __new_pokemon_instance (...) SELECT ...` will already fail on existing rows unless you give them a placeholder in that SELECT — add `'' AS uuid, '' AS original_trainer_name` to the SELECT's column list at the position matching the `INSERT` list, then let the `UPDATE` statements above replace the placeholders immediately after the rename. Verify this by reading the generated INSERT/SELECT pair before editing — the exact column position depends on where you placed the new columns in Step 2.)

Add the new table and its backfill after the `pokemon_instance` block:

```sql
CREATE TABLE `referenced_trainer` (
	`uuid` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`friend_code` text
);
--> statement-breakpoint
INSERT INTO referenced_trainer (uuid, name, friend_code) SELECT id, username, friend_code FROM profile;
```

For the `tag` table's uniqueness change, drizzle-kit will emit a rebuild plus a `CREATE UNIQUE INDEX tag_name_unique ON tag (name)`. Before that index creation statement, add a de-duplication pass (real per-profile duplicate names are now possible since tags were profile-scoped until this migration):

```sql
UPDATE pokemon_instance_tag SET tag_id = (
  SELECT MIN(t2.id) FROM tag t1 JOIN tag t2 ON t2.name = t1.name WHERE t1.id = pokemon_instance_tag.tag_id
) WHERE tag_id IN (
  SELECT t1.id FROM tag t1 JOIN tag t2 ON t2.name = t1.name AND t2.id < t1.id
);
--> statement-breakpoint
DELETE FROM tag WHERE id IN (
  SELECT t1.id FROM tag t1 JOIN tag t2 ON t2.name = t1.name AND t2.id < t1.id
);
```

Place this immediately before the `CREATE UNIQUE INDEX \`tag_name_unique\`` line drizzle-kit generates (it must run before that index creation, or the index creation fails if duplicates remain).

- [ ] **Step 7: Regenerate migrations-data.ts**

```bash
npm run db:generate-data
```

Confirm `src/db/migrations-data.ts` now has a `"0005_<name>"` entry with your hand-fixed SQL as its string value (open the file and check the tail).

- [ ] **Step 8: Write and run a migration test**

Add to `test/migrations.test.ts` (open the file first to match its existing test style and imports — it already exercises `runPersonalMigrations` against a `node:sqlite` `DatabaseSync`):

```ts
test("migration 0005 backfills pokemon_instance identity fields and creates referenced_trainer", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  // Seed a device at schema 0004 (pre-7b) shape: insert a profile and a
  // pokemon_instance row using the OLD column set, then run migrations.
  await runPersonalMigrations(conn); // brings a fresh DB to the latest schema directly; this exercises the CREATE-TABLE path, not a real upgrade
  const profileId = (db.prepare("SELECT id FROM profile").get() as { id: string }).id;
  db.exec(`INSERT INTO regions (slug, name) VALUES ('kanto', 'Kanto')`);
  db.exec(
    `INSERT INTO species (slug, dex_number, name, family_slug, gen, rarity, region_slug, has_male, has_female, can_mega_evolve, can_gigantamax) VALUES ('bulbasaur', 1, 'Bulbasaur', 'bulbasaur', 1, 'standard', 'kanto', 1, 1, 0, 0)`,
  );
  db.exec(
    `INSERT INTO form (slug, species_slug, form_name, gender, evolves, shiny_available, shadow_available, dynamax_available, regional_exclusive) VALUES ('bulbasaur-base', 'bulbasaur', 'Base', 'unknown', 1, 1, 0, 0, 0)`,
  );
  db.prepare(
    `INSERT INTO pokemon_instance (form_slug, profile_id, status, recorded_at, updated_at, uuid, original_trainer_name, original_trainer_id) VALUES (?, ?, 'kept', ?, ?, ?, ?, ?)`,
  ).run("bulbasaur-base", profileId, Date.now(), Date.now(), crypto.randomUUID(), "Tester", profileId);

  const referenced = db.prepare("SELECT uuid, name FROM referenced_trainer WHERE uuid = ?").get(profileId) as { uuid: string; name: string } | undefined;
  assert.ok(referenced, "profile must have a mirrored referenced_trainer row");
  assert.equal(referenced!.name, "Tester");
});
```

Run:

```bash
npx tsc -b && npm test
```

Expected: clean compile, all tests pass including the new one. If the fresh-DB path above doesn't actually exercise your backfill UPDATE statements (a brand-new `CREATE TABLE` never has stale rows to backfill), that's expected for a fresh install — the important coverage is that `referenced_trainer` gets created and seeded from `profile`, which this test does verify. Note in your task report that the backfill-from-a-pre-0005-device path is covered by the migration SQL's correctness (matching 0004's precedent) but not exercised by a dedicated upgrade-path test in this task, consistent with how `0004`'s own tests were scoped.

- [ ] **Step 9: Commit**

```bash
git add src/db/schema/personal.ts src/db/schema.ts src/db/types.ts src/db/migrations/ src/db/migrations-data.ts test/migrations.test.ts
git commit -m "Add referenced_trainer table, pokemon_instance identity/original-trainer columns, device-wide tag uniqueness (migration 0005)"
```

---

### Task 2: `referenced_trainer` SQL builders + sync from `createProfile`/`renameProfile`

**Files:**
- Create: `src/data/referenced-trainer-sql.ts`
- Modify: `src/data/sqlite-repository.ts`
- Test: `test/referenced-trainer-sql.test.ts`

**Interfaces:**
- Consumes: `ReferencedTrainer` (Task 1), `SqlStatement` type from `src/data/profile-scoped-write-sql.ts`.
- Produces: `buildReferencedTrainerUpsert(trainer: ReferencedTrainer): SqlStatement`, `findReferencedTrainerByUuid(db, uuid): Promise<ReferencedTrainer | undefined>`, `findReferencedTrainerByName(db, name): Promise<ReferencedTrainer | undefined>`, `listReferencedTrainers(db): Promise<ReferencedTrainer[]>` — all consumed by later tasks.

- [ ] **Step 1: Write `src/data/referenced-trainer-sql.ts`**

```ts
// referenced_trainer is the complete trainer-identity registry (every real
// profile mirrored, plus placeholders) -- see
// docs/superpowers/specs/2026-07-26-sub-project-7b-identity-and-merge-design.md
// section 4. Pure SQL-builder functions for the upsert, plus thin read
// helpers, so both are directly testable against a real node:sqlite
// DatabaseSync -- same reasoning as profile-management-sql.ts.

import type { SqlStatement } from "./profile-scoped-write-sql";
import type { ReferencedTrainer } from "../db/types";
import type { getDb } from "../db/connection";

export function buildReferencedTrainerUpsert(trainer: ReferencedTrainer): SqlStatement {
  return {
    sql: `INSERT INTO referenced_trainer (uuid, name, friend_code) VALUES (?, ?, ?)
          ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, friend_code = excluded.friend_code`,
    params: [trainer.uuid, trainer.name, trainer.friendCode],
  };
}

type Db = Awaited<ReturnType<typeof getDb>>;

function rowToReferencedTrainer(row: Record<string, unknown>): ReferencedTrainer {
  return { uuid: row.uuid as string, name: row.name as string, friendCode: (row.friend_code as string | null) ?? null };
}

export async function findReferencedTrainerByUuid(db: Db, uuid: string): Promise<ReferencedTrainer | undefined> {
  const result = await db.query("SELECT uuid, name, friend_code FROM referenced_trainer WHERE uuid = ?", [uuid]);
  const row = result.values?.[0] as Record<string, unknown> | undefined;
  return row ? rowToReferencedTrainer(row) : undefined;
}

export async function findReferencedTrainerByName(db: Db, name: string): Promise<ReferencedTrainer | undefined> {
  const result = await db.query("SELECT uuid, name, friend_code FROM referenced_trainer WHERE name = ?", [name]);
  const row = result.values?.[0] as Record<string, unknown> | undefined;
  return row ? rowToReferencedTrainer(row) : undefined;
}

export async function listReferencedTrainers(db: Db): Promise<ReferencedTrainer[]> {
  const result = await db.query("SELECT uuid, name, friend_code FROM referenced_trainer", []);
  return ((result.values ?? []) as Record<string, unknown>[]).map(rowToReferencedTrainer);
}
```

Check `src/db/connection.ts` for the actual exported name of the DB-handle type/function (`getDb`) and the real shape of `db.query`'s return value (`sqlite-repository.ts` already uses `(await db.query(...)).values` in several places — match that exactly, e.g. the `createTag`/`createPokemonInstances` methods you already read).

- [ ] **Step 2: Test the upsert builder against real SQLite**

Create `test/referenced-trainer-sql.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { runPersonalMigrations } from "../src/db/migrations";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";
import { buildReferencedTrainerUpsert, findReferencedTrainerByUuid, findReferencedTrainerByName } from "../src/data/referenced-trainer-sql";

test("buildReferencedTrainerUpsert inserts then updates on the same uuid", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  const uuid = "11111111-1111-1111-1111-111111111111";
  const insert = buildReferencedTrainerUpsert({ uuid, name: "Ash", friendCode: null });
  db.prepare(insert.sql).run(...(insert.params as never[]));
  let found = await findReferencedTrainerByUuid(conn, uuid);
  assert.equal(found?.name, "Ash");

  const update = buildReferencedTrainerUpsert({ uuid, name: "Ash Ketchum", friendCode: "123456789012" });
  db.prepare(update.sql).run(...(update.params as never[]));
  found = await findReferencedTrainerByUuid(conn, uuid);
  assert.equal(found?.name, "Ash Ketchum");
  assert.equal(found?.friendCode, "123456789012");

  const byName = await findReferencedTrainerByName(conn, "Ash Ketchum");
  assert.equal(byName?.uuid, uuid);
});
```

Run: `npx tsc -b && npm test`. Expected: passes. (If `conn.query`'s real return shape differs from what Step 1 assumed, fix `referenced-trainer-sql.ts`'s read helpers to match — check `node-sqlite-connection.ts`'s implementation of `query` directly rather than guessing.)

- [ ] **Step 3: Wire the mirror into `createProfile`**

In `src/data/sqlite-repository.ts`, import `buildReferencedTrainerUpsert` from `./referenced-trainer-sql`. Inside `createProfile`'s `enqueueSerialized` block, after the `INSERT INTO profile ...` call and before `await db.commitTransaction()`, add:

```ts
        const referencedUpsert = buildReferencedTrainerUpsert({ uuid: newProfile.id, name: newProfile.username, friendCode: newProfile.friendCode });
        await db.run(referencedUpsert.sql, referencedUpsert.params, false);
```

- [ ] **Step 4: Wire the mirror into `renameProfile`**

In `renameProfile`'s `enqueueSerialized` block, after the existing `UPDATE profile SET username = ..., friend_code = ...` call, add:

```ts
      const referencedUpsert = buildReferencedTrainerUpsert({ uuid: profileId, name: username, friendCode });
      await db.run(referencedUpsert.sql, referencedUpsert.params, true);
```

(This one isn't inside an explicit transaction like `createProfile`'s — check the existing `renameProfile` body: if its single `db.run(..., true)` already auto-commits per-statement, run this second statement the same way, `true`, right after it, still inside the same `enqueueSerialized` closure so both are on the same serialized write-queue slot.)

- [ ] **Step 5: Test the sync through the real repository**

Add to `test/sqlite-repository-profile-crud.test.ts` (open it first — you already have its conventions from Task 1's sibling tests):

```ts
test("createProfile and renameProfile keep referenced_trainer mirrored", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const created = await repo.createProfile("Misty", "111122223333");
  let row = db.prepare("SELECT name, friend_code FROM referenced_trainer WHERE uuid = ?").get(created.id) as { name: string; friend_code: string | null };
  assert.equal(row.name, "Misty");
  assert.equal(row.friend_code, "111122223333");

  await repo.renameProfile(created.id, "Misty Waterflower", null);
  row = db.prepare("SELECT name, friend_code FROM referenced_trainer WHERE uuid = ?").get(created.id) as { name: string; friend_code: string | null };
  assert.equal(row.name, "Misty Waterflower");
  assert.equal(row.friend_code, null);
});
```

Run: `npx tsc -b && npm test`. Expected: passes, no regressions in the rest of the profile-CRUD suite.

- [ ] **Step 6: Commit**

```bash
git add src/data/referenced-trainer-sql.ts src/data/sqlite-repository.ts test/referenced-trainer-sql.test.ts test/sqlite-repository-profile-crud.test.ts
git commit -m "Mirror every real profile into referenced_trainer on create/rename"
```

---

### Task 3: Manual profile creation promotes a matching placeholder

**Files:**
- Modify: `src/data/sqlite-repository.ts`
- Test: `test/sqlite-repository-profile-crud.test.ts`

**Interfaces:**
- Consumes: `findReferencedTrainerByName`, `buildReferencedTrainerUpsert` (Task 2).
- Produces: `createProfile`'s new promotion behavior — no change to its public signature.

- [ ] **Step 1: Update `createProfile` to check for a matching placeholder first**

In `src/data/sqlite-repository.ts`, at the top of `createProfile` (before building `newProfile`), add:

```ts
  async function createProfile(username: string, friendCode: string | null): Promise<Profile> {
    const existingReferenced = await findReferencedTrainerByName(db, username);
    // Promote a placeholder (referenced_trainer row with no matching real
    // profile) instead of minting a fresh uuid -- if this name was ever
    // referenced as an original trainer or seen in an import before being
    // fully created, this device already has an identity for it. Real
    // profiles never collide here in practice (profile.id values are UUIDs),
    // so "already a real profile" can only mean two people manually chose
    // the same display name -- that's the "treat as separate" case: fall
    // through to minting a new uuid exactly as before.
    const isPlaceholder = existingReferenced && !profileBuckets.has(existingReferenced.uuid);
    const newProfile: Profile = {
      id: isPlaceholder ? existingReferenced!.uuid : crypto.randomUUID(),
      username,
      friendCode,
      createdAt: Date.now(),
    };
```

(This replaces the existing `const newProfile: Profile = { id: crypto.randomUUID(), username, friendCode, createdAt: Date.now() };` line — read the current function body first so the surrounding `newBucket` construction stays unchanged, only this one line and the new lookup above it change.)

- [ ] **Step 2: Test promotion**

Add to `test/sqlite-repository-profile-crud.test.ts`:

```ts
test("createProfile promotes a matching referenced_trainer placeholder instead of minting a new uuid", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const placeholderUuid = "22222222-2222-2222-2222-222222222222";
  db.exec(`INSERT INTO referenced_trainer (uuid, name, friend_code) VALUES ('${placeholderUuid}', 'Steve', NULL)`);

  const created = await repo.createProfile("Steve", null);
  assert.equal(created.id, placeholderUuid, "must reuse the placeholder's uuid, not mint a new one");

  const profiles = repo.listProfiles();
  assert.ok(profiles.some((p) => p.id === placeholderUuid));
});

test("createProfile mints a fresh uuid when the name matches an existing REAL profile", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const first = await repo.createProfile("Ash", null);
  const second = await repo.createProfile("Ash", null);
  assert.notEqual(first.id, second.id, "two real profiles sharing a name must stay distinct identities");
});
```

Run: `npx tsc -b && npm test`. Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/data/sqlite-repository.ts test/sqlite-repository-profile-crud.test.ts
git commit -m "createProfile promotes a matching referenced_trainer placeholder by uuid"
```

---

### Task 4: `pokemon_instance` identity + original-trainer fields

**Files:**
- Modify: `src/data/repository.ts`
- Modify: `src/data/sqlite-repository.ts`
- Modify: `src/features/collection/EditInstancePage.vue`
- Test: `test/create-pokemon-instances-dex-sync.test.ts` (or wherever `createPokemonInstances` is covered — check first), `test/update-pokemon-instance.test.ts`

**Interfaces:**
- Consumes: `findReferencedTrainerByName`, `buildReferencedTrainerUpsert` (Task 2).
- Produces: `PokemonInstance.uuid`/`originalTrainerName`/`originalTrainerId` populated on every create; `UpdatePokemonInstanceFields.originalTrainerName?: string` added.

- [ ] **Step 1: Populate identity fields in `createPokemonInstances`**

In `src/data/sqlite-repository.ts`'s `createPokemonInstances`, the `INSERT INTO pokemon_instance (...)` call needs three new columns. Change the SQL and params to include `uuid, original_trainer_name, original_trainer_id` (position them consistently with Task 1's migration column order), generating each row's own uuid and defaulting the original trainer to the current profile:

```ts
        for (let i = 0; i < batch.count; i++) {
          const uuid = crypto.randomUUID();
          await db.run(
            `INSERT INTO pokemon_instance (form_slug, profile_id, status, recorded_at, caught_at, updated_at, cp, iv_attack, iv_defense, iv_stamina, shiny, lucky, shadow, purified, dynamax, received_via_trade, nickname, background_slug, uuid, original_trainer_name, original_trainer_id)
             VALUES (?, ?, 'kept', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              batch.formSlug,
              state.profile.id,
              now,
              batch.caughtAt ?? null,
              now,
              batch.cp ?? null,
              batch.ivAttack ?? null,
              batch.ivDefense ?? null,
              batch.ivStamina ?? null,
              batch.shiny ? 1 : 0,
              batch.lucky ? 1 : 0,
              batch.shadow ? 1 : 0,
              batch.purified ? 1 : 0,
              batch.dynamax ? 1 : 0,
              batch.receivedViaTrade ? 1 : 0,
              batch.nickname ?? null,
              batch.backgroundSlug ?? null,
              uuid,
              state.profile.username,
              state.profile.id,
            ],
            false,
          );
          const idRow = (await db.query("SELECT last_insert_rowid() AS id")).values?.[0] as { id: number } | undefined;
          const id = idRow!.id;
          created.push({
            id,
            formSlug: batch.formSlug,
            profileId: state.profile.id,
            status: "kept",
            recordedAt: now,
            caughtAt: batch.caughtAt ?? null,
            updatedAt: now,
            cp: batch.cp ?? null,
            ivAttack: batch.ivAttack ?? null,
            ivDefense: batch.ivDefense ?? null,
            ivStamina: batch.ivStamina ?? null,
            ivPercent: computeIvPercent(batch.ivAttack ?? null, batch.ivDefense ?? null, batch.ivStamina ?? null),
            shiny: !!batch.shiny,
            lucky: !!batch.lucky,
            shadow: !!batch.shadow,
            purified: !!batch.purified,
            dynamax: !!batch.dynamax,
            receivedViaTrade: !!batch.receivedViaTrade,
            heartsEarned: null,
            currentMegaLevel: null,
            nickname: batch.nickname ?? null,
            backgroundSlug: batch.backgroundSlug ?? null,
            uuid,
            originalTrainerName: state.profile.username,
            originalTrainerId: state.profile.id,
          });
```

(Keep the rest of the loop — the `tagLinks` push — unchanged.)

- [ ] **Step 2: Add `originalTrainerName` to `UpdatePokemonInstanceFields` and wire the resolve-or-create lookup**

In `src/data/repository.ts`, add to `UpdatePokemonInstanceFields`:

```ts
  /** Free-typed; resolved against referenced_trainer by exact name match on save (a new name creates a new placeholder row) -- see updatePokemonInstance. */
  originalTrainerName?: string;
```

In `src/data/sqlite-repository.ts`, find `updatePokemonInstance` (the dynamic-column-list UPDATE mentioned in the comment you read near line 821-830). Before building the dynamic column list, add the resolve-or-create step when `fields.originalTrainerName` is present:

```ts
    let originalTrainerId: string | null | undefined;
    if (fields.originalTrainerName !== undefined) {
      const existing = await findReferencedTrainerByName(db, fields.originalTrainerName);
      if (existing) {
        originalTrainerId = existing.uuid;
      } else {
        originalTrainerId = crypto.randomUUID();
        const upsert = buildReferencedTrainerUpsert({ uuid: originalTrainerId, name: fields.originalTrainerName, friendCode: null });
        enqueueWrite(async () => {
          await db.run(upsert.sql, upsert.params, true);
          await persistDb();
        });
      }
    }
```

Then include `original_trainer_name`/`original_trainer_id` in the dynamic column list alongside the other fields whenever `fields.originalTrainerName !== undefined` (map `fields.originalTrainerName` to `original_trainer_name` and the resolved `originalTrainerId` to `original_trainer_id`, following whatever pattern the existing dynamic-column-builder in this function already uses for `nickname`/`cp`/etc. — read that code before editing so the new fields slot into the same list-building logic rather than a separate code path).

- [ ] **Step 3: Add the "Original Trainer" field to `EditInstancePage.vue`**

In `src/features/collection/EditInstancePage.vue`, add after the `const nickname = ref(...)` line:

```ts
const originalTrainerName = ref(instance?.originalTrainerName ?? "");
```

In the `save()` function's `fields` object, add:

```ts
      originalTrainerName: originalTrainerName.value.trim() || undefined,
```

(`undefined` — not empty string — so an empty field doesn't wipe a specimen's existing original trainer; leaving it untouched needs `undefined` to skip the update, matching how every other optional field in `UpdatePokemonInstanceFields` behaves. If the user needs to explicitly reset this in the future, that's a follow-on affordance not needed now.)

In the template's "Details" fieldset, add after the Nickname field:

```html
      <label class="field">Original Trainer<input type="text" v-model="originalTrainerName" /></label>
```

- [ ] **Step 4: Test the resolve-or-create behavior**

Open `test/update-pokemon-instance.test.ts` to see its existing setup pattern, then add:

```ts
test("updatePokemonInstance resolves originalTrainerName against referenced_trainer, creating a placeholder if new", async () => {
  // Follow this file's existing setup (DatabaseSync, REFERENCE_SCHEMA_SQL,
  // runPersonalMigrations/createSqliteRepository, seeding a species/form and
  // one pokemon_instance via createPokemonInstances) before this assertion block.
  await repo.updatePokemonInstance(instanceId, { originalTrainerName: "Gary" });
  const row = db.prepare("SELECT original_trainer_name, original_trainer_id FROM pokemon_instance WHERE id = ?").get(instanceId) as {
    original_trainer_name: string;
    original_trainer_id: string;
  };
  assert.equal(row.original_trainer_name, "Gary");
  const referenced = db.prepare("SELECT name FROM referenced_trainer WHERE uuid = ?").get(row.original_trainer_id) as { name: string } | undefined;
  assert.equal(referenced?.name, "Gary");

  // Second specimen naming the SAME trainer must resolve to the SAME uuid, not a new placeholder.
  const secondBatch = await repo.createPokemonInstances({ formSlug: "bulbasaur-base", count: 1 });
  await repo.updatePokemonInstance(secondBatch[0].id, { originalTrainerName: "Gary" });
  const secondRow = db.prepare("SELECT original_trainer_id FROM pokemon_instance WHERE id = ?").get(secondBatch[0].id) as { original_trainer_id: string };
  assert.equal(secondRow.original_trainer_id, row.original_trainer_id);
});
```

Run: `npx tsc -b && npm test`. Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/data/repository.ts src/data/sqlite-repository.ts src/features/collection/EditInstancePage.vue test/update-pokemon-instance.test.ts test/create-pokemon-instances-dex-sync.test.ts
git commit -m "Give every pokemon_instance a uuid and an editable original-trainer link"
```

---

### Task 5: Rename `released` → `transferred` across the UI

**Files:**
- Modify: `src/features/collection/CollectionPage.vue`
- Modify: `src/features/log-catch/LogCatchPage.vue`

**Interfaces:**
- Consumes: `PokemonInstanceStatus` (Task 1, already renamed at the type level).

- [ ] **Step 1: Update `CollectionPage.vue`**

Change `<option value="released">Released</option>` to `<option value="transferred">Transferred</option>`, and `@click="setStatus(row.instance.id, 'released')"` / its button label (`Release`) to `'transferred'` / `Transfer` — open the file and change both the value and the visible label together (grep the file for `released` first to make sure no other occurrence is missed).

- [ ] **Step 2: Update `LogCatchPage.vue`**

Change `async function quickAction(id: number, status: "traded" | "evolved" | "released")` to `"traded" | "evolved" | "transferred"`, and `@click="quickAction(inst.id, 'released')"` plus its button label to `'transferred'` / `Transfer`.

- [ ] **Step 3: Grep for any remaining occurrence**

```bash
grep -rn "'released'\|\"released\"\|>Released<\|>Release<" src/
```

Expected: no results (everything from Task 1 and this task's Steps 1-2 covers every occurrence). Fix any stragglers found.

- [ ] **Step 4: Run the full suite and commit**

```bash
npx tsc -b && npm test && npm run lint
```

```bash
git add src/features/collection/CollectionPage.vue src/features/log-catch/LogCatchPage.vue
git commit -m "Rename released status to transferred in Collection/Log-a-catch UI"
```

---

### Task 6: Tags become device-wide, not per-profile

**Files:**
- Modify: `src/data/in-memory-store.ts`
- Modify: `src/data/sqlite-repository.ts`
- Test: `test/tag-management.test.ts`

**Interfaces:**
- Consumes: `tag_name_unique` constraint (Task 1's migration already dropped the per-profile constraint and de-duplicated existing rows).
- Produces: `state.tags` sourced from a single shared list, never reassigned by `switchProfile`.

- [ ] **Step 1: Remove `tags` from `PersonalState`'s per-profile shape**

In `src/data/in-memory-store.ts`, find the `PersonalState` interface and remove its `tags: Tag[];` field (leave `pokemonInstanceTags` — that stays per-profile, it's about which specific caught instances carry which tags, unaffected by tags becoming a shared list). Check every place inside `in-memory-store.ts` that reads `state.tags` (there may be none directly, since Task 2's earlier read of `sqlite-repository.ts` showed `createTag`/`getTagUsageCounts`/`renameTag`/`deleteTag` are NOT part of `createInMemoryRepository`'s shared object — grep to confirm: `grep -n "state.tags" src/data/in-memory-store.ts`). If any exist, they need the same "read from a shared reference, not the bucket" treatment as Step 3 below.

- [ ] **Step 2: Load tags once, device-wide, in `sqlite-repository.ts`**

In `src/data/sqlite-repository.ts`, find `loadOneProfileState` (used to build each profile's bucket) — it currently queries `tag` scoped by `profile_id` (per the `const tags: Tag[] = [];` line you saw earlier). Remove that per-profile tag loading from `loadOneProfileState` entirely (and drop `tags` from whatever object it returns, since `PersonalState` no longer has that field after Step 1).

Add a new module-level (function-scoped inside `createSqliteRepository`, alongside `profileBuckets`) shared tags array, loaded once:

```ts
  let sharedTags: Tag[] = (await db.query("SELECT id, profile_id, name FROM tag", [])).values?.map((row) => {
    const r = row as Record<string, unknown>;
    return { id: r.id as number, profileId: r.profile_id as string, name: r.name as string };
  }) ?? [];
```

Place this near where `profileBuckets`/`currentProfileId` are established (right after the `loadAllProfiles` call), so it's available to every method defined below it in the same closure.

- [ ] **Step 3: Point every tag method at `sharedTags` instead of `state.tags`/bucket data**

In `createTag`, `getTagUsageCounts`, `renameTag`, `deleteTag` (all four are defined directly in `sqlite-repository.ts`'s returned object, per Task 2's earlier reading), replace every `state.tags` reference with `sharedTags`, and make sure each mutation (`sharedTags.push(...)`, `sharedTags[idx] = ...`, `sharedTags = sharedTags.filter(...)`) reassigns the outer `sharedTags` variable (it's a `let`, declared in Step 2) rather than relying on in-place mutation of an array some other closure might still reference.

`createTag`'s `INSERT INTO tag (profile_id, name)` can keep recording `state.profile.id` as an informational "who created this" value — it's no longer used for scoping or uniqueness (Task 1's migration already made the DB constraint device-wide), just kept for now per the design spec's "profileId stays on the tag row... not worth a bigger migration."

`getTagUsageCounts` also reads `state.pokemonInstanceTags` — that stays as `state.pokemonInstanceTags` unchanged (still per-profile, per Step 1's note), only its first argument (`state.tags` → `sharedTags`) changes.

- [ ] **Step 4: Remove `tags` from `createProfile`'s new-bucket construction and `reassignStateToBucket`**

In `createProfile`, remove the `tags: [],` line from `newBucket`'s object literal (that field no longer exists on `PersonalState`).

In `reassignStateToBucket`, remove the `state.tags = bucket.tags;` line entirely — tags are no longer part of what a profile switch repoints.

- [ ] **Step 5: Update `Repository.listTags()`'s call site if it reads `state` directly**

`listTags` isn't shown in the code you've read so far — grep for it (`grep -n "listTags" src/data/*.ts`) and confirm which file implements it. If it's inside `createInMemoryRepository`'s shared object and currently returns `state.tags`, it needs to move to `sqlite-repository.ts`'s own override (same treatment as `createTag`/etc.) returning `sharedTags` instead, since `state` no longer has a `tags` field at all after Step 1's interface change — TypeScript will fail to compile until every such reference is found and fixed. Run `npx tsc -b` after Steps 1-4 specifically to let the compiler enumerate any reference you missed, rather than relying on grep alone.

- [ ] **Step 6: Update `test/tag-management.test.ts` for global scope**

Open the file and read its existing tests (Task 10's earlier fix-round already touched this file's fixtures for the UUID conversion, per `progress.md`). Add a test confirming the new cross-profile behavior:

```ts
test("tags are visible across profiles, not scoped to the profile that created them", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const tag = await repo.createTag("shiny-candidates");
  const second = await repo.createProfile("Second", null);
  repo.switchProfile(second.id);

  const tagsOnSecond = repo.listTags();
  assert.ok(tagsOnSecond.some((t) => t.id === tag.id), "a tag created under the first profile must be visible after switching");
});

test("creating a tag with a name that already exists (any profile) returns the existing tag, never a duplicate", async () => {
  // Mirrors createTag's existing dedupe-by-name check, now against the
  // shared list rather than a per-profile one -- add this against whatever
  // setup this file's other tests already use.
});
```

Run: `npx tsc -b && npm test`. Expected: passes, and confirm no other test in this file regressed (some existing tests may have asserted profile-scoped tag isolation — if so, that assertion is now intentionally wrong per this task's design change; update it to reflect global tags rather than deleting the test outright, and note the change in your task report).

- [ ] **Step 7: Commit**

```bash
git add src/data/in-memory-store.ts src/data/sqlite-repository.ts test/tag-management.test.ts
git commit -m "Make tags device-wide instead of per-profile"
```

---

### Task 7: Export bundle — `TrainerExport`/`ExportBundle` + `exportTrainer`

**Files:**
- Modify: `src/data/repository.ts`
- Modify: `src/data/sqlite-repository.ts`
- Test: `test/sqlite-repository-trainer-export-import.test.ts` (new)

**Interfaces:**
- Consumes: `listReferencedTrainers` (Task 2), `profileBuckets` (already in `sqlite-repository.ts`), `sharedTags` (Task 6).
- Produces: `TrainerExport`, `ExportBundle` types; `Repository.exportTrainer(profileId: string): TrainerExport`.

- [ ] **Step 1: Add the new types to `src/data/repository.ts`**

Add after the `PersonalDataExport` interface:

```ts
// A single trainer's full export, tagged with its own identity so an
// importing device can tell WHOSE data this is and reconcile it against
// what it already knows -- see docs/superpowers/specs/2026-07-26-sub-project-7b-identity-and-merge-design.md
// section 5. Extends PersonalDataExport rather than duplicating its fields.
export interface TrainerExport extends PersonalDataExport {
  trainerUuid: string;
  trainerName: string;
  trainerFriendCode: string | null;
  /** This trainer's own referenced_trainer rows (real + placeholder) at export time -- carries placeholder identities along so an importing device gains them too. */
  referencedTrainers: { uuid: string; name: string; friendCode: string | null }[];
}

// The file format written by both "Export current" and "Export all
// trainers" -- always this shape, never a single bare PersonalDataExport,
// so import has exactly one code path regardless of how many trainers are
// in the file.
export interface ExportBundle {
  exportedAt: string;
  schemaVersion: number;
  trainers: TrainerExport[];
  tags: { name: string }[];
}
```

Add to the `Repository` interface, in the "Trainer/Profile page" section:

```ts
  /** One trainer's full export (see TrainerExport) -- works for ANY local profile, not just the current one, so "export all" can call this once per profile without switching. */
  exportTrainer(profileId: string): TrainerExport;
```

- [ ] **Step 2: Implement `exportTrainer` in `sqlite-repository.ts`**

Add to the returned object (alongside `exportPersonalData`'s existing override), reading from `profileBuckets` directly rather than the live `state` so it works for a non-current profile:

```ts
    exportTrainer(profileId: string): TrainerExport {
      const bucket = profileBuckets.get(profileId);
      if (!bucket) throw new Error(`Unknown profile: ${profileId}`);
      return {
        exportedAt: new Date().toISOString(),
        schemaVersion: CURRENT_PERSONAL_SCHEMA_VERSION,
        speciesPersonal: { ...bucket.speciesPersonal },
        formPersonal: { ...bucket.formPersonal },
        appSettings: { ...bucket.appSettings },
        megaPersonal: { ...bucket.megaPersonal },
        formBackgroundPersonal: [...bucket.formBackgroundPersonal],
        medalProgress: { ...bucket.medalProgress },
        pokemonInstances: [...bucket.pokemonInstances],
        playerProgress: bucket.playerProgress,
        playerProgressLog: [...bucket.playerProgressLog],
        trainerUuid: bucket.profile.id,
        trainerName: bucket.profile.username,
        trainerFriendCode: bucket.profile.friendCode,
        referencedTrainers: [], // filled in by the caller building the ExportBundle -- see buildExportBundle in Task 9, which fetches the device-wide list ONCE and attaches it to every trainer rather than re-querying per trainer.
      };
    },
```

Note: `TrainerExport extends PersonalDataExport`, but `PersonalDataExport.tags` is no longer meaningful per-trainer now that tags are global (Task 6) — omit `tags` from this per-trainer object entirely (it's `?:` optional on the base interface, so leaving it out is valid) and rely on `ExportBundle.tags` (device-wide) instead, populated once in Task 9's bundle builder.

- [ ] **Step 3: Test `exportTrainer` against a non-current profile**

Create `test/sqlite-repository-trainer-export-import.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { createSqliteRepository } from "../src/data/sqlite-repository";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";

test("exportTrainer exports a non-current profile's data without switching to it", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const original = repo.getCurrentProfile();
  const second = await repo.createProfile("Second", "999988887777");
  repo.switchProfile(second.id);
  repo.setSpeciesPersonalField("bulbasaur", "registered", true);
  repo.switchProfile(original.id);

  // Exporting "second" while "original" is current must reflect second's own data.
  const exported = repo.exportTrainer(second.id);
  assert.equal(exported.trainerUuid, second.id);
  assert.equal(exported.trainerName, "Second");
  assert.equal(exported.trainerFriendCode, "999988887777");
  assert.equal(exported.speciesPersonal.bulbasaur?.registered, true);
  assert.equal(repo.getCurrentProfile().id, original.id, "exporting must not switch the current profile");
});
```

Run: `npx tsc -b && npm test`. Expected: passes. (If `bulbasaur` isn't present in this test DB's reference data, seed it the same way `sqlite-repository-profile-crud.test.ts`'s tests do — check whether `REFERENCE_SCHEMA_SQL`/`createSqliteRepository` already bundles real reference data or an empty schema; match whatever the sibling test file relies on.)

- [ ] **Step 4: Commit**

```bash
git add src/data/repository.ts src/data/sqlite-repository.ts test/sqlite-repository-trainer-export-import.test.ts
git commit -m "Add exportTrainer for exporting any local profile's data as a TrainerExport"
```

---

### Task 8: Reconciliation decision function + UUID rewrite sweep

**Files:**
- Create: `src/data/trainer-reconciliation.ts`
- Test: `test/trainer-reconciliation.test.ts`

**Interfaces:**
- Consumes: `Profile`, `ReferencedTrainer` (Task 1).
- Produces: `reconcileTrainer(candidate, localProfiles, localReferencedTrainers): ReconciliationDecision`; `buildRewriteTrainerUuidStatements(oldUuid, newUuid): SqlStatement[]`.

- [ ] **Step 1: Write the pure reconciliation decision function**

Create `src/data/trainer-reconciliation.ts`:

```ts
// Pure decision logic for "is this incoming trainer someone we already
// know?" -- see docs/superpowers/specs/2026-07-26-sub-project-7b-identity-and-merge-design.md
// section 4.3. Deliberately has no I/O: the caller (sqlite-repository.ts's
// planTrainerImport, or createProfile's promotion check) supplies the
// already-loaded local profiles/referenced_trainer rows, and this function
// returns a decision the caller executes (or, for "ask", surfaces to the
// user before calling back in with the answer).

import type { Profile, ReferencedTrainer } from "../db/types";

export interface TrainerCandidate {
  uuid: string;
  name: string;
  friendCode: string | null;
}

export type ReconciliationDecision =
  | { kind: "new" }
  | { kind: "promote"; placeholderUuid: string }
  | { kind: "auto-merge"; localProfileId: string }
  | { kind: "definitely-separate" }
  | { kind: "ask-merge-or-separate"; localProfileId: string };

export function reconcileTrainer(
  candidate: TrainerCandidate,
  localProfiles: Profile[],
  localReferencedTrainers: ReferencedTrainer[],
): ReconciliationDecision {
  // 1. Friend code, both sides present: definitive, no name check needed.
  if (candidate.friendCode) {
    const friendCodeMatch = localProfiles.find((p) => p.friendCode && p.friendCode === candidate.friendCode);
    if (friendCodeMatch) return { kind: "auto-merge", localProfileId: friendCodeMatch.id };
    const friendCodeConflict = localProfiles.find((p) => p.friendCode && p.friendCode !== candidate.friendCode && p.username === candidate.name);
    if (friendCodeConflict) return { kind: "definitely-separate" };
  }

  // 2. Name match against the complete registry (real profiles + placeholders).
  const nameMatch = localReferencedTrainers.find((t) => t.name === candidate.name);
  if (!nameMatch) return { kind: "new" };

  const matchedProfile = localProfiles.find((p) => p.id === nameMatch.uuid);
  if (!matchedProfile) return { kind: "promote", placeholderUuid: nameMatch.uuid };

  // A real profile matched by name: if both sides carry a friend code and
  // they differ, that's decisive even though we already checked friend
  // codes above (this covers the case where the name-matched profile's
  // friend code differs from the candidate's, which step 1 doesn't reach
  // when there's no local profile whose friend code equals the candidate's).
  if (candidate.friendCode && matchedProfile.friendCode && candidate.friendCode !== matchedProfile.friendCode) {
    return { kind: "definitely-separate" };
  }
  return { kind: "ask-merge-or-separate", localProfileId: matchedProfile.id };
}
```

- [ ] **Step 2: Write the UUID rewrite statement builder**

In the same file, add:

```ts
import type { SqlStatement } from "./profile-scoped-write-sql";

// Sweeps every reference to `oldUuid` (a locally-minted uuid -- either a
// placeholder being promoted, or a local profile being merged into an
// imported one) onto `newUuid` (the INCOMING uuid, which always wins -- see
// design spec section 4.3). Covers every profile-scoped table's profile_id
// (same table list as profile-management-sql.ts's buildProfileDeleteStatements,
// since these are the same tables that could carry oldUuid), PLUS every
// pokemon_instance.original_trainer_id across the WHOLE device (not scoped to
// oldUuid's own rows -- a DIFFERENT profile's specimen may have named oldUuid's
// trainer as its original trainer), PLUS the referenced_trainer row itself.
export function buildRewriteTrainerUuidStatements(oldUuid: string, newUuid: string): SqlStatement[] {
  const profileScopedTables = [
    "pokemon_instance",
    "species_personal",
    "form_personal",
    "mega_personal",
    "form_background_personal",
    "app_settings",
    "player_progress_personal",
    "player_progress_log",
    "medal_progress_personal",
  ];
  return [
    ...profileScopedTables.map((table) => ({
      sql: `UPDATE ${table} SET profile_id = ? WHERE profile_id = ?`,
      params: [newUuid, oldUuid],
    })),
    { sql: "UPDATE profile SET id = ? WHERE id = ?", params: [newUuid, oldUuid] },
    { sql: "UPDATE pokemon_instance SET original_trainer_id = ? WHERE original_trainer_id = ?", params: [newUuid, oldUuid] },
    {
      sql: "INSERT INTO referenced_trainer (uuid, name, friend_code) VALUES (?, (SELECT name FROM referenced_trainer WHERE uuid = ?), (SELECT friend_code FROM referenced_trainer WHERE uuid = ?)) ON CONFLICT(uuid) DO NOTHING",
      params: [newUuid, oldUuid, oldUuid],
    },
    { sql: "DELETE FROM referenced_trainer WHERE uuid = ?", params: [oldUuid] },
  ];
}
```

Note: when `oldUuid` belongs to a placeholder (no `profile` row), the `UPDATE profile SET id = ...` statement affects zero rows — harmless. When it belongs to a real local profile being merged, this rewrites that profile's own id in place (SQLite allows updating a `TEXT PRIMARY KEY`); run these statements with `PRAGMA defer_foreign_keys = true` in the same transaction, identical to `buildDeleteProfileStatements`'s existing convention, since child rows are updated before/independently of the parent `profile.id` change and FK enforcement mid-transaction would otherwise reject the momentarily-mismatched rows.

- [ ] **Step 3: Test the decision function's every branch**

Create `test/trainer-reconciliation.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileTrainer } from "../src/data/trainer-reconciliation";
import type { Profile, ReferencedTrainer } from "../src/db/types";

const localProfiles: Profile[] = [
  { id: "p1", username: "Ash", friendCode: "111111111111", createdAt: 0 },
  { id: "p2", username: "Misty", friendCode: null, createdAt: 0 },
];
const localReferencedTrainers: ReferencedTrainer[] = [
  { uuid: "p1", name: "Ash", friendCode: "111111111111" },
  { uuid: "p2", name: "Misty", friendCode: null },
  { uuid: "placeholder-1", name: "Steve", friendCode: null },
];

test("matching friend code auto-merges regardless of name", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Ash the Great", friendCode: "111111111111" }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "auto-merge", localProfileId: "p1" });
});

test("different friend codes with the same name are definitely separate, no prompt", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Ash", friendCode: "222222222222" }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "definitely-separate" });
});

test("name match against a placeholder promotes it", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Steve", friendCode: null }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "promote", placeholderUuid: "placeholder-1" });
});

test("name match against a real profile with no friend code signal asks the user", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Misty", friendCode: null }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "ask-merge-or-separate", localProfileId: "p2" });
});

test("no name or friend code match is a brand new trainer", () => {
  const decision = reconcileTrainer({ uuid: "incoming", name: "Brock", friendCode: null }, localProfiles, localReferencedTrainers);
  assert.deepEqual(decision, { kind: "new" });
});
```

Run: `npx tsc -b && npm test`. Expected: all five pass.

- [ ] **Step 4: Test the rewrite-statement builder against real SQLite**

Add to `test/sqlite-repository-trainer-export-import.test.ts` (from Task 7):

```ts
test("buildRewriteTrainerUuidStatements sweeps profile_id, original_trainer_id, and the referenced_trainer row itself", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  const repo = await createSqliteRepository(undefined, conn);

  const oldUuid = repo.getCurrentProfile().id;
  const newUuid = "88888888-8888-8888-8888-888888888888";
  // A different profile's specimen names oldUuid as its original trainer.
  const other = await repo.createProfile("Other", null);
  repo.switchProfile(other.id);
  const [instance] = await repo.createPokemonInstances({ formSlug: "bulbasaur-base", count: 1 });
  db.exec(`UPDATE pokemon_instance SET original_trainer_id = '${oldUuid}' WHERE id = ${instance.id}`);
  repo.switchProfile(oldUuid);

  db.exec("PRAGMA defer_foreign_keys = true;");
  for (const { sql, params } of buildRewriteTrainerUuidStatements(oldUuid, newUuid)) {
    db.prepare(sql).run(...(params as never[]));
  }

  const profileRow = db.prepare("SELECT id FROM profile WHERE id = ?").get(newUuid) as { id: string } | undefined;
  assert.ok(profileRow, "profile.id must be rewritten to the incoming uuid");
  const originalTrainerRow = db.prepare("SELECT original_trainer_id FROM pokemon_instance WHERE id = ?").get(instance.id) as { original_trainer_id: string };
  assert.equal(originalTrainerRow.original_trainer_id, newUuid, "a DIFFERENT profile's specimen referencing the old uuid must be swept too");
  const oldReferenced = db.prepare("SELECT uuid FROM referenced_trainer WHERE uuid = ?").get(oldUuid) as { uuid: string } | undefined;
  assert.equal(oldReferenced, undefined, "the old uuid's referenced_trainer row must be gone");
  const newReferenced = db.prepare("SELECT uuid FROM referenced_trainer WHERE uuid = ?").get(newUuid) as { uuid: string } | undefined;
  assert.ok(newReferenced, "the new uuid must have a referenced_trainer row");
});
```

(Seed `bulbasaur-base` the same way Task 7's test did, or check whichever fixture helper the surrounding test file already uses.) Run: `npx tsc -b && npm test`. Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add src/data/trainer-reconciliation.ts test/trainer-reconciliation.test.ts test/sqlite-repository-trainer-export-import.test.ts
git commit -m "Add pure trainer-reconciliation decision logic and the uuid-rewrite sweep"
```

---

### Task 9: Wire import/export end-to-end (repository methods + Settings UI)

**Files:**
- Modify: `src/data/repository.ts`
- Modify: `src/data/sqlite-repository.ts`
- Modify: `src/features/settings/personal-data-transfer.ts`
- Modify: `src/features/settings/SettingsPage.vue`
- Modify: `docs/data-model.md`
- Test: `test/sqlite-repository-trainer-export-import.test.ts`

**Interfaces:**
- Consumes: `exportTrainer` (Task 7), `reconcileTrainer`/`buildRewriteTrainerUuidStatements` (Task 8), `listReferencedTrainers` (Task 2), `importPersonalData` (existing, unchanged).
- Produces: `Repository.planTrainerImport(bundle: ExportBundle): Promise<TrainerImportPlan>`, `Repository.applyTrainerImport(bundle: ExportBundle, resolutions: Record<string, "merge" | "separate">): Promise<TrainerImportSummary>`.

- [ ] **Step 1: Add the plan/apply types and methods to `src/data/repository.ts`**

```ts
export interface TrainerImportPlanEntry {
  trainerUuid: string;
  trainerName: string;
  decision: import("./trainer-reconciliation").ReconciliationDecision;
}

export interface TrainerImportPlan {
  entries: TrainerImportPlanEntry[];
}

export interface TrainerImportSummary {
  merged: number;
  promoted: number;
  created: number;
  separate: number;
}
```

Add to the `Repository` interface:

```ts
  /** Runs reconcileTrainer for every trainer in the bundle against this device's current profiles/referenced_trainer -- read-only, no writes. The UI shows any "ask-merge-or-separate" entries to the user before calling applyTrainerImport with their answers. */
  planTrainerImport(bundle: ExportBundle): Promise<TrainerImportPlan>;
  /** Executes the plan: "new"/"promote" create or promote a profile then merge via importPersonalData; "auto-merge" and "merge"-resolved "ask" entries run the uuid rewrite (buildRewriteTrainerUuidStatements) then importPersonalData; "definitely-separate" and "separate"-resolved entries create a new independent profile. `resolutions` is keyed by trainerUuid, required only for entries whose plan decision was "ask-merge-or-separate". */
  applyTrainerImport(bundle: ExportBundle, resolutions: Record<string, "merge" | "separate">): Promise<TrainerImportSummary>;
```

- [ ] **Step 2: Implement `planTrainerImport` in `sqlite-repository.ts`**

```ts
    async planTrainerImport(bundle: ExportBundle): Promise<TrainerImportPlan> {
      const localProfiles = listProfiles();
      const localReferencedTrainers = await listReferencedTrainers(db);
      return {
        entries: bundle.trainers.map((trainer) => ({
          trainerUuid: trainer.trainerUuid,
          trainerName: trainer.trainerName,
          decision: reconcileTrainer(
            { uuid: trainer.trainerUuid, name: trainer.trainerName, friendCode: trainer.trainerFriendCode },
            localProfiles,
            localReferencedTrainers,
          ),
        })),
      };
    },
```

- [ ] **Step 3: Implement `applyTrainerImport` in `sqlite-repository.ts`**

```ts
    async applyTrainerImport(bundle: ExportBundle, resolutions: Record<string, "merge" | "separate">): Promise<TrainerImportSummary> {
      const summary: TrainerImportSummary = { merged: 0, promoted: 0, created: 0, separate: 0 };
      const localProfiles = listProfiles();
      const localReferencedTrainers = await listReferencedTrainers(db);

      for (const trainer of bundle.trainers) {
        const decision = reconcileTrainer(
          { uuid: trainer.trainerUuid, name: trainer.trainerName, friendCode: trainer.trainerFriendCode },
          localProfiles,
          localReferencedTrainers,
        );
        const resolvedKind =
          decision.kind === "ask-merge-or-separate" ? (resolutions[trainer.trainerUuid] ?? "separate") : decision.kind;

        if (resolvedKind === "new" || resolvedKind === "definitely-separate" || resolvedKind === "separate") {
          const created = await createProfile(trainer.trainerName, trainer.trainerFriendCode);
          const targetState = profileBuckets.get(created.id)!;
          await mergeTrainerExportIntoBucket(trainer, targetState, created.id);
          summary.created++;
          continue;
        }

        if (decision.kind === "promote") {
          await enqueueSerialized(async () => {
            await db.beginTransaction();
            try {
              await db.run("PRAGMA defer_foreign_keys = true", [], false);
              for (const { sql, params } of buildRewriteTrainerUuidStatements(decision.placeholderUuid, trainer.trainerUuid)) {
                await db.run(sql, params, false);
              }
              await db.run("INSERT INTO profile (id, username, friend_code, is_current, created_at) VALUES (?, ?, ?, 0, ?)", [
                trainer.trainerUuid,
                trainer.trainerName,
                trainer.trainerFriendCode,
                Date.now(),
              ], false);
              const referencedUpsert = buildReferencedTrainerUpsert({ uuid: trainer.trainerUuid, name: trainer.trainerName, friendCode: trainer.trainerFriendCode });
              await db.run(referencedUpsert.sql, referencedUpsert.params, false);
              await db.commitTransaction();
            } catch (err) {
              await db.rollbackTransaction();
              throw err;
            }
            await persistDb();
          });
          const { buckets } = await loadAllProfiles(db);
          const targetState = buckets.get(trainer.trainerUuid)!;
          profileBuckets.set(trainer.trainerUuid, targetState);
          await mergeTrainerExportIntoBucket(trainer, targetState, trainer.trainerUuid);
          summary.promoted++;
          continue;
        }

        // "auto-merge", or "merge"-resolved "ask-merge-or-separate":
        const localProfileId = decision.kind === "auto-merge" ? decision.localProfileId : (decision as { localProfileId: string }).localProfileId;
        if (localProfileId !== trainer.trainerUuid) {
          await enqueueSerialized(async () => {
            await db.beginTransaction();
            try {
              await db.run("PRAGMA defer_foreign_keys = true", [], false);
              for (const { sql, params } of buildRewriteTrainerUuidStatements(localProfileId, trainer.trainerUuid)) {
                await db.run(sql, params, false);
              }
              await db.commitTransaction();
            } catch (err) {
              await db.rollbackTransaction();
              throw err;
            }
            await persistDb();
          });
          const bucket = profileBuckets.get(localProfileId)!;
          profileBuckets.delete(localProfileId);
          bucket.profile = { ...bucket.profile, id: trainer.trainerUuid };
          profileBuckets.set(trainer.trainerUuid, bucket);
          if (state.profile.id === localProfileId) state.profile = bucket.profile;
        }
        const targetState = profileBuckets.get(trainer.trainerUuid)!;
        await mergeTrainerExportIntoBucket(trainer, targetState, trainer.trainerUuid);
        summary.merged++;
      }

      for (const referenced of bundle.trainers.flatMap((t) => t.referencedTrainers)) {
        const upsert = buildReferencedTrainerUpsert(referenced);
        await db.run(upsert.sql, upsert.params, true);
      }
      for (const tagRow of bundle.tags) {
        const exists = sharedTags.some((t) => t.name === tagRow.name);
        if (!exists) await createTag(tagRow.name);
      }
      await persistDb();
      return summary;
    },
```

Add a small helper above the returned object (this is the "run `importPersonalData`'s existing per-row merge against a specific, possibly-non-current bucket" primitive every branch above needs — write it once rather than duplicating the merge loop):

```ts
  async function mergeTrainerExportIntoBucket(trainer: TrainerExport, targetState: PersonalState, targetProfileId: string): Promise<void> {
    const wasCurrent = state.profile.id === targetProfileId;
    if (!wasCurrent) reassignStateToBucket(targetState);
    await runBulk(async () => {
      await repo.importPersonalData(trainer);
    });
    if (!wasCurrent) {
      const originalBucket = [...profileBuckets.values()].find((b) => b.profile.id === (wasCurrent ? targetProfileId : state.profile.id));
      // Restore whichever profile was actually current before this call, by id, not by re-deriving from a stale reference.
    }
  }
```

This helper as sketched has a real gap: after merging into a non-current target, `state` must be pointed back at whatever profile was current before this whole `applyTrainerImport` call began, not left on the last-merged trainer. Fix it by capturing the true original current profile ONCE at the top of `applyTrainerImport` (before the `for` loop) and restoring it with `reassignStateToBucket` after the loop ends, rather than trying to restore per-call inside the helper — rewrite `mergeTrainerExportIntoBucket` to just do the reassign-and-merge (drop the restore attempt above), and add this to `applyTrainerImport`:

```ts
    async applyTrainerImport(bundle: ExportBundle, resolutions: Record<string, "merge" | "separate">): Promise<TrainerImportSummary> {
      const originalCurrentProfileId = state.profile.id;
      // ... existing body from above, with mergeTrainerExportIntoBucket simplified to:
      //   if (!wasCurrent) reassignStateToBucket(targetState);
      //   await runBulk(async () => { await repo.importPersonalData(trainer); });
      // ... at the very end, before `return summary;`:
      const originalBucket = profileBuckets.get(originalCurrentProfileId);
      if (originalBucket && state.profile.id !== originalCurrentProfileId) reassignStateToBucket(originalBucket);
      return summary;
    },
```

Merge this correction into the Step 3 code above before committing — the version you write to the file must restore the true original current profile at the end, not the version with the unresolved gap shown first for explanation.

- [ ] **Step 4: Build the export/import file-transfer helpers**

In `src/features/settings/personal-data-transfer.ts`, add:

```ts
export function buildExportBundle(repo: Repository, profileIds: string[]): ExportBundle {
  const referencedTrainers = /* fetched once and attached to every trainer -- since Repository has no direct listReferencedTrainers method, add one: */ repo.exportTrainer(profileIds[0]).referencedTrainers;
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: CURRENT_PERSONAL_SCHEMA_VERSION,
    trainers: profileIds.map((id) => ({ ...repo.exportTrainer(id), referencedTrainers })),
    tags: repo.listTags().map((t) => ({ name: t.name })),
  };
}
```

This needs `Repository.listReferencedTrainers(): { uuid: string; name: string; friendCode: string | null }[]` as a real public method rather than the placeholder-ish reuse of `exportTrainer`'s side channel above — go back and add it properly: in `src/data/repository.ts`, add `listReferencedTrainers(): { uuid: string; name: string; friendCode: string | null }[];` to the `Repository` interface; in `sqlite-repository.ts`, implement it as a synchronous wrapper that returns a cached copy loaded at boot (mirroring how `sharedTags` is loaded once in Task 6 — add a `let sharedReferencedTrainers = await listReferencedTrainers(db);` right next to `sharedTags`'s loading, and expose `listReferencedTrainers: () => sharedReferencedTrainers` — but keep it fresh: everywhere this plan's earlier steps insert/update a `referenced_trainer` row, also update `sharedReferencedTrainers` in place, the same discipline `sharedTags` already follows). Rewrite `buildExportBundle` to:

```ts
export function buildExportBundle(repo: Repository, profileIds: string[]): ExportBundle {
  const referencedTrainers = repo.listReferencedTrainers();
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: CURRENT_PERSONAL_SCHEMA_VERSION,
    trainers: profileIds.map((id) => ({ ...repo.exportTrainer(id), referencedTrainers })),
    tags: repo.listTags().map((t) => ({ name: t.name })),
  };
}

export async function readExportBundleFile(file: File): Promise<{ bundle: ExportBundle; schemaMismatch: boolean }> {
  const text = await file.text();
  const bundle = JSON.parse(text) as ExportBundle;
  if (typeof bundle.schemaVersion !== "number" || !Array.isArray(bundle.trainers)) {
    throw new Error("This doesn't look like a GoBuddy trainer-export bundle.");
  }
  return { bundle, schemaMismatch: bundle.schemaVersion !== CURRENT_PERSONAL_SCHEMA_VERSION };
}
```

(Go back and thread `listReferencedTrainers`/`sharedReferencedTrainers` through Task 2/Task 9's earlier steps consistently — every place that calls `buildReferencedTrainerUpsert` and writes it to the DB in this plan's prior tasks should also keep `sharedReferencedTrainers` in sync the same way `sharedTags` is kept in sync in Task 6, so this final read-heavy method never returns stale data. Since this dependency was only discovered while wiring the UI, apply it retroactively across `createProfile`, `renameProfile`, `applyTrainerImport`, and `updatePokemonInstance`'s resolve-or-create path — anywhere this plan's earlier tasks call `buildReferencedTrainerUpsert`.)

- [ ] **Step 5: Wire the Settings UI**

In `src/features/settings/SettingsPage.vue`, change the single "Export personal data" button into two:

```html
    <button type="button" @click="onExportCurrent">Export current trainer</button>
    <button type="button" @click="onExportAll">Export all trainers</button>
```

Add the corresponding script functions (replacing the old `onExport`):

```ts
async function onExportCurrent() {
  status.value = "Exporting…";
  try {
    const bundle = buildExportBundle(props.repo, [props.repo.getCurrentProfile().id]);
    await downloadTextFile(JSON.stringify(bundle, null, 2), {
      suggestedName: `gobuddy-export-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      mimeType: "application/json",
      description: "GoBuddy export",
    });
    status.value = "Exported.";
  } catch (err) {
    status.value = `Export failed: ${(err as Error).message}`;
  }
}

async function onExportAll() {
  status.value = "Exporting…";
  try {
    const bundle = buildExportBundle(props.repo, props.repo.listProfiles().map((p) => p.id));
    await downloadTextFile(JSON.stringify(bundle, null, 2), {
      suggestedName: `gobuddy-export-all-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      mimeType: "application/json",
      description: "GoBuddy export (all trainers)",
    });
    status.value = "Exported.";
  } catch (err) {
    status.value = `Export failed: ${(err as Error).message}`;
  }
}
```

Import `buildExportBundle`, `downloadTextFile`, and `readExportBundleFile` at the top of the `<script setup>` block (check existing imports — `downloadTextFile` already comes from `../../shared/file-download` per `personal-data-transfer.ts`'s own import; import it directly here too, or re-export it from `personal-data-transfer.ts` to keep `SettingsPage.vue`'s import list matching its existing single-source-of-truth pattern for this file — read the existing import line for `exportPersonalData`/`readPersonalDataFile` and follow the same sourcing).

Update `onImportFileChange` to use the bundle format and reconciliation:

```ts
async function onImportFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    const { bundle, schemaMismatch } = await readExportBundleFile(file);
    if (schemaMismatch) {
      const proceed = window.confirm(
        `This export is from schema version ${bundle.schemaVersion}, but this app is on version ${CURRENT_PERSONAL_SCHEMA_VERSION}. Some fields may not match. Import anyway?`,
      );
      if (!proceed) return;
    }

    const plan = await props.repo.planTrainerImport(bundle);
    const resolutions: Record<string, "merge" | "separate"> = {};
    for (const entry of plan.entries) {
      if (entry.decision.kind !== "ask-merge-or-separate") continue;
      const merge = window.confirm(
        `"${entry.trainerName}" matches an existing local trainer with the same name. Merge them as one trainer? (Cancel treats them as two separate trainers.)`,
      );
      resolutions[entry.trainerUuid] = merge ? "merge" : "separate";
    }

    if (backupBeforeImport.value) {
      status.value = "Saving a backup of your current data first…";
      await onExportAll();
    }

    status.value = "Importing…";
    const summary = await props.repo.applyTrainerImport(bundle, resolutions);
    status.value = `Imported: ${summary.merged} merged, ${summary.promoted} promoted, ${summary.created} created as new, ${summary.separate} kept separate.`;
  } catch (err) {
    status.value = `Import failed: ${(err as Error).message}`;
  }
}
```

Remove the old `exportPersonalData`/`readPersonalDataFile` import if nothing else in the file still uses them (grep the file first).

- [ ] **Step 6: End-to-end test**

Add to `test/sqlite-repository-trainer-export-import.test.ts`:

```ts
test("planTrainerImport + applyTrainerImport merges two devices' data for the same trainer via matching friend codes", async () => {
  const dbA = new DatabaseSync(":memory:");
  dbA.exec("PRAGMA foreign_keys = ON;");
  dbA.exec(REFERENCE_SCHEMA_SQL);
  const repoA = await createSqliteRepository(undefined, nodeSqliteConnection(dbA));
  await repoA.renameProfile(repoA.getCurrentProfile().id, "Ash", "111122223333");
  repoA.setSpeciesPersonalField("bulbasaur", "registered", true);

  const dbB = new DatabaseSync(":memory:");
  dbB.exec("PRAGMA foreign_keys = ON;");
  dbB.exec(REFERENCE_SCHEMA_SQL);
  const repoB = await createSqliteRepository(undefined, nodeSqliteConnection(dbB));
  await repoB.renameProfile(repoB.getCurrentProfile().id, "Ash Ketchum", "111122223333");
  repoB.setSpeciesPersonalField("charmander", "registered", true);

  const bundleFromA = buildExportBundle(repoA, [repoA.getCurrentProfile().id]);
  const plan = await repoB.planTrainerImport(bundleFromA);
  assert.equal(plan.entries[0].decision.kind, "auto-merge");

  const summary = await repoB.applyTrainerImport(bundleFromA, {});
  assert.equal(summary.merged, 1);
  assert.equal(repoB.getSpeciesWithForms("bulbasaur").personal.registered, true, "B must gain A's data");
  assert.equal(repoB.getSpeciesWithForms("charmander").personal.registered, true, "B must keep its own data");
});
```

(Seed `charmander` the same way `bulbasaur` is seeded in earlier tests if this test's DB doesn't already have real bundled reference data — check what `REFERENCE_SCHEMA_SQL`/`createSqliteRepository` actually load in this test file before assuming both species already exist.) Run: `npx tsc -b && npm test`. Expected: passes.

- [ ] **Step 7: Update `docs/data-model.md`**

Open the file's migration-history section (where `0004`'s writeup lives, per the file structure you read during Task 1) and add a matching entry for `0005`, following that section's exact style: what changed, why, and a pointer to this design spec and this plan.

- [ ] **Step 8: Full-suite verification**

```bash
npx tsc -b && npm test && npm run lint && npx vite build
```

Expected: all clean, a real `dist/` build succeeds. Fix anything broken before proceeding — this is the final task, so nothing should be left in a documented-but-unresolved state the way Task 10 of Sub-project 7a found (see `progress.md`'s precedent for why this matters).

- [ ] **Step 9: Commit**

```bash
git add src/data/repository.ts src/data/sqlite-repository.ts src/features/settings/personal-data-transfer.ts src/features/settings/SettingsPage.vue docs/data-model.md test/sqlite-repository-trainer-export-import.test.ts
git commit -m "Wire trainer export/import bundles end-to-end with reconciliation UI"
```

---

### Task 10: Actually merge `pokemon_instance` (and its tag links) by uuid on import

**Added after Task 9's review surfaced a real gap: every prior task built the *prerequisite* for merging `pokemon_instance` (a stable uuid) but none of them ever wrote the merge rule itself.** `importPersonalData` still has the pre-7b comment explaining why specimens are excluded from merge — that comment is now stale (the uuid this task was FOR now exists) but the code was never updated to use it. Design spec §3.1's "closing gap 1 directly" sentence was never implemented. This task closes it. It also fixes a second, related gap found during scoping: `PersonalDataExport`/`TrainerExport` never carried `pokemon_instance_tag` links at all — fixing only import without this would still lose every specimen's tags on a merge.

**Files:**
- Modify: `src/data/repository.ts`
- Modify: `src/data/in-memory-store.ts`
- Modify: `src/data/sqlite-repository.ts`
- Test: `test/sqlite-repository-trainer-export-import.test.ts`

**Interfaces:**
- Consumes: `createTag` (Task 6, get-or-create by name), the existing `importPersonalData`/`exportPersonalData`/`exportTrainer` (Task 7).
- Produces: `PersonalDataExport.pokemonInstanceTagNames?: { instanceUuid: string; tagName: string }[]`; real uuid-keyed merge behavior for `pokemon_instance`.

- [ ] **Step 1: Add a flat, id-free join field to the export shape**

`pokemon_instance_tag` links use `pokemon_instance.id`/`tag.id` — both locally-meaningless integers on any OTHER device, the exact same footgun `pokemonInstances`/old `tags` already had. Since specimens now have a `uuid` and tags are matched by name (device-wide, per Task 6), the natural cross-device join representation is `(specimen uuid, tag name)` pairs, not the two integer id spaces.

In `src/data/repository.ts`, add to `PersonalDataExport` (immediately after the existing `tags?: Tag[];` field):

```ts
  /** Specimen-to-tag links as a flat, id-free join (specimen uuid + tag name) -- pokemon_instance.id/tag.id are both locally-meaningless on another device, same reasoning as pokemonInstances/tags above. Always populated going forward; optional only for reading older exports that predate it. */
  pokemonInstanceTagNames?: { instanceUuid: string; tagName: string }[];
```

- [ ] **Step 2: Populate it on export**

In `src/data/in-memory-store.ts`'s `exportPersonalData()`, add (building the flat list from `state.pokemonInstanceTags` + `state.pokemonInstances` + the shared tag list):

```ts
        pokemonInstanceTagNames: state.pokemonInstanceTags
          .map((link) => {
            const instance = state.pokemonInstances.find((i) => i.id === link.pokemonInstanceId);
            const tag = getSharedTags().find((t) => t.id === link.tagId);
            return instance && tag ? { instanceUuid: instance.uuid, tagName: tag.name } : undefined;
          })
          .filter((x): x is { instanceUuid: string; tagName: string } => x !== undefined),
```

(Read the function's current return object first — this slots in alongside the existing `tags: [...getSharedTags()],` line, same style.)

In `src/data/sqlite-repository.ts`'s `exportTrainer(profileId)` (Task 7), add the equivalent, sourced from `bucket.pokemonInstanceTags`/`bucket.pokemonInstances` and the module's `sharedTags` binding (not `getSharedTags()`, since this function isn't inside `createInMemoryRepository`'s closure):

```ts
        pokemonInstanceTagNames: bucket.pokemonInstanceTags
          .map((link) => {
            const instance = bucket.pokemonInstances.find((i) => i.id === link.pokemonInstanceId);
            const tag = sharedTags.find((t) => t.id === link.tagId);
            return instance && tag ? { instanceUuid: instance.uuid, tagName: tag.name } : undefined;
          })
          .filter((x): x is { instanceUuid: string; tagName: string } => x !== undefined),
```

- [ ] **Step 3: Update the stale exclusion comment in `importPersonalData`**

In `src/data/in-memory-store.ts`'s `importPersonalData`, find the comment block starting `// pokemonInstances/tags are exported for completeness...`. It currently explains why specimens are skipped — that reasoning is now half-obsolete (tags aren't skipped as of Task 6/9; specimens have a real uuid now). Replace it with:

```ts
      // pokemon_instance merge-by-uuid happens in sqlite-repository.ts's
      // importPersonalData OVERRIDE, not here -- unlike every other row type
      // in this function, a genuinely new specimen needs a fresh
      // AUTOINCREMENT id back from a real INSERT before the in-memory cache
      // can be updated (same reason createPokemonInstances bypasses the
      // hook system entirely -- see that function). This function's job for
      // pokemonInstances/pokemonInstanceTagNames is just to leave them
      // alone; the override handles both directly against SQL.
```

Leave the loop structure below it (for `formBackgroundPersonal`, etc.) untouched — only replace the comment, don't add a loop here.

- [ ] **Step 4: Implement the real merge in `sqlite-repository.ts`'s `importPersonalData` override**

Read the current override first (added in an earlier task, currently just `await runBulk(async () => { result = await repo.importPersonalData(data); }); return result!;`). Extend it to also merge specimens, inside the SAME `runBulk` call so it's part of one transaction:

```ts
    async importPersonalData(data) {
      let result: ImportResult | undefined;
      await runBulk(async () => {
        result = await repo.importPersonalData(data);
        for (const incoming of data.pokemonInstances ?? []) {
          const existingRow = (await db.query("SELECT id, updated_at FROM pokemon_instance WHERE uuid = ?", [incoming.uuid])).values?.[0] as
            | { id: number; updated_at: number }
            | undefined;

          let localId: number;
          if (existingRow) {
            if (existingRow.updated_at >= incoming.updatedAt) continue; // local wins -- row AND its tag links stay as-is
            localId = existingRow.id;
            await db.run(
              `UPDATE pokemon_instance SET form_slug = ?, profile_id = ?, status = ?, recorded_at = ?, caught_at = ?, updated_at = ?, cp = ?, iv_attack = ?, iv_defense = ?, iv_stamina = ?, shiny = ?, lucky = ?, shadow = ?, purified = ?, dynamax = ?, received_via_trade = ?, hearts_earned = ?, current_mega_level = ?, nickname = ?, background_slug = ?, original_trainer_name = ?, original_trainer_id = ? WHERE id = ?`,
              [
                incoming.formSlug, state.profile.id, incoming.status, incoming.recordedAt, incoming.caughtAt, incoming.updatedAt,
                incoming.cp, incoming.ivAttack, incoming.ivDefense, incoming.ivStamina, incoming.shiny ? 1 : 0, incoming.lucky ? 1 : 0,
                incoming.shadow ? 1 : 0, incoming.purified ? 1 : 0, incoming.dynamax ? 1 : 0, incoming.receivedViaTrade ? 1 : 0,
                incoming.heartsEarned, incoming.currentMegaLevel, incoming.nickname, incoming.backgroundSlug,
                incoming.originalTrainerName, incoming.originalTrainerId, localId,
              ],
              false,
            );
          } else {
            await db.run(
              `INSERT INTO pokemon_instance (form_slug, profile_id, status, recorded_at, caught_at, updated_at, cp, iv_attack, iv_defense, iv_stamina, shiny, lucky, shadow, purified, dynamax, received_via_trade, hearts_earned, current_mega_level, nickname, background_slug, uuid, original_trainer_name, original_trainer_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                incoming.formSlug, state.profile.id, incoming.status, incoming.recordedAt, incoming.caughtAt, incoming.updatedAt,
                incoming.cp, incoming.ivAttack, incoming.ivDefense, incoming.ivStamina, incoming.shiny ? 1 : 0, incoming.lucky ? 1 : 0,
                incoming.shadow ? 1 : 0, incoming.purified ? 1 : 0, incoming.dynamax ? 1 : 0, incoming.receivedViaTrade ? 1 : 0,
                incoming.heartsEarned, incoming.currentMegaLevel, incoming.nickname, incoming.backgroundSlug,
                incoming.uuid, incoming.originalTrainerName, incoming.originalTrainerId,
              ],
              false,
            );
            const idRow = (await db.query("SELECT last_insert_rowid() AS id")).values?.[0] as { id: number } | undefined;
            localId = idRow!.id;
          }

          // Tag links move with whichever side's row won -- replace this
          // specimen's links entirely rather than merging them, same
          // "whole row, not field by field" rule as everywhere else in this
          // function (a link set is the row's own metadata).
          await db.run("DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ?", [localId], false);
          const tagNames = (data.pokemonInstanceTagNames ?? []).filter((t) => t.instanceUuid === incoming.uuid).map((t) => t.tagName);
          for (const tagName of tagNames) {
            const tag = await createTag(tagName);
            await db.run("INSERT OR IGNORE INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)", [localId, tag.id], false);
          }
        }
      });
      return result!;
    },
```

(`createTag` here is the SAME function defined earlier in this file's returned object — call it directly, not through `repo`, since it already correctly maintains `sharedTags` per Task 6. If `createTag` isn't in scope as a plain function reference at this point in the file, check how the returned object's other methods reference each other — e.g. `deleteProfile` calling `reassignStateToBucket` — and follow the same pattern.)

After the transaction commits (i.e., after this whole `runBulk` call, at the point `createPokemonInstances` already does its own post-commit cache sync), refresh `state.pokemonInstances`/`state.pokemonInstanceTags` and the corresponding `profileBuckets` entry for whichever profile was the merge target, by re-reading from SQL — the simplest correct approach is calling `loadOneProfileState`-equivalent logic for just this profile's `pokemon_instance`/`pokemon_instance_tag` rows and reassigning `state.pokemonInstances`/`state.pokemonInstanceTags` (and the matching `profileBuckets.get(state.profile.id)` entry's fields) to the fresh result, rather than trying to incrementally patch the in-memory arrays to match every insert/update/delete above.

- [ ] **Step 5: Idempotency test — the real acceptance criterion**

Add to `test/sqlite-repository-trainer-export-import.test.ts`:

```ts
test("importing the same bundle twice does not duplicate specimens, and tag links survive both passes", async () => {
  const dbA = new DatabaseSync(":memory:");
  dbA.exec("PRAGMA foreign_keys = ON;");
  dbA.exec(REFERENCE_SCHEMA_SQL);
  const repoA = await createSqliteRepository(undefined, nodeSqliteConnection(dbA));
  await repoA.renameProfile(repoA.getCurrentProfile().id, "Ash", "111122223333");
  const [instance] = await repoA.createPokemonInstances({ formSlug: "bulbasaur-standard-male", count: 1 });
  const tag = await repoA.createTag("starters");
  await repoA.updatePokemonInstance(instance.id, { tagIds: [tag.id] });

  const dbB = new DatabaseSync(":memory:");
  dbB.exec("PRAGMA foreign_keys = ON;");
  dbB.exec(REFERENCE_SCHEMA_SQL);
  const repoB = await createSqliteRepository(undefined, nodeSqliteConnection(dbB));
  await repoB.renameProfile(repoB.getCurrentProfile().id, "Ash Ketchum", "111122223333");

  const bundle = buildExportBundle(repoA, [repoA.getCurrentProfile().id]);
  await repoB.applyTrainerImport(bundle, {});
  await repoB.applyTrainerImport(bundle, {}); // import the SAME bundle again

  const rows = repoB.listPokemonInstances({ status: "all" });
  assert.equal(rows.length, 1, "importing the same bundle twice must not duplicate the specimen");
  assert.equal(rows[0].tags.length, 1, "tag links must survive both import passes");
  assert.equal(rows[0].tags[0].name, "starters");
});
```

(Import `buildExportBundle` from `src/features/settings/personal-data-transfer.ts` at the top of the test file if not already imported by an earlier task.) Run: `npx tsc -b && npm test`. Expected: passes.

- [ ] **Step 6: Full-suite verification and commit**

```bash
npx tsc -b && npm test && npm run lint && npx vite build
```

Expected: all clean.

```bash
git add src/data/repository.ts src/data/in-memory-store.ts src/data/sqlite-repository.ts test/sqlite-repository-trainer-export-import.test.ts
git commit -m "Actually merge pokemon_instance (and its tags) by uuid on import"
```

**Explicitly out of scope for this task** (decide, don't silently drop): `pokemon_instance_max_move` is NOT included in export/merge — the design spec's own schema comment already calls the Max Move mechanic's modeling "provisional," so extending merge to it now would be building on an acknowledged-unstable foundation. Log this to `docs/roadmap.md` alongside this sub-project's other deferred items if not already covered by an existing entry.

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage**: §2 (one import/export mechanism) → Tasks 7-9. §3.1 (pokemon_instance identity + original-trainer fields) → Task 4; §3.1's actual merge-by-uuid rule ("closing gap 1 directly") → Task 10, added late after Task 9's review found this sentence had no owning task (the original mapping below wrongly counted Task 4 as covering all of §3.1 — it only covered identity, not the merge rule §3.1 also specifies). §3.2 (status rename) → Task 5. §3.3 (tags global) → Task 6. §4 (referenced_trainer registry + reconciliation) → Tasks 2, 3, 8, 9. §5 (export bundle) → Tasks 7, 9, 10 (tag-link export data was missing until Task 10). §6 (migration) → Task 1. §7/§8 (deferred items) — intentionally not tasked; already logged in `docs/roadmap.md`.
- **Known rough edge surfaced while writing this plan, not the design spec**: Task 9's `applyTrainerImport` needed a real fix mid-plan (restoring the true original current profile after processing a multi-trainer bundle, not just the last-touched one) and a retroactively-threaded `sharedReferencedTrainers` cache (Step 4) that Tasks 2-4's original wording didn't anticipate. Both are resolved directly in Task 9's final step text above — an implementer following Task 9 in order arrives at the corrected version, but note this in the PR description since it means Task 9 is less mechanical than the others and deserves closer review.
- **Type consistency check**: `ReconciliationDecision`'s `localProfileId` field name is used consistently across `trainer-reconciliation.ts` (Task 8) and `sqlite-repository.ts`'s `applyTrainerImport` (Task 9). `TrainerExport`/`ExportBundle` field names match between `repository.ts` (Task 7), `personal-data-transfer.ts`, and `SettingsPage.vue` (Task 9).
