# Sub-project 7a: Local Multi-Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real local multi-account support — create/switch/rename/delete profiles, each with fully independent Dex progress, collection, tags, and player progress, stored in one on-disk SQLite file with an instant in-memory switch.

**Architecture:** Widen the primary key on every personal table to include `profile_id`, and convert `profile.id` (and every `profile_id` column) from `INTEGER` to a stable `TEXT` UUID — cheap now since the migration already touches every one of these tables, and it means Sub-project 7b never has to re-migrate `profile.id`. The in-memory cache (`src/data/in-memory-store.ts`) keeps its exact current shape and is left almost entirely untouched: `state`'s per-profile fields (`speciesPersonal`, `formPersonal`, etc.) become *aliases* into whichever profile's data bucket is current, and switching profiles reassigns those aliases to a different bucket's objects — no reload, no data copy, and (confirmed via grep) none of `in-memory-store.ts`'s ~60 existing `state.xxx` access sites need to change, since JS object property access always reads the live value.

**Tech Stack:** Drizzle ORM (schema + migration generation), `@tauri-apps/plugin-sql` (unaffected by this plan — no connection-layer changes), Vue 3 SFC (`TrainerPage.vue`), `node:sqlite`-backed unit tests (established project pattern).

## Global Constraints

- `pokemon_instance.id`/`tag.id` stay local `AUTOINCREMENT` integers — do NOT touch either table's own primary key. Giving those stable cross-device identity is Sub-project 7b's job.
- Every existing `Repository` method's signature stays unchanged — no method gains a `profileId` parameter. All existing methods implicitly operate on "the current profile."
- New profiles always start completely blank (no Dex/collection/tag/progress data carried over). A copy/duplicate option is explicitly deferred — do not build it.
- `app_settings` becomes per-profile (composite PK `(profile_id, key)`) — it is NOT shared/global.
- Tracking "which profile is current" is a `profile.isCurrent` boolean column (exactly one `true` at any time) — never an `app_settings` value (would be circular, since `app_settings` itself is now per-profile).
- Profile switching UI lives on the Trainer page only. The header gets a read-only current-trainer indicator, not a switcher.
- Deleting the only remaining profile is blocked. Deleting the *current* profile must automatically switch to another remaining profile first — the invariant "exactly one profile is current" must never be violated, even transiently.
- e2e coverage is a known, accepted gap (Sub-project 6 retired Playwright) — do not add new e2e tests; UI verification in this plan is manual.
- This closes out the Sub-project 2 carry-forward item ("live-confirm the `profile.id` FK-read fix") — the migration test in Task 1 is that confirmation.

---

## File Structure

New files:
- `src/data/profile-scoped-write-sql.ts` — pure SQL-builder functions for the write paths whose target table's primary key is widening (`species_personal`, `form_personal`, `mega_personal`, `app_settings`), each returning `{ sql: string; params: unknown[] }` so they're testable against a real `node:sqlite` `DatabaseSync` without needing the full Tauri-connected repository.
- `src/data/profile-management-sql.ts` — pure SQL-builder functions for profile CRUD (create/rename/delete's cascade DELETEs), same testability reasoning.

Modified files:
- `src/db/schema/personal.ts` — schema changes (Task 1).
- `src/db/migrations/*` + `src/db/migrations-data.ts` — generated migration (Task 1).
- `src/db/migrations.ts` — UUID randomization + fresh-install seeding (Task 2).
- `src/db/schema.ts` — remove `DEFAULT_PROFILE_ID` (Task 2), bump `CURRENT_PERSONAL_SCHEMA_VERSION` (Task 1).
- `src/db/types.ts` — `Profile.id: string`, add `profileId` to `FormBackgroundPersonal` (Task 3).
- `src/data/repository.ts` — new method signatures (Task 3).
- `src/data/in-memory-store.ts` — `Omit<>` list extension, remove `setProfile`/`getProfile`/`onProfileChanged` (Task 3).
- `src/data/sqlite-repository.ts` — multi-profile boot loading (Task 4), write-hook fixes (Tasks 5-6), profile CRUD methods (Task 8).
- `src/data/completion-stats-sql.ts` — profile-scope every lens (Task 7).
- `src/data/personal-demo-seed.ts`, `scripts/build-dummy-db.ts` — thread a real generated profile id through demo-data inserts (Task 9).
- `src/features/trainer/TrainerPage.vue` — profile list/switch/rename/delete/create UI (Task 10).
- `src/app-shell/header.ts`, `src/main.ts` — current-trainer indicator (Task 10).
- `docs/data-model.md`, `docs/roadmap.md` (Task 11).

---

### Task 1: Schema changes — widen PKs, retype `profile_id`, generate + hand-fix the migration

**Files:**
- Modify: `src/db/schema/personal.ts`
- Modify: `src/db/schema.ts` (bump `CURRENT_PERSONAL_SCHEMA_VERSION`)
- Create (via `npm run db:generate`): a new file under `src/db/migrations/`
- Modify (regenerated): `src/db/migrations-data.ts`
- Test: `test/profile-multi-account-migration.test.ts`

**Interfaces:**
- Produces: every personal table has a `profile_id TEXT NOT NULL` column (no default); `species_personal`/`form_personal`/`mega_personal`/`form_background_personal`/`app_settings` have `profile_id` in their primary key; `profile` has `id TEXT PRIMARY KEY` and a new `is_current INTEGER NOT NULL DEFAULT 0` column.

- [ ] **Step 1: Edit `src/db/schema/personal.ts`**

Change `profile`:

```ts
export const profile = sqliteTable("profile", {
  id: text("id").primaryKey(),
  username: text("username").notNull(),
  friendCode: text("friend_code"),
  isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
```

Change every table below: replace `integer("profile_id").notNull().default(1)` (or `.notNull()` where there's no default, e.g. `pokemon_instance`/`tag`/`player_progress_log`) with `text("profile_id").notNull()` — drop the default in every case, since a UUID can't be a static default. Then widen the primary key where noted.

`speciesPersonal` — widen PK to `(profile_id, species_slug)`:

```ts
export const speciesPersonal = sqliteTable(
  "species_personal",
  {
    speciesSlug: text("species_slug").notNull(),
    profileId: text("profile_id").notNull(),
    registered: integer("registered", { mode: "boolean" }).notNull().default(false),
    xxl: integer("xxl", { mode: "boolean" }).notNull().default(false),
    xxs: integer("xxs", { mode: "boolean" }).notNull().default(false),
    purified: integer("purified", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.speciesSlug] }),
    ...boolChecks("species_personal", { registered: table.registered, xxl: table.xxl, xxs: table.xxs, purified: table.purified }),
  }),
);
```

`formPersonal` — same treatment, widen PK to `(profile_id, form_slug)`:

```ts
export const formPersonal = sqliteTable(
  "form_personal",
  {
    formSlug: text("form_slug").notNull(),
    profileId: text("profile_id").notNull(),
    // ... every other field unchanged from today ...
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.formSlug] }),
    ...boolChecks("form_personal", {
      caught: table.caught, shiny: table.shiny, floor: table.floor, fourStar: table.fourStar, shundo: table.shundo,
      lucky: table.lucky, luckyShiny: table.luckyShiny, luckyFloor: table.luckyFloor, luckyFourStar: table.luckyFourStar, luckyShundo: table.luckyShundo,
      shadow: table.shadow, shadowShiny: table.shadowShiny, shadowFloor: table.shadowFloor, shadowFourStar: table.shadowFourStar, shadowShundo: table.shadowShundo,
      dynamax: table.dynamax, dynamaxFloor: table.dynamaxFloor, dynamaxShiny: table.dynamaxShiny, dynamaxFourStar: table.dynamaxFourStar, dynamaxShundo: table.dynamaxShundo,
      luckyDynamax: table.luckyDynamax, luckyDynamaxFloor: table.luckyDynamaxFloor, luckyDynamaxShiny: table.luckyDynamaxShiny, luckyDynamaxFourStar: table.luckyDynamaxFourStar, luckyDynamaxShundo: table.luckyDynamaxShundo,
    }),
  }),
);
```

(Keep every field between `formSlug`/`profileId` and `updatedAt` exactly as it is today — only the `profileId` type, the removed `.primaryKey()` on `formSlug`, and the new `pk` entry in the constraints callback change.)

`formBackgroundPersonal` — widen the existing composite PK to include `profile_id`:

```ts
export const formBackgroundPersonal = sqliteTable(
  "form_background_personal",
  {
    formSlug: text("form_slug").notNull(),
    profileId: text("profile_id").notNull(),
    achievementField: text("achievement_field").notNull(),
    backgroundSlug: text("background_slug").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.formSlug, table.achievementField, table.backgroundSlug] }),
  }),
);
```

`megaPersonal` — widen PK to `(profile_id, mega_variant_slug)`:

```ts
export const megaPersonal = sqliteTable(
  "mega_personal",
  {
    megaVariantSlug: text("mega_variant_slug").notNull(),
    profileId: text("profile_id").notNull(),
    evolved: integer("evolved", { mode: "boolean" }).notNull().default(false),
    shinyEvolved: integer("shiny_evolved", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`0`),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.megaVariantSlug] }),
    ...boolChecks("mega_personal", { evolved: table.evolved, shinyEvolved: table.shinyEvolved }),
  }),
);
```

`appSettings` — widen PK to `(profile_id, key)`:

```ts
export const appSettings = sqliteTable(
  "app_settings",
  {
    key: text("key").notNull(),
    profileId: text("profile_id").notNull(),
    value: text("value").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.key] }),
  }),
);
```

`pokemonInstance` — only retype `profileId`, no PK change:

```ts
profileId: text("profile_id").notNull(),
```

`tag` — only retype `profileId`, no PK change:

```ts
profileId: text("profile_id").notNull(),
```

`playerProgressPersonal` — retype both the PK column and its type (PK stays `profile_id` alone):

```ts
export const playerProgressPersonal = sqliteTable("player_progress_personal", {
  profileId: text("profile_id").primaryKey(),
  currentLevel: integer("current_level"),
  totalXp: integer("total_xp"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
```

`medalProgressPersonal` — only retype `profileId`, PK shape (`medal_slug, profile_id`) unchanged:

```ts
profileId: text("profile_id").notNull(),
```

`playerProgressLog` — only retype `profileId`:

```ts
profileId: text("profile_id").notNull(),
```

- [ ] **Step 2: Generate the migration**

```bash
npm run db:generate
```

- [ ] **Step 3: Hand-fix the generated migration file**

This rebuilds 11 tables (`profile`, `species_personal`, `form_personal`, `form_background_personal`, `mega_personal`, `app_settings`, `pokemon_instance`, `tag`, `player_progress_personal`, `medal_progress_personal`, `player_progress_log`). Apply this checklist to **every one of the 11** `CREATE TABLE __new_*` / `INSERT INTO __new_*` pairs in the generated file — this is exactly the class of issue every prior migration in this project has hit (see `0002_messy_killraven.sql`'s and `0003_familiar_meggan.sql`'s header comments):

1. **Restore dropped `REFERENCES` clauses.** drizzle-kit's rebuild drops every `REFERENCES` clause that isn't expressed as a Drizzle `.references()` call (this project deliberately keeps those as plain columns — see `schema/personal.ts`'s header comment). Restore, per table:
   - `species_personal.profile_id` → `REFERENCES profile(id)`
   - `form_personal.profile_id` → `REFERENCES profile(id)`
   - `form_background_personal.form_slug` → `REFERENCES form(slug)`, `.profile_id` → `REFERENCES profile(id)`, `.background_slug` → `REFERENCES backgrounds(slug)`
   - `mega_personal.profile_id` → `REFERENCES profile(id)`
   - `app_settings.profile_id` → `REFERENCES profile(id)`
   - `pokemon_instance.form_slug` → `REFERENCES form(slug)`, `.profile_id` → `REFERENCES profile(id)`, `.background_slug` → `REFERENCES backgrounds(slug)`
   - `tag.profile_id` → `REFERENCES profile(id)`
   - `player_progress_personal.profile_id` → `REFERENCES profile(id)`
   - `medal_progress_personal.profile_id` → `REFERENCES profile(id)`
   - `player_progress_log.profile_id` → `REFERENCES profile(id)`
2. **`pokemon_instance`'s generated `iv_percent` column**: must NOT appear in the `INSERT INTO __new_pokemon_instance (...)` column list or the `SELECT ... FROM pokemon_instance` list — drop it from both (SQLite rejects `INSERT`ing into a `GENERATED` column; it's computed on read).
3. Confirm every `INSERT INTO __new_X (...) SELECT ... FROM X` statement's column lists match exactly — drizzle-kit sometimes lists a column that doesn't exist yet on the *old* table shape (not applicable here since no columns are being newly introduced by this migration, only retyped/PK-widened, but verify anyway: run the migration test in Step 5 and read any `no such column` error carefully if one appears).
4. Confirm `PRAGMA foreign_keys=OFF`/`=ON` bracket the whole file (drizzle-kit adds this automatically — verify it wasn't only applied to the first table, a bug this project's own migration 0000 hit).

- [ ] **Step 4: Regenerate the embedded migration data and bump the schema version**

```bash
npm run db:generate-data
```

In `src/db/schema.ts`, change:

```ts
export const CURRENT_PERSONAL_SCHEMA_VERSION = 9;
```

to:

```ts
export const CURRENT_PERSONAL_SCHEMA_VERSION = 10;
```

- [ ] **Step 5: Write the migration test**

Create `test/profile-multi-account-migration.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { runPersonalMigrations } from "../src/db/migrations";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";

test("fresh install: composite PKs allow two profiles to each hold a row for the same slug", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  // Confirm profile.id is a real UUID (36 chars, has dashes), not a bare "1".
  const profileRow = db.prepare("SELECT id FROM profile").get() as { id: string };
  assert.match(profileRow.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // Insert a second profile directly and confirm species_personal accepts a
  // row for the same species_slug under both profiles (the whole point of
  // widening the PK).
  db.exec(`INSERT INTO profile (id, username, is_current, created_at) VALUES ('11111111-1111-1111-1111-111111111111', 'Second', 0, 0)`);
  db.exec(`INSERT INTO species (slug, dex_number, name, family_slug, gen, rarity, region_slug, has_male, has_female, can_mega_evolve, can_gigantamax) VALUES ('bulbasaur', 1, 'Bulbasaur', 'bulbasaur', 1, 'standard', 'kanto', 1, 1, 0, 0)`);
  db.exec(`INSERT INTO regions (slug, name) VALUES ('kanto', 'Kanto')`);
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '${profileRow.id}', 1, 0)`);
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '11111111-1111-1111-1111-111111111111', 0, 0)`);

  const rows = db.prepare("SELECT profile_id, registered FROM species_personal WHERE species_slug = 'bulbasaur' ORDER BY profile_id").all();
  assert.equal(rows.length, 2);
});

test("upgrade from a v9 single-profile device: profile_id=1 is rewritten to a real UUID everywhere", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version) VALUES (9);
    CREATE TABLE profile (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, friend_code TEXT, created_at INTEGER NOT NULL);
    INSERT INTO profile (id, username, created_at) VALUES (1, 'Trainer', 0);
    CREATE TABLE species_personal (species_slug TEXT PRIMARY KEY, profile_id INTEGER NOT NULL DEFAULT 1, registered INTEGER NOT NULL DEFAULT 0, xxl INTEGER NOT NULL DEFAULT 0, xxs INTEGER NOT NULL DEFAULT 0, purified INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
    INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', 1, 1, 12345);
  `);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  const profileRow = db.prepare("SELECT id, is_current FROM profile").get() as { id: string; is_current: number };
  assert.match(profileRow.id, /^[0-9a-f]{8}-/);
  assert.equal(profileRow.is_current, 1);

  const speciesRow = db.prepare("SELECT profile_id, registered, updated_at FROM species_personal WHERE species_slug = 'bulbasaur'").get() as {
    profile_id: string;
    registered: number;
    updated_at: number;
  };
  assert.equal(speciesRow.profile_id, profileRow.id);
  assert.equal(speciesRow.registered, 1);
  assert.equal(speciesRow.updated_at, 12345); // pre-existing data survived, not just the id rewrite
});
```

- [ ] **Step 6: Run the tests — expect the second test to FAIL** (Task 2 hasn't written the UUID-randomization step yet)

```bash
npx tsx --test test/profile-multi-account-migration.test.ts
```

Expected: first test PASSES (proves the composite PK works); second test FAILS on the `is_current` or `profile_id` assertion (proves the randomization step doesn't exist yet — that's Task 2).

- [ ] **Step 7: Commit**

```bash
git add src/db/schema/personal.ts src/db/schema.ts src/db/migrations src/db/migrations-data.ts test/profile-multi-account-migration.test.ts
git commit -m "Widen personal-table PKs to include profile_id; retype profile_id as TEXT"
```

---

### Task 2: UUID randomization for legacy devices + fresh-install seeding

**Files:**
- Modify: `src/db/migrations.ts`
- Modify: `src/db/schema.ts` (remove `DEFAULT_PROFILE_ID`)
- Test: `test/profile-multi-account-migration.test.ts` (from Task 1, now passing)

**Interfaces:**
- Consumes: `SQLiteDBConnection` (`src/db/sqlite-connection.ts`), the table list from Task 1.
- Produces: `runPersonalMigrations(db)` (unchanged signature) now guarantees `profile.id` is a real UUID with `is_current = true` on both fresh installs and upgrades.

- [ ] **Step 1: Add the randomization step to `src/db/migrations.ts`**

Add this function after `seedDefaultProfileIfMissing` (around line 164):

```ts
// A pre-migration (schema v9 and earlier) device's profile.id was the plain
// integer 1, carried across Task 1's table-rebuild as the TEXT value "1"
// (SQLite's INSERT...SELECT just casts the old value, it doesn't know it
// should be a UUID). Detect that shape and replace it, exactly once, with a
// real UUID — everywhere it's referenced. There's exactly one profile row
// at this point on every real device (multi-account didn't exist before
// this migration), so every profile-scoped row gets rewritten
// unconditionally to the one new id — no WHERE profile_id = 1 comparison,
// which would be a TEXT-vs-INTEGER-literal footgun now that the column is
// TEXT-typed.
const PROFILE_SCOPED_TABLES = [
  "species_personal",
  "form_personal",
  "form_background_personal",
  "mega_personal",
  "app_settings",
  "pokemon_instance",
  "tag",
  "player_progress_personal",
  "medal_progress_personal",
  "player_progress_log",
];

async function randomizeLegacyProfileId(db: SQLiteDBConnection): Promise<void> {
  const result = await db.query("SELECT id FROM profile LIMIT 1");
  const row = result.values?.[0] as { id: string } | undefined;
  if (!row || row.id !== "1") return; // already a real UUID, or no profile row yet (fresh install seeds one after this runs)

  const newId = crypto.randomUUID();
  await db.beginTransaction();
  try {
    // Defer FK enforcement to COMMIT: rewriting profile.id and every child
    // table's profile_id column in either order momentarily breaks the FK
    // (the parent row and the children can't both reference the same new id
    // atomically without deferral) — see reference-sync.ts's identical use
    // of this pragma for the same reason.
    await db.run("PRAGMA defer_foreign_keys = true", [], false);
    await db.run("UPDATE profile SET id = ?, is_current = 1 WHERE id = '1'", [newId], false);
    for (const table of PROFILE_SCOPED_TABLES) {
      await db.run(`UPDATE ${table} SET profile_id = ? WHERE profile_id = '1'`, [newId], false);
    }
    await db.commitTransaction();
  } catch (err) {
    await db.rollbackTransaction();
    throw err;
  }
}
```

- [ ] **Step 2: Call it from `runPersonalMigrations`**

Change:

```ts
export async function runPersonalMigrations(db: SQLiteDBConnection): Promise<void> {
  await bootstrapDrizzleTrackingForExistingDevice(db);
  await assertNotADowngrade(db);

  await ensureMigrationsTable(db);
  const latestRow = (await db.query(`SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`)).values?.[0] as
    | { created_at: number }
    | undefined;
  const pending = MIGRATIONS.filter((m) => !latestRow || m.millis > latestRow.created_at);

  if (pending.length > 0) {
    await applyPendingMigrations(db, pending);
  }

  await seedDefaultProfileIfMissing(db);
}
```

to:

```ts
export async function runPersonalMigrations(db: SQLiteDBConnection): Promise<void> {
  await bootstrapDrizzleTrackingForExistingDevice(db);
  await assertNotADowngrade(db);

  await ensureMigrationsTable(db);
  const latestRow = (await db.query(`SELECT created_at FROM ${MIGRATIONS_TABLE} ORDER BY created_at DESC LIMIT 1`)).values?.[0] as
    | { created_at: number }
    | undefined;
  const pending = MIGRATIONS.filter((m) => !latestRow || m.millis > latestRow.created_at);

  if (pending.length > 0) {
    await applyPendingMigrations(db, pending);
  }

  await seedDefaultProfileIfMissing(db);
  await randomizeLegacyProfileId(db);
}
```

(`randomizeLegacyProfileId` runs after `seedDefaultProfileIfMissing` so it also covers the case of a device that was mid-upgrade and only just got its profile row seeded — harmless no-op ordering either way since the check is "is `profile.id` still exactly `'1'`".)

- [ ] **Step 3: Update `seedDefaultProfileIfMissing` for fresh installs**

Change:

```ts
async function seedDefaultProfileIfMissing(db: SQLiteDBConnection): Promise<void> {
  const result = await db.query("SELECT COUNT(*) as c FROM profile");
  const row = result.values?.[0] as { c: number } | undefined;
  if ((row?.c ?? 0) > 0) return;
  await db.run(
    "INSERT INTO profile (id, username, friend_code, created_at) VALUES (?, ?, NULL, ?)",
    [DEFAULT_PROFILE_ID, DEFAULT_PROFILE_USERNAME, Date.now()],
    false,
  );
}
```

to:

```ts
async function seedDefaultProfileIfMissing(db: SQLiteDBConnection): Promise<void> {
  const result = await db.query("SELECT COUNT(*) as c FROM profile");
  const row = result.values?.[0] as { c: number } | undefined;
  if ((row?.c ?? 0) > 0) return;
  await db.run(
    "INSERT INTO profile (id, username, friend_code, is_current, created_at) VALUES (?, ?, NULL, 1, ?)",
    [crypto.randomUUID(), DEFAULT_PROFILE_USERNAME, Date.now()],
    false,
  );
}
```

Remove the now-unused `DEFAULT_PROFILE_ID` import at the top of the file — change:

```ts
import { DEFAULT_PROFILE_ID, DEFAULT_PROFILE_USERNAME } from "./schema";
```

to:

```ts
import { DEFAULT_PROFILE_USERNAME } from "./schema";
```

- [ ] **Step 4: Remove `DEFAULT_PROFILE_ID` from `src/db/schema.ts`**

Delete the line:

```ts
export const DEFAULT_PROFILE_ID = 1;
```

Confirm no other file still imports it:

```bash
grep -rn "DEFAULT_PROFILE_ID" src/ test/ scripts/
```

Expected: no output.

- [ ] **Step 5: Run the migration tests — both should now pass**

```bash
npx tsx --test test/profile-multi-account-migration.test.ts
```

Expected: `tests 2, pass 2, fail 0`.

- [ ] **Step 6: Run the full test suite and typecheck**

```bash
npx tsc -b
npm test
```

Expected: both clean — this is the point where every other file that referenced `DEFAULT_PROFILE_ID` or `Profile.id: number` will start failing to typecheck; Task 3 fixes those. If `tsc -b` fails here, that's expected and is the confirmation that Task 3 has real work to do — don't try to fix it in this task.

- [ ] **Step 7: Commit**

```bash
git add src/db/migrations.ts src/db/schema.ts
git commit -m "Randomize profile.id to a UUID on migration and fresh install"
```

---

### Task 3: Type and interface updates

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/data/repository.ts`
- Modify: `src/data/in-memory-store.ts`

**Interfaces:**
- Produces: `Profile.id: string`; `FormBackgroundPersonal.profileId: string`; five new `Repository` methods (`listProfiles`, `createProfile`, `switchProfile`, `renameProfile`, `deleteProfile`); `getCurrentProfile()` replacing `getProfile()`; `setProfile` removed.

This task only changes types and the Omit<> list — no new logic yet (Tasks 4-8 implement the new methods). Expect `tsc -b` to fail after this task in files this task doesn't touch (`TrainerPage.vue`, `sqlite-repository.ts`) — that's expected, fixed by Tasks 4, 8, and 10.

- [ ] **Step 1: Update `src/db/types.ts`**

Change:

```ts
export interface Profile {
  id: number;
  username: string;
  friendCode: string | null;
  createdAt: number;
}
```

to:

```ts
export interface Profile {
  id: string;
  username: string;
  friendCode: string | null;
  createdAt: number;
}
```

Change:

```ts
export interface FormBackgroundPersonal {
  formSlug: string;
  achievementField: FormPersonalBooleanField;
  backgroundSlug: string;
  /** When this link was added — the composite PK has no "value" to compare on merge (a row either exists or doesn't), so this is informational, not a merge tiebreaker. Epoch milliseconds, not an ISO string. */
  updatedAt: number;
}
```

to:

```ts
export interface FormBackgroundPersonal {
  formSlug: string;
  profileId: string;
  achievementField: FormPersonalBooleanField;
  backgroundSlug: string;
  /** When this link was added — the composite PK has no "value" to compare on merge (a row either exists or doesn't), so this is informational, not a merge tiebreaker. Epoch milliseconds, not an ISO string. */
  updatedAt: number;
}
```

- [ ] **Step 2: Update `src/data/repository.ts`**

Find the `// ---- Trainer/Profile page ----` section (around line 290) and replace:

```ts
  // ---- Trainer/Profile page ----
  /**
   * The single existing profile row (id=1) — identity only (username/friend
   * code), not a multi-profile switcher. species_personal/form_personal/
   * mega_personal's PK is the slug alone, not composite with profile_id, so
   * a second profile couldn't hold separate Dex data without a schema
   * migration — that's deferred to the Drizzle pass, not done here. Not
   * included in export/import: it's per-install identity, not collection
   * data to merge across devices.
   */
  getProfile(): Profile;
  setProfile(username: string, friendCode: string | null): void;
```

with:

```ts
  // ---- Trainer/Profile page: multi-account ----
  /** Every local profile on this device, in no particular guaranteed order. */
  listProfiles(): Profile[];
  /** The currently-active profile — every other Repository method implicitly reads/writes this profile's data. Not included in export/import: it's per-install identity, not collection data to merge across devices. */
  getCurrentProfile(): Profile;
  /** Always starts blank — no Dex/collection/tag/progress data is copied from any other profile. Does not switch the current profile to the new one. */
  createProfile(username: string, friendCode: string | null): Promise<Profile>;
  /** Instant — no reload. Throws if profileId doesn't match any local profile. */
  switchProfile(profileId: string): void;
  /** Renames any local profile (not just the current one) — used by the Trainer page's per-row rename action. */
  renameProfile(profileId: string, username: string, friendCode: string | null): Promise<void>;
  /** Throws if profileId is the only remaining profile. If profileId is the current profile, automatically switches to another remaining profile first. */
  deleteProfile(profileId: string): Promise<void>;
```

- [ ] **Step 3: Update `src/data/in-memory-store.ts`**

Extend the `Omit<>` list in `createInMemoryRepository`'s return type — change:

```ts
export function createInMemoryRepository(
  referenceData: ReferenceData,
  state: PersonalState,
  hooks: InMemoryStoreHooks,
): Omit<
  Repository,
  | "getCompletionStats"
  | "createPokemonInstances"
  | "createTag"
  | "updatePokemonInstance"
  | "listBackgrounds"
  | "getTagUsageCounts"
  | "renameTag"
  | "deleteTag"
> {
```

to:

```ts
export function createInMemoryRepository(
  referenceData: ReferenceData,
  state: PersonalState,
  hooks: InMemoryStoreHooks,
): Omit<
  Repository,
  | "getCompletionStats"
  | "createPokemonInstances"
  | "createTag"
  | "updatePokemonInstance"
  | "listBackgrounds"
  | "getTagUsageCounts"
  | "renameTag"
  | "deleteTag"
  | "listProfiles"
  | "getCurrentProfile"
  | "createProfile"
  | "switchProfile"
  | "renameProfile"
  | "deleteProfile"
> {
```

Remove the now-obsolete `getProfile`/`setProfile` methods and the `applyProfile` helper and `onProfileChanged` hook — they're fully replaced by `getCurrentProfile`/`renameProfile`, implemented directly in `sqlite-repository.ts` (Task 8). Delete:

```ts
    getProfile(): Profile {
      return state.profile;
    },

    setProfile(username: string, friendCode: string | null) {
      applyProfile(username, friendCode);
    },
```

Delete:

```ts
  function applyProfile(username: string, friendCode: string | null): void {
    const updated: Profile = { ...state.profile, username, friendCode };
    state.profile = updated;
    hooks.onProfileChanged(updated);
  }
```

Delete `onProfileChanged(profile: Profile): void;` from the `InMemoryStoreHooks` interface.

Remove the now-unused `Profile` import if nothing else in the file references it — check with:

```bash
grep -n "Profile\b" src/data/in-memory-store.ts
```

If `state.profile`/`PersonalState.profile: Profile` are still referenced elsewhere in the file (they are — `PersonalState.profile` stays, it's still "the current profile's identity," just no longer mutated via this file's own method), keep the `Profile` type import.

- [ ] **Step 4: Confirm the expected compile failures**

```bash
npx tsc -b
```

Expected: errors in `src/data/sqlite-repository.ts` (doesn't implement the 5 new methods yet — Task 8) and `src/features/trainer/TrainerPage.vue` (calls the now-removed `getProfile`/`setProfile` — Task 10). No errors expected in `in-memory-store.ts` or `repository.ts` themselves.

- [ ] **Step 5: Commit**

```bash
git add src/db/types.ts src/data/repository.ts src/data/in-memory-store.ts
git commit -m "Add multi-account Repository interface, remove single-profile getProfile/setProfile"
```

---

### Task 4: Multi-profile boot loading

**Files:**
- Modify: `src/data/sqlite-repository.ts`
- Test: `test/sqlite-repository-multi-profile-load.test.ts`

**Interfaces:**
- Consumes: `PersonalState` (`src/data/in-memory-store.ts`, unchanged shape).
- Produces: `loadAllProfiles(db): Promise<{ buckets: Map<string, PersonalState>; currentProfileId: string }>` (new, exported for testability), replacing the current unexported `loadPersonalState`.

**Context:** `PersonalState`'s shape doesn't change — each `Map` entry is a full `PersonalState` for one profile, built by running today's exact per-table queries with a `WHERE profile_id = ?` filter added. `pokemon_instance_tag` has no `profile_id` column of its own — filter it via a join against `pokemon_instance`, which does.

- [ ] **Step 1: Write the failing test**

Create `test/sqlite-repository-multi-profile-load.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";
import { loadAllProfiles } from "../src/data/sqlite-repository";
import { runPersonalMigrations } from "../src/db/migrations";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";

test("loadAllProfiles returns one isolated bucket per profile, keyed correctly to the current profile", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);

  const firstProfileId = (db.prepare("SELECT id FROM profile").get() as { id: string }).id;
  const secondProfileId = "22222222-2222-2222-2222-222222222222";
  db.exec(`INSERT INTO profile (id, username, is_current, created_at) VALUES ('${secondProfileId}', 'Second', 0, 0)`);
  db.exec(`INSERT INTO regions (slug, name) VALUES ('kanto', 'Kanto')`);
  db.exec(
    `INSERT INTO species (slug, dex_number, name, family_slug, gen, rarity, region_slug, has_male, has_female, can_mega_evolve, can_gigantamax) VALUES ('bulbasaur', 1, 'Bulbasaur', 'bulbasaur', 1, 'standard', 'kanto', 1, 1, 0, 0)`,
  );
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '${firstProfileId}', 1, 0)`);
  db.exec(`INSERT INTO species_personal (species_slug, profile_id, registered, updated_at) VALUES ('bulbasaur', '${secondProfileId}', 0, 0)`);

  const { buckets, currentProfileId } = await loadAllProfiles(conn);

  assert.equal(currentProfileId, firstProfileId);
  assert.equal(buckets.size, 2);
  assert.equal(buckets.get(firstProfileId)!.speciesPersonal.bulbasaur.registered, true);
  assert.equal(buckets.get(secondProfileId)!.speciesPersonal.bulbasaur.registered, false);
  // Each bucket's own profile identity is correct, not both pointing at the same row.
  assert.equal(buckets.get(firstProfileId)!.profile.id, firstProfileId);
  assert.equal(buckets.get(secondProfileId)!.profile.id, secondProfileId);
});
```

- [ ] **Step 2: Run it — expect a failure**

```bash
npx tsx --test test/sqlite-repository-multi-profile-load.test.ts
```

Expected: FAIL — `loadAllProfiles` is not exported yet.

- [ ] **Step 3: Restructure `loadPersonalState` into `loadAllProfiles`**

In `src/data/sqlite-repository.ts`, rename the existing `loadPersonalState` function to `loadOneProfileState`, add a `profileId: string` parameter, and add a `WHERE profile_id = ?` clause to every query inside it (append `[profileId]` or, where a query already has bound params, append `profileId` to the existing array — check each site). Concretely, change every one of these lines:

```ts
for (const row of (await db.query("SELECT * FROM species_personal")).values ?? []) {
```
to:
```ts
for (const row of (await db.query("SELECT * FROM species_personal WHERE profile_id = ?", [profileId])).values ?? []) {
```

Apply the same `WHERE profile_id = ?` + `[profileId]` change to the queries against `form_personal`, `app_settings`, `mega_personal`, `form_background_personal`, `medal_progress_personal`, `pokemon_instance`, `tag`. For `player_progress_log`, change:

```ts
for (const row of (await db.query("SELECT * FROM player_progress_log ORDER BY recorded_at ASC")).values ?? []) {
```
to:
```ts
for (const row of (await db.query("SELECT * FROM player_progress_log WHERE profile_id = ? ORDER BY recorded_at ASC", [profileId])).values ?? []) {
```

For `player_progress_personal` (single row per profile), change:
```ts
const playerProgressRow = (await db.query("SELECT * FROM player_progress_personal")).values?.[0];
```
to:
```ts
const playerProgressRow = (await db.query("SELECT * FROM player_progress_personal WHERE profile_id = ?", [profileId])).values?.[0];
```

For `pokemon_instance_tag` (no `profile_id` column of its own — join against `pokemon_instance`), change:
```ts
for (const row of (await db.query("SELECT * FROM pokemon_instance_tag")).values ?? []) {
```
to:
```ts
for (const row of (
  await db.query(
    "SELECT pit.* FROM pokemon_instance_tag pit JOIN pokemon_instance pi ON pi.id = pit.pokemon_instance_id WHERE pi.profile_id = ?",
    [profileId],
  )
).values ?? []) {
```

For the `profile` row itself, change:
```ts
const profileRow = (await db.query("SELECT * FROM profile")).values![0];
```
to:
```ts
const profileRow = (await db.query("SELECT * FROM profile WHERE id = ?", [profileId])).values![0];
```

Rename the function signature from `async function loadPersonalState(db: Awaited<ReturnType<typeof getDb>>): Promise<PersonalState>` to `async function loadOneProfileState(db: Awaited<ReturnType<typeof getDb>>, profileId: string): Promise<PersonalState>`.

- [ ] **Step 4: Add the new `loadAllProfiles` function**

Add this new exported function right after `loadOneProfileState`:

```ts
export async function loadAllProfiles(
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<{ buckets: Map<string, PersonalState>; currentProfileId: string }> {
  const profileRows = (await db.query("SELECT id, is_current FROM profile")).values ?? [];
  const buckets = new Map<string, PersonalState>();
  let currentProfileId: string | undefined;
  for (const row of profileRows) {
    const state = await loadOneProfileState(db, row.id as string);
    buckets.set(row.id as string, state);
    if (row.is_current) currentProfileId = row.id as string;
  }
  if (!currentProfileId) throw new Error("No profile has is_current set — this should be impossible after runPersonalMigrations.");
  return { buckets, currentProfileId };
}
```

- [ ] **Step 5: Wire it into `createSqliteRepository`**

Change:

```ts
  const db = await getDb();
  await runPersonalMigrations(db);
  await syncReferenceData(db, referenceData);
  const state = await loadPersonalState(db);

  // Backfill any app-setting defaults the DB doesn't have a value for yet —
  // covers both a brand-new install (nothing set at all) and an existing
  // install that predates a newly-added default key. Never overwrites a
  // value the user (or a previous default) already set.
  for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
    if (state.appSettings[key] !== undefined) continue;
    state.appSettings[key] = value;
    await db.run("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
  }
  await persistDb();
```

to:

```ts
  const db = await getDb();
  await runPersonalMigrations(db);
  await syncReferenceData(db, referenceData);
  const { buckets: profileBuckets, currentProfileId } = await loadAllProfiles(db);
  const state = profileBuckets.get(currentProfileId)!;

  // Backfill any app-setting defaults a profile's row doesn't have a value
  // for yet — covers a brand-new install (nothing set at all), an existing
  // install that predates a newly-added default key, AND a freshly-created
  // second profile (app_settings is per-profile now — Task 8 seeds these
  // too at creation time, this loop is the boot-time safety net for
  // whichever profile is current). Never overwrites a value already set.
  for (const [profileId, bucket] of profileBuckets) {
    for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
      if (bucket.appSettings[key] !== undefined) continue;
      bucket.appSettings[key] = value;
      await db.run(
        "INSERT INTO app_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value",
        [profileId, key, value],
      );
    }
  }
  await persistDb();
```

(`state` is now one specific entry of `profileBuckets` — the rest of `createSqliteRepository`'s existing code, which reads/writes `state.xxx` throughout, needs zero further changes for this task; Task 8 adds `switchProfile` etc., which is what actually reassigns `state`'s fields to a different bucket.)

- [ ] **Step 6: Run the tests**

```bash
npx tsx --test test/sqlite-repository-multi-profile-load.test.ts
npx tsc -b
```

Expected: the new test passes; `tsc -b` still shows the same Task-8/Task-10 errors as before (nothing new introduced by this task).

- [ ] **Step 7: Commit**

```bash
git add src/data/sqlite-repository.ts test/sqlite-repository-multi-profile-load.test.ts
git commit -m "Load every local profile's data into memory at boot"
```

---

### Task 5: Write-path fixes for PK-widened tables

**Files:**
- Create: `src/data/profile-scoped-write-sql.ts`
- Modify: `src/data/sqlite-repository.ts`
- Test: `test/profile-scoped-write-sql.test.ts`

**Interfaces:**
- Produces: `buildSpeciesPersonalUpsert(profileId, speciesSlug, personal)`, `buildFormPersonalUpsert(profileId, personal)`, `buildMegaPersonalUpsert(profileId, megaVariantSlug, personal)`, `buildAppSettingUpsert(profileId, key, value)`, `buildFormBackgroundPersonalInsert(row)` — each returning `{ sql: string; params: unknown[] }`.

**Context:** `species_personal`/`form_personal`/`mega_personal`/`app_settings`'s `ON CONFLICT` targets must change to match their new composite PKs (Task 1), and every one of these writes must bind the *current* profile's id, captured synchronously at hook-fire time — not read again later inside the write queue's deferred closure, since a profile switch could happen in between and misattribute the write to the wrong profile.

- [ ] **Step 1: Write the failing test**

Create `test/profile-scoped-write-sql.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildSpeciesPersonalUpsert,
  buildFormPersonalUpsert,
  buildMegaPersonalUpsert,
  buildAppSettingUpsert,
  buildFormBackgroundPersonalInsert,
} from "../src/data/profile-scoped-write-sql";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE species_personal (species_slug TEXT NOT NULL, profile_id TEXT NOT NULL, registered INTEGER NOT NULL DEFAULT 0, xxl INTEGER NOT NULL DEFAULT 0, xxs INTEGER NOT NULL DEFAULT 0, purified INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, species_slug));
    CREATE TABLE app_settings (key TEXT NOT NULL, profile_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (profile_id, key));
    CREATE TABLE mega_personal (mega_variant_slug TEXT NOT NULL, profile_id TEXT NOT NULL, evolved INTEGER NOT NULL DEFAULT 0, shiny_evolved INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, mega_variant_slug));
    CREATE TABLE form_background_personal (form_slug TEXT NOT NULL, profile_id TEXT NOT NULL, achievement_field TEXT NOT NULL, background_slug TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, form_slug, achievement_field, background_slug));
  `);
  return db;
}

test("buildSpeciesPersonalUpsert scopes two profiles' rows for the same species independently", () => {
  const db = freshDb();
  const first = buildSpeciesPersonalUpsert("profile-a", "bulbasaur", { registered: true, xxl: false, xxs: false, purified: false, updatedAt: 1 });
  const second = buildSpeciesPersonalUpsert("profile-b", "bulbasaur", { registered: false, xxl: false, xxs: false, purified: false, updatedAt: 2 });
  db.prepare(first.sql).run(...(first.params as never[]));
  db.prepare(second.sql).run(...(second.params as never[]));

  const rows = db.prepare("SELECT profile_id, registered FROM species_personal ORDER BY profile_id").all();
  assert.deepEqual(rows, [
    { profile_id: "profile-a", registered: 1 },
    { profile_id: "profile-b", registered: 0 },
  ]);

  // Re-upserting the same profile+slug updates in place, doesn't duplicate.
  const update = buildSpeciesPersonalUpsert("profile-a", "bulbasaur", { registered: false, xxl: false, xxs: false, purified: false, updatedAt: 3 });
  db.prepare(update.sql).run(...(update.params as never[]));
  const afterUpdate = db.prepare("SELECT COUNT(*) as c FROM species_personal WHERE profile_id = 'profile-a'").get() as { c: number };
  assert.equal(afterUpdate.c, 1);
});

test("buildAppSettingUpsert scopes settings per profile independently", () => {
  const db = freshDb();
  const a = buildAppSettingUpsert("profile-a", "theme", "dark");
  const b = buildAppSettingUpsert("profile-b", "theme", "light");
  db.prepare(a.sql).run(...(a.params as never[]));
  db.prepare(b.sql).run(...(b.params as never[]));
  const rows = db.prepare("SELECT profile_id, value FROM app_settings ORDER BY profile_id").all();
  assert.deepEqual(rows, [
    { profile_id: "profile-a", value: "dark" },
    { profile_id: "profile-b", value: "light" },
  ]);
});

test("buildFormBackgroundPersonalInsert includes profile_id and is idempotent per profile+form+field+background", () => {
  const db = freshDb();
  const row = { formSlug: "pikachu-standard", profileId: "profile-a", achievementField: "shiny" as const, backgroundSlug: "gardevoir-bg", updatedAt: 1 };
  const insert = buildFormBackgroundPersonalInsert(row);
  db.prepare(insert.sql).run(...(insert.params as never[]));
  db.prepare(insert.sql).run(...(insert.params as never[])); // re-insert, must not throw (INSERT OR IGNORE)
  const count = db.prepare("SELECT COUNT(*) as c FROM form_background_personal").get() as { c: number };
  assert.equal(count.c, 1);
});
```

- [ ] **Step 2: Run it — expect a failure**

```bash
npx tsx --test test/profile-scoped-write-sql.test.ts
```

Expected: FAIL — `src/data/profile-scoped-write-sql.ts` doesn't exist yet.

- [ ] **Step 3: Create `src/data/profile-scoped-write-sql.ts`**

```ts
// Pure SQL-builder functions for the write paths whose target table's
// primary key includes profile_id (species_personal, form_personal,
// mega_personal, app_settings, form_background_personal) — extracted so
// they're testable against a real node:sqlite DatabaseSync without needing
// sqlite-repository.ts's full Tauri-connected bootstrap. Each ON CONFLICT
// target matches the composite PK these tables were widened to in this
// sub-project's migration (see docs/superpowers/plans/2026-07-25-sub-project-7a-local-multi-account.md).

import { FORM_PERSONAL_BOOLEAN_FIELDS, FORM_PERSONAL_FIELD_COLUMNS, type FormBackgroundPersonal, type FormPersonal, type MegaPersonal, type SpeciesPersonal } from "../db/types";

export interface SqlStatement {
  sql: string;
  params: unknown[];
}

export function buildSpeciesPersonalUpsert(profileId: string, speciesSlug: string, personal: Omit<SpeciesPersonal, "speciesSlug">): SqlStatement {
  return {
    sql: `INSERT INTO species_personal (profile_id, species_slug, registered, xxl, xxs, purified, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, species_slug) DO UPDATE SET registered = excluded.registered, xxl = excluded.xxl, xxs = excluded.xxs, purified = excluded.purified, updated_at = excluded.updated_at`,
    params: [profileId, speciesSlug, personal.registered ? 1 : 0, personal.xxl ? 1 : 0, personal.xxs ? 1 : 0, personal.purified ? 1 : 0, personal.updatedAt],
  };
}

const FORM_PERSONAL_COLUMNS = [...FORM_PERSONAL_BOOLEAN_FIELDS.map((f) => FORM_PERSONAL_FIELD_COLUMNS[f]), "best_shiny", "best_non_shiny", "best_lucky", "updated_at"];

export function buildFormPersonalUpsert(profileId: string, personal: FormPersonal): SqlStatement {
  const columns = ["profile_id", "form_slug", ...FORM_PERSONAL_COLUMNS];
  const placeholders = columns.map(() => "?").join(", ");
  const updates = FORM_PERSONAL_COLUMNS.map((c) => `${c} = excluded.${c}`).join(", ");
  const params: unknown[] = [profileId, personal.formSlug];
  for (const field of FORM_PERSONAL_BOOLEAN_FIELDS) params.push(personal[field] ? 1 : 0);
  params.push(personal.bestShiny, personal.bestNonShiny, personal.bestLucky, personal.updatedAt);
  return {
    sql: `INSERT INTO form_personal (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT(profile_id, form_slug) DO UPDATE SET ${updates}`,
    params,
  };
}

export function buildMegaPersonalUpsert(profileId: string, megaVariantSlug: string, personal: Omit<MegaPersonal, "megaVariantSlug">): SqlStatement {
  return {
    sql: `INSERT INTO mega_personal (profile_id, mega_variant_slug, evolved, shiny_evolved, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, mega_variant_slug) DO UPDATE SET evolved = excluded.evolved, shiny_evolved = excluded.shiny_evolved, updated_at = excluded.updated_at`,
    params: [profileId, megaVariantSlug, personal.evolved ? 1 : 0, personal.shinyEvolved ? 1 : 0, personal.updatedAt],
  };
}

export function buildAppSettingUpsert(profileId: string, key: string, value: string): SqlStatement {
  return {
    sql: "INSERT INTO app_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value",
    params: [profileId, key, value],
  };
}

export function buildFormBackgroundPersonalInsert(row: FormBackgroundPersonal): SqlStatement {
  return {
    sql: "INSERT OR IGNORE INTO form_background_personal (profile_id, form_slug, achievement_field, background_slug, updated_at) VALUES (?, ?, ?, ?, ?)",
    params: [row.profileId, row.formSlug, row.achievementField, row.backgroundSlug, row.updatedAt],
  };
}
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
npx tsx --test test/profile-scoped-write-sql.test.ts
```

Expected: `tests 3, pass 3, fail 0`.

- [ ] **Step 5: Wire the builders into `sqlite-repository.ts`'s hooks**

Add the import:

```ts
import { buildSpeciesPersonalUpsert, buildFormPersonalUpsert, buildMegaPersonalUpsert, buildAppSettingUpsert, buildFormBackgroundPersonalInsert } from "./profile-scoped-write-sql";
```

Remove the now-unused local `upsertFormPersonalSql`/`formPersonalValues`/`FORM_PERSONAL_COLUMNS` functions (lines 55-69) — they're replaced by `buildFormPersonalUpsert`.

Change `onSpeciesPersonalChanged`:

```ts
    onSpeciesPersonalChanged(speciesSlug, personal) {
      const inBulk = bulkDepth > 0;
      const profileId = state.profile.id;
      enqueueWrite(async () => {
        const { sql, params } = buildSpeciesPersonalUpsert(profileId, speciesSlug, personal);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
```

Change `onFormPersonalChanged`:

```ts
    onFormPersonalChanged(_formSlug, personal) {
      const inBulk = bulkDepth > 0;
      const profileId = state.profile.id;
      enqueueWrite(async () => {
        const { sql, params } = buildFormPersonalUpsert(profileId, personal);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
```

Change `onAppSettingChanged`:

```ts
    onAppSettingChanged(key, value) {
      const inBulk = bulkDepth > 0;
      const profileId = state.profile.id;
      enqueueWrite(async () => {
        const { sql, params } = buildAppSettingUpsert(profileId, key, value);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
```

Change `onMegaPersonalChanged`:

```ts
    onMegaPersonalChanged(megaVariantSlug, personal) {
      const inBulk = bulkDepth > 0;
      const profileId = state.profile.id;
      enqueueWrite(async () => {
        const { sql, params } = buildMegaPersonalUpsert(profileId, megaVariantSlug, personal);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
```

Change `onFormBackgroundPersonalAdded`:

```ts
    onFormBackgroundPersonalAdded(row) {
      const inBulk = bulkDepth > 0;
      enqueueWrite(async () => {
        const { sql, params } = buildFormBackgroundPersonalInsert(row);
        await db.run(sql, params, !inBulk);
        if (!inBulk) await persistDb();
      });
    },
```

(`onFormBackgroundPersonalAdded`'s `row` already carries `profileId` per Task 3's type change — no separate synchronous capture needed here, unlike the others, since the id travels with the data object itself.)

Also fix the `DEFAULT_APP_SETTINGS` backfill loop from Task 4 Step 5 to use the new builder (replacing its inline SQL):

```ts
  for (const [profileId, bucket] of profileBuckets) {
    for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
      if (bucket.appSettings[key] !== undefined) continue;
      bucket.appSettings[key] = value;
      const { sql, params } = buildAppSettingUpsert(profileId, key, value);
      await db.run(sql, params);
    }
  }
```

- [ ] **Step 6: Run the full suite**

```bash
npx tsc -b
npm test
```

Expected: `tsc -b` clean for everything this task touches (Task 8/10's errors, if any remain unaddressed by this point, are expected and unrelated). All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/data/profile-scoped-write-sql.ts src/data/sqlite-repository.ts test/profile-scoped-write-sql.test.ts
git commit -m "Scope species/form/mega/app_settings writes to the current profile"
```

---

### Task 6: `state.currentProfileId` field + capture-at-fire-time audit

**Files:**
- Modify: `src/data/in-memory-store.ts`
- Modify: `src/data/sqlite-repository.ts`

**Interfaces:**
- Produces: `PersonalState.currentProfileId` is NOT added as a separate field — Task 5 already uses `state.profile.id` directly, which is correct and simpler (there is no separate pointer to keep in sync; `state.profile` IS the current profile's identity, reassigned on switch in Task 8). This task instead audits every remaining write hook to confirm none of them re-read `state.profile.id` *inside* an `enqueueWrite` closure (which would be the landmine: reading it late, after a possible switch, instead of at hook-fire time).

**Context:** `onMedalProgressChanged`/`onPlayerProgressChanged`/`onPlayerProgressLogAppended` already receive a `profileId` field on their data argument (`progress.profileId`/`entry.profileId`), stamped by `in-memory-store.ts`'s `applyMedalProgress`/`applyPlayerProgress` at the exact synchronous moment those functions run (confirmed: `state.profile.id` is read synchronously inside `applyMedalProgress`, before the hook fires) — these three hooks need NO changes. This task is verification + a docs comment, not new logic, except for confirming `onPokemonInstanceStatusChanged` doesn't need a profile_id at all (it's an `UPDATE ... WHERE id = ?` against `pokemon_instance`'s own un-widened PK — the row already belongs to whichever profile it belongs to; changing its status never needs to know or care which profile that is).

- [ ] **Step 1: Read and confirm — no code change needed for the three already-correct hooks**

Open `src/data/sqlite-repository.ts` and confirm `onMedalProgressChanged`, `onPlayerProgressChanged`, and `onPlayerProgressLogAppended` (search for these three function names) each bind `progress.profileId` / `entry.profileId` from their function argument, NOT from `state.profile.id` read inside the `enqueueWrite` closure. They already do — no edit needed.

- [ ] **Step 2: Confirm `onPokemonInstanceStatusChanged` doesn't need profile scoping**

Confirm this hook's SQL is `UPDATE pokemon_instance SET status = ?, updated_at = ? WHERE id = ?` — no `profile_id` in the WHERE clause, and that's correct: `pokemon_instance.id` is a globally-unique AUTOINCREMENT integer (not touched by this sub-project), so `WHERE id = ?` alone is already unambiguous regardless of how many profiles exist. No edit needed.

- [ ] **Step 3: Add a one-line clarifying comment above the write-hooks block**

In `src/data/sqlite-repository.ts`, immediately above the `const repo = createInMemoryRepository(referenceData, state, {` line, add:

```ts
  // Every hook below that writes a row scoped by profile_id captures
  // `state.profile.id` SYNCHRONOUSLY, in the hook body itself (not inside
  // the enqueueWrite closure) — the hook fires synchronously from
  // in-memory-store.ts's apply*() functions, at the exact moment the edit
  // happens, before any later profile switch could change what
  // `state.profile.id` means. Capturing it inside enqueueWrite's deferred
  // closure instead would bind the WRONG profile if a switch happens between
  // the edit and the write actually flushing.
```

- [ ] **Step 4: Run the full suite (no behavior change, sanity check only)**

```bash
npx tsc -b
npm test
```

Expected: clean, identical results to Task 5's end state.

- [ ] **Step 5: Commit**

```bash
git add src/data/sqlite-repository.ts
git commit -m "Document the capture-at-fire-time invariant for profile-scoped writes"
```

---

### Task 7: Profile-scope the Completion Stats SQL

**Files:**
- Modify: `src/data/completion-stats-sql.ts`
- Modify: `src/data/sqlite-repository.ts` (the one call site)
- Test: `test/completion-stats-sql.test.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `state.profile.id` (current profile).
- Produces: `getCompletionStatsSql(conn, profileId, scope, lenses, excludeRegionalFromFormComplete)` — signature gains a `profileId: string` parameter.

**Context:** Every lens function does a `leftJoin` against `speciesPersonal`/`formPersonal` with no profile filter. After Task 1's PK widening, an unfiltered `leftJoin` would match *every* profile's row for a given slug — a fan-out that double/triple-counts once a second profile exists. The fix: add the profile filter to the JOIN's `ON` condition (not a separate `WHERE`), so species/forms with no row at all for this specific profile still appear (correctly, as "not yet registered/caught" — the whole point of a LEFT JOIN).

- [ ] **Step 1: Read the full file to find every lens function**

```bash
grep -n "^async function.*Lens\b" src/data/completion-stats-sql.ts
```

Expected output: `registeredLens`, `formCompleteLens`, `costumeCompleteLens`, `gigantamaxCompleteLens`, `megaCompleteLens`, `achievementLens` (six functions — `megaCompleteLens` is called twice with different args for the two mega-related lenses, it's still one function).

- [ ] **Step 2: Add `profileId` as a parameter to every lens function and `getCompletionStatsSql` itself**

Change the exported entry point:

```ts
export async function getCompletionStatsSql(
  conn: SQLiteDBConnection,
  scope: CompletionScope,
  lenses: CompletionLens[],
  excludeRegionalFromFormComplete: boolean,
): Promise<CompletionLensResult[]> {
```

to:

```ts
export async function getCompletionStatsSql(
  conn: SQLiteDBConnection,
  profileId: string,
  scope: CompletionScope,
  lenses: CompletionLens[],
  excludeRegionalFromFormComplete: boolean,
): Promise<CompletionLensResult[]> {
```

Inside the same function, add `profileId` to every lens call — change:

```ts
    const partial =
      lens.kind === "registered"
        ? await registeredLens(db, scope)
        : lens.kind === "formComplete"
          ? await formCompleteLens(db, scope, excludeRegionalFromFormComplete)
          : lens.kind === "costumeComplete"
            ? await costumeCompleteLens(db, scope)
            : lens.kind === "gigantamaxComplete"
              ? await gigantamaxCompleteLens(db, scope)
              : lens.kind === "megaComplete"
                ? await megaCompleteLens(db, scope, false)
                : lens.kind === "megaShinyComplete"
                  ? await megaCompleteLens(db, scope, true)
                  : await achievementLens(db, scope, lens.field);
```

to:

```ts
    const partial =
      lens.kind === "registered"
        ? await registeredLens(db, profileId, scope)
        : lens.kind === "formComplete"
          ? await formCompleteLens(db, profileId, scope, excludeRegionalFromFormComplete)
          : lens.kind === "costumeComplete"
            ? await costumeCompleteLens(db, profileId, scope)
            : lens.kind === "gigantamaxComplete"
              ? await gigantamaxCompleteLens(db, profileId, scope)
              : lens.kind === "megaComplete"
                ? await megaCompleteLens(db, profileId, scope, false)
                : lens.kind === "megaShinyComplete"
                  ? await megaCompleteLens(db, profileId, scope, true)
                  : await achievementLens(db, profileId, scope, lens.field);
```

- [ ] **Step 3: Fix `registeredLens` — the worked example**

Change:

```ts
async function registeredLens(db: DrizzleDb, scope: CompletionScope): Promise<Omit<CompletionLensResult, "lens">> {
  const scopeCond = scopeCondition(scope);
  const total = await countSpecies(db, scopeCond);
  const missingRows = await db
    .select({ slug: species.slug, name: species.name, dexNumber: species.dexNumber })
    .from(species)
    .leftJoin(speciesPersonal, eq(speciesPersonal.speciesSlug, species.slug))
    .where(and(scopeCond, or(isNull(speciesPersonal.registered), eq(speciesPersonal.registered, false))));
  const missingSpecies = toMissing(missingRows);
  return { total, complete: total - missingSpecies.length, missingSpecies };
}
```

to:

```ts
async function registeredLens(db: DrizzleDb, profileId: string, scope: CompletionScope): Promise<Omit<CompletionLensResult, "lens">> {
  const scopeCond = scopeCondition(scope);
  const total = await countSpecies(db, scopeCond);
  const missingRows = await db
    .select({ slug: species.slug, name: species.name, dexNumber: species.dexNumber })
    .from(species)
    .leftJoin(speciesPersonal, and(eq(speciesPersonal.speciesSlug, species.slug), eq(speciesPersonal.profileId, profileId)))
    .where(and(scopeCond, or(isNull(speciesPersonal.registered), eq(speciesPersonal.registered, false))));
  const missingSpecies = toMissing(missingRows);
  return { total, complete: total - missingSpecies.length, missingSpecies };
}
```

(The change: add `profileId: string` as the second parameter, and change the `leftJoin`'s join condition from a single `eq(...)` to `and(eq(speciesPersonal.speciesSlug, species.slug), eq(speciesPersonal.profileId, profileId))`.)

- [ ] **Step 4: Apply the identical pattern to the remaining five lens functions**

For each of `formCompleteLens`, `costumeCompleteLens`, `gigantamaxCompleteLens`, `megaCompleteLens`, `achievementLens`:
1. Add `profileId: string` as the second parameter (right after `db: DrizzleDb`).
2. Find every `.leftJoin(speciesPersonal, ...)` or `.leftJoin(formPersonal, ...)` or `.leftJoin(megaPersonal, ...)` call in that function and wrap its existing join condition in `and(existingCondition, eq(<table>.profileId, profileId))`.
3. If the function's `WHERE`/join conditions reference `formPersonal` more than once (check each function individually — `formCompleteLens`'s `innerConditions` array builds up multiple conditions against `formPersonal` before being combined), add the `eq(formPersonal.profileId, profileId)` condition once, into whichever single join actually pulls in the `formPersonal` table (not into every condition that merely references one of its columns).

Read each function's current body before editing — the exact join shape differs slightly per lens (e.g. `achievementLens` joins on a specific `lens.field` column, `megaCompleteLens` joins `megaPersonal` instead of `speciesPersonal`/`formPersonal`) — apply the same "add `profileId` to the join's `ON` condition" principle to whichever profile-scoped table each function actually joins against.

- [ ] **Step 5: Update the one call site in `sqlite-repository.ts`**

Find `getCompletionStatsSql(` in `src/data/sqlite-repository.ts` and add `state.profile.id` as the second argument:

```ts
getCompletionStats(scope, lenses, excludeRegionalFromFormComplete) {
  return getCompletionStatsSql(db, state.profile.id, scope, lenses, excludeRegionalFromFormComplete);
},
```

(Adjust to match the exact existing parameter names/order at that call site — the only change is inserting `state.profile.id` as the second positional argument.)

- [ ] **Step 6: Extend `test/completion-stats-sql.test.ts`**

Add a test seeding two profiles with different `species_personal.registered` values for the same species (mirroring Task 1's migration test's fixture pattern), asserting `getCompletionStatsSql` with profile A's id returns different `complete`/`missingSpecies` counts than profile B's id — proving the JOIN's profile filter actually isolates them, not just that the function still runs.

- [ ] **Step 7: Run the tests**

```bash
npx tsx --test test/completion-stats-sql.test.ts
npx tsc -b
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/data/completion-stats-sql.ts src/data/sqlite-repository.ts test/completion-stats-sql.test.ts
git commit -m "Profile-scope every Completion Stats lens"
```

---

### Task 8: Profile CRUD methods

**Files:**
- Create: `src/data/profile-management-sql.ts`
- Modify: `src/data/sqlite-repository.ts`
- Test: `test/profile-management-sql.test.ts`, `test/sqlite-repository-profile-crud.test.ts`

**Interfaces:**
- Produces: `buildProfileDeleteStatements(profileId): SqlStatement[]` (cascade DELETE list, exported for testability); `listProfiles`, `getCurrentProfile`, `createProfile`, `switchProfile`, `renameProfile`, `deleteProfile` added to the object `createSqliteRepository` returns.

- [ ] **Step 1: Write the failing test for the cascade-delete SQL builder**

Create `test/profile-management-sql.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildProfileDeleteStatements } from "../src/data/profile-management-sql";

test("buildProfileDeleteStatements removes exactly one profile's rows across every profile-scoped table, leaving others untouched", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE profile (id TEXT PRIMARY KEY, username TEXT NOT NULL, is_current INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE species_personal (species_slug TEXT NOT NULL, profile_id TEXT NOT NULL REFERENCES profile(id), registered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, species_slug));
    CREATE TABLE pokemon_instance (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profile(id));
    CREATE TABLE pokemon_instance_tag (pokemon_instance_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (pokemon_instance_id, tag_id));
    CREATE TABLE pokemon_instance_max_move (pokemon_instance_id INTEGER NOT NULL, move_slot TEXT NOT NULL, PRIMARY KEY (pokemon_instance_id, move_slot));
    CREATE TABLE tag (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profile(id), name TEXT NOT NULL);

    INSERT INTO profile (id, username, created_at) VALUES ('a', 'A', 0), ('b', 'B', 0);
    INSERT INTO species_personal (species_slug, profile_id, registered) VALUES ('bulbasaur', 'a', 1), ('bulbasaur', 'b', 1);
    INSERT INTO pokemon_instance (id, profile_id) VALUES (1, 'a'), (2, 'b');
    INSERT INTO tag (id, profile_id, name) VALUES (10, 'a', 'shiny'), (20, 'b', 'shiny');
    INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (1, 10), (2, 20);
    INSERT INTO pokemon_instance_max_move (pokemon_instance_id, move_slot) VALUES (1, 'slot1');
  `);

  const statements = buildProfileDeleteStatements("a");
  db.exec("PRAGMA defer_foreign_keys = true;");
  for (const { sql, params } of statements) {
    db.prepare(sql).run(...(params as never[]));
  }

  assert.equal((db.prepare("SELECT COUNT(*) as c FROM profile WHERE id = 'a'").get() as { c: number }).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM species_personal WHERE profile_id = 'a'").get() as { c: number }).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM pokemon_instance WHERE profile_id = 'a'").get() as { c: number }).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM tag WHERE profile_id = 'a'").get() as { c: number }).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM pokemon_instance_tag WHERE pokemon_instance_id = 1").get() as { c: number }).c, 0);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM pokemon_instance_max_move WHERE pokemon_instance_id = 1").get() as { c: number }).c, 0);

  // Profile B's data is completely untouched.
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM profile WHERE id = 'b'").get() as { c: number }).c, 1);
  assert.equal((db.prepare("SELECT registered FROM species_personal WHERE profile_id = 'b'").get() as { registered: number }).registered, 1);
  assert.equal((db.prepare("SELECT COUNT(*) as c FROM pokemon_instance_tag WHERE pokemon_instance_id = 2").get() as { c: number }).c, 1);
});
```

- [ ] **Step 2: Run it — expect a failure**

```bash
npx tsx --test test/profile-management-sql.test.ts
```

Expected: FAIL — `src/data/profile-management-sql.ts` doesn't exist yet.

- [ ] **Step 3: Create `src/data/profile-management-sql.ts`**

```ts
// Pure SQL-builder functions for profile CRUD's cascade-delete — extracted
// for direct testability against a real node:sqlite DatabaseSync, same
// reasoning as src/data/profile-scoped-write-sql.ts. Statements are
// returned in an order that's FK-safe only when run with
// `PRAGMA defer_foreign_keys = true` inside a transaction, matching
// reference-sync.ts's established pattern — pokemon_instance_tag/
// pokemon_instance_max_move reference pokemon_instance.id, and are deleted
// via a subquery scoped to this profile's own instances, not their own
// profile_id column (they don't have one).

import type { SqlStatement } from "./profile-scoped-write-sql";

export function buildProfileDeleteStatements(profileId: string): SqlStatement[] {
  return [
    {
      sql: "DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id IN (SELECT id FROM pokemon_instance WHERE profile_id = ?)",
      params: [profileId],
    },
    {
      sql: "DELETE FROM pokemon_instance_max_move WHERE pokemon_instance_id IN (SELECT id FROM pokemon_instance WHERE profile_id = ?)",
      params: [profileId],
    },
    { sql: "DELETE FROM pokemon_instance WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM tag WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM species_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM form_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM mega_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM form_background_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM app_settings WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM player_progress_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM player_progress_log WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM medal_progress_personal WHERE profile_id = ?", params: [profileId] },
    { sql: "DELETE FROM profile WHERE id = ?", params: [profileId] },
  ];
}
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
npx tsx --test test/profile-management-sql.test.ts
```

- [ ] **Step 5: Implement the six repository methods in `sqlite-repository.ts`**

Add the import:

```ts
import { buildProfileDeleteStatements } from "./profile-management-sql";
```

Find the closing of the `const repo = createInMemoryRepository(...)` object (the `};` after `onPokemonInstanceStatusChanged`) and, after `const repo = ...` is fully assigned but before the function's final `return { ...repo, ... }` (this file's established pattern for sqlite-only methods per Sub-project 5's precedent), add:

```ts
  function listProfiles(): Profile[] {
    return [...profileBuckets.values()].map((bucket) => bucket.profile);
  }

  function getCurrentProfile(): Profile {
    return state.profile;
  }

  async function createProfile(username: string, friendCode: string | null): Promise<Profile> {
    const newProfile: Profile = { id: crypto.randomUUID(), username, friendCode, createdAt: Date.now() };
    await db.run("INSERT INTO profile (id, username, friend_code, is_current, created_at) VALUES (?, ?, ?, 0, ?)", [
      newProfile.id,
      newProfile.username,
      newProfile.friendCode,
      newProfile.createdAt,
    ]);
    const newBucket: PersonalState = {
      speciesPersonal: {},
      formPersonal: {},
      appSettings: {},
      megaPersonal: {},
      formBackgroundPersonal: [],
      medalProgress: {},
      pokemonInstances: [],
      tags: [],
      pokemonInstanceTags: [],
      playerProgress: undefined,
      playerProgressLog: [],
      profile: newProfile,
    };
    for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
      newBucket.appSettings[key] = value;
      const { sql, params } = buildAppSettingUpsert(newProfile.id, key, value);
      await db.run(sql, params);
    }
    profileBuckets.set(newProfile.id, newBucket);
    await persistDb();
    return newProfile;
  }

  function switchProfile(profileId: string): void {
    const bucket = profileBuckets.get(profileId);
    if (!bucket) throw new Error(`Unknown profile: ${profileId}`);
    state.speciesPersonal = bucket.speciesPersonal;
    state.formPersonal = bucket.formPersonal;
    state.appSettings = bucket.appSettings;
    state.megaPersonal = bucket.megaPersonal;
    state.formBackgroundPersonal = bucket.formBackgroundPersonal;
    state.medalProgress = bucket.medalProgress;
    state.pokemonInstances = bucket.pokemonInstances;
    state.tags = bucket.tags;
    state.pokemonInstanceTags = bucket.pokemonInstanceTags;
    state.playerProgress = bucket.playerProgress;
    state.playerProgressLog = bucket.playerProgressLog;
    state.profile = bucket.profile;
    enqueueWrite(async () => {
      await db.beginTransaction();
      try {
        await db.run("UPDATE profile SET is_current = 0 WHERE is_current = 1", [], false);
        await db.run("UPDATE profile SET is_current = 1 WHERE id = ?", [profileId], false);
        await db.commitTransaction();
      } catch (err) {
        await db.rollbackTransaction();
        throw err;
      }
      await persistDb();
    });
  }

  async function renameProfile(profileId: string, username: string, friendCode: string | null): Promise<void> {
    const bucket = profileBuckets.get(profileId);
    if (!bucket) throw new Error(`Unknown profile: ${profileId}`);
    const updated: Profile = { ...bucket.profile, username, friendCode };
    bucket.profile = updated;
    if (profileId === state.profile.id) state.profile = updated;
    await db.run("UPDATE profile SET username = ?, friend_code = ? WHERE id = ?", [username, friendCode, profileId]);
    await persistDb();
  }

  async function deleteProfile(profileId: string): Promise<void> {
    if (profileBuckets.size <= 1) throw new Error("Cannot delete the only remaining profile.");
    if (!profileBuckets.has(profileId)) throw new Error(`Unknown profile: ${profileId}`);
    if (profileId === state.profile.id) {
      const anotherId = [...profileBuckets.keys()].find((id) => id !== profileId)!;
      switchProfile(anotherId);
      await writeQueue; // let switchProfile's is_current flip land before the delete below
    }
    profileBuckets.delete(profileId);
    await db.beginTransaction();
    try {
      await db.run("PRAGMA defer_foreign_keys = true", [], false);
      for (const { sql, params } of buildProfileDeleteStatements(profileId)) {
        await db.run(sql, params, false);
      }
      await db.commitTransaction();
    } catch (err) {
      await db.rollbackTransaction();
      throw err;
    }
    await persistDb();
  }
```

Then change the function's final return statement — find:

```ts
  return { ...repo, getCompletionStats, createPokemonInstances, createTag, updatePokemonInstance, listBackgrounds, getTagUsageCounts, renameTag, deleteTag };
```

(exact existing list may differ slightly — match whatever the current file has) and add the six new methods:

```ts
  return {
    ...repo,
    getCompletionStats,
    createPokemonInstances,
    createTag,
    updatePokemonInstance,
    listBackgrounds,
    getTagUsageCounts,
    renameTag,
    deleteTag,
    listProfiles,
    getCurrentProfile,
    createProfile,
    switchProfile,
    renameProfile,
    deleteProfile,
  };
```

- [ ] **Step 6: Write `test/sqlite-repository-profile-crud.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqliteConnection } from "./node-sqlite-connection";

// This test exercises loadAllProfiles + the profile-scoped write builders
// together, at the level createSqliteRepository's own logic operates on —
// not through the full Tauri-connected repository (not constructible under
// node:test), but through the same functions it calls internally.
import { loadAllProfiles } from "../src/data/sqlite-repository";
import { buildProfileDeleteStatements } from "../src/data/profile-management-sql";
import { buildSpeciesPersonalUpsert } from "../src/data/profile-scoped-write-sql";
import { runPersonalMigrations } from "../src/db/migrations";
import { REFERENCE_SCHEMA_SQL } from "../src/db/schema";

test("two profiles' species_personal writes stay isolated after loading both", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);
  const firstId = (db.prepare("SELECT id FROM profile").get() as { id: string }).id;
  const secondId = "33333333-3333-3333-3333-333333333333";
  db.exec(`INSERT INTO profile (id, username, is_current, created_at) VALUES ('${secondId}', 'Second', 0, 0)`);
  db.exec(`INSERT INTO regions (slug, name) VALUES ('kanto', 'Kanto')`);
  db.exec(
    `INSERT INTO species (slug, dex_number, name, family_slug, gen, rarity, region_slug, has_male, has_female, can_mega_evolve, can_gigantamax) VALUES ('bulbasaur', 1, 'Bulbasaur', 'bulbasaur', 1, 'standard', 'kanto', 1, 1, 0, 0)`,
  );

  const first = buildSpeciesPersonalUpsert(firstId, "bulbasaur", { registered: true, xxl: false, xxs: false, purified: false, updatedAt: 1 });
  const second = buildSpeciesPersonalUpsert(secondId, "bulbasaur", { registered: false, xxl: false, xxs: false, purified: false, updatedAt: 2 });
  db.prepare(first.sql).run(...(first.params as never[]));
  db.prepare(second.sql).run(...(second.params as never[]));

  const { buckets } = await loadAllProfiles(conn);
  assert.equal(buckets.get(firstId)!.speciesPersonal.bulbasaur.registered, true);
  assert.equal(buckets.get(secondId)!.speciesPersonal.bulbasaur.registered, false);
});

test("deleting a profile removes exactly its own species_personal row", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(REFERENCE_SCHEMA_SQL);
  const conn = nodeSqliteConnection(db);
  await runPersonalMigrations(conn);
  const firstId = (db.prepare("SELECT id FROM profile").get() as { id: string }).id;
  const secondId = "44444444-4444-4444-4444-444444444444";
  db.exec(`INSERT INTO profile (id, username, is_current, created_at) VALUES ('${secondId}', 'Second', 0, 0)`);

  db.exec("PRAGMA defer_foreign_keys = true;");
  for (const { sql, params } of buildProfileDeleteStatements(secondId)) {
    db.prepare(sql).run(...(params as never[]));
  }
  const remaining = db.prepare("SELECT id FROM profile").all() as { id: string }[];
  assert.deepEqual(remaining, [{ id: firstId }]);
});
```

- [ ] **Step 7: Run the tests**

```bash
npx tsx --test test/sqlite-repository-profile-crud.test.ts
npx tsc -b
npm test
```

Expected: all pass; `tsc -b` clean except for `TrainerPage.vue` (Task 10).

- [ ] **Step 8: Commit**

```bash
git add src/data/profile-management-sql.ts src/data/sqlite-repository.ts test/profile-management-sql.test.ts test/sqlite-repository-profile-crud.test.ts
git commit -m "Implement listProfiles/createProfile/switchProfile/renameProfile/deleteProfile"
```

---

### Task 9: Fix downstream consumers of `profile_id`

**Files:**
- Modify: `src/data/personal-demo-seed.ts`
- Modify: `scripts/build-dummy-db.ts`

**Interfaces:**
- Consumes: `runPersonalMigrations` (now seeds a real UUID profile — Task 2).

**Context:** `personal-demo-seed.ts`'s exported rows have no `profileId` field (they predate multi-account), and `build-dummy-db.ts`'s generic `insertAll` helper relies on `profile_id`'s old `DEFAULT 1` — which Task 1 removed. Without this fix, `npm run build:dummy-db` breaks (`NOT NULL constraint failed: species_personal.profile_id`).

- [ ] **Step 1: Add `profileId` to every row in `src/data/personal-demo-seed.ts`**

Read the full file first:

```bash
cat src/data/personal-demo-seed.ts
```

Add a `profileId: string` field to every exported row object (`speciesPersonal`, `formPersonal`, `megaPersonal`, `formBackgroundPersonal`), using a placeholder value that `build-dummy-db.ts` will substitute with the real generated profile id before inserting (Step 2). Use the literal string `"__DEMO_PROFILE_ID__"` as that placeholder — e.g.:

```ts
export const speciesPersonal: SpeciesPersonal[] = [
  { speciesSlug: "bulbasaur", profileId: "__DEMO_PROFILE_ID__", registered: true, xxl: false, xxs: false, purified: false, updatedAt: DEMO_UPDATED_AT },
  { speciesSlug: "charizard", profileId: "__DEMO_PROFILE_ID__", registered: true, xxl: true, xxs: false, purified: false, updatedAt: DEMO_UPDATED_AT },
  // ...every other existing row gets the same profileId field added...
];
```

Apply the same `profileId: "__DEMO_PROFILE_ID__"` addition to every row across all four exported arrays in this file (`speciesPersonal`, `formPersonal`, `megaPersonal`, `formBackgroundPersonal`) — read each array's current rows and add the field to each one, preserving every other field exactly as-is.

- [ ] **Step 2: Substitute the real profile id in `scripts/build-dummy-db.ts`**

After the existing `await runPersonalMigrations(nodeSqliteConnection(db));` line, add:

```ts
const seededProfile = db.prepare("SELECT id FROM profile").get() as { id: string };
const DEMO_PROFILE_ID = seededProfile.id;

function withDemoProfileId<T extends { profileId: string }>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row, profileId: DEMO_PROFILE_ID }));
}
```

Find the `insertAll` calls for the four demo-seeded tables (`species_personal`, `form_personal`, `mega_personal`, `form_background_personal`) and:
1. Add `"profile_id"` to each call's `columns` array.
2. Wrap the `rows` argument in `withDemoProfileId(...)`.

For example, if the current call looks like:

```ts
insertAll("species_personal", ["species_slug", "registered", "xxl", "xxs", "purified", "updated_at"], speciesPersonal.map(...));
```

change it to:

```ts
insertAll("species_personal", ["profile_id", "species_slug", "registered", "xxl", "xxs", "purified", "updated_at"], withDemoProfileId(speciesPersonal).map(...));
```

(Read the actual current call sites first — the exact column list and any inline `.map()` transform between `personal-demo-seed.ts`'s export and `insertAll` may differ from this example; apply the same two changes — `profile_id` added to columns, `withDemoProfileId` wrapping the rows — to whatever the real code looks like for each of the four tables.)

- [ ] **Step 3: Run the dummy-db build and confirm it succeeds**

```bash
npm run build:dummy-db
```

Expected: completes without a `NOT NULL constraint failed` error. Confirm via `sqlite3`:

```bash
sqlite3 dummy.sqlite "SELECT DISTINCT profile_id FROM species_personal;"
```

Expected: exactly one row, a real UUID (not empty, not `1`).

- [ ] **Step 4: Run the full suite**

```bash
npx tsc -b
npm test
npm run lint
```

Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/personal-demo-seed.ts scripts/build-dummy-db.ts dummy.sqlite
git commit -m "Fix dummy-db generation for the now-required profile_id column"
```

---

### Task 10: UI — Trainer page profile management + header indicator

**Files:**
- Modify: `src/features/trainer/TrainerPage.vue`
- Modify: `src/app-shell/header.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `listProfiles()`, `getCurrentProfile()`, `createProfile()`, `switchProfile()`, `renameProfile()`, `deleteProfile()` (Task 8).

- [ ] **Step 1: Rewrite `TrainerPage.vue`'s script section**

Change:

```ts
const profile = ref(props.repo.getProfile());
const usernameInput = ref(profile.value.username);
const friendCodeInput = ref(profile.value.friendCode ?? "");
function saveProfile() {
  props.repo.setProfile(usernameInput.value.trim() || "Trainer", friendCodeInput.value.trim() || null);
  profile.value = props.repo.getProfile();
}
```

to:

```ts
const profiles = ref(props.repo.listProfiles());
const currentProfile = ref(props.repo.getCurrentProfile());
// Which profile's identity fields the edit form below is showing/editing —
// defaults to the current profile, but a "Rename" click on any row (Step 3
// below) repoints this without switching which profile is actually current.
const editingProfileId = ref(currentProfile.value.id);
const editingProfile = computed(() => profiles.value.find((p) => p.id === editingProfileId.value)!);
const usernameInput = ref(editingProfile.value.username);
const friendCodeInput = ref(editingProfile.value.friendCode ?? "");

function startEditing(profileId: string) {
  editingProfileId.value = profileId;
  const target = profiles.value.find((p) => p.id === profileId)!;
  usernameInput.value = target.username;
  friendCodeInput.value = target.friendCode ?? "";
}

async function saveProfile() {
  await props.repo.renameProfile(editingProfileId.value, usernameInput.value.trim() || "Trainer", friendCodeInput.value.trim() || null);
  profiles.value = props.repo.listProfiles();
  if (editingProfileId.value === currentProfile.value.id) currentProfile.value = props.repo.getCurrentProfile();
}

const newProfileUsername = ref("");
async function createNewProfile() {
  const name = newProfileUsername.value.trim();
  if (!name) return;
  await props.repo.createProfile(name, null);
  newProfileUsername.value = "";
  profiles.value = props.repo.listProfiles();
}

function switchTo(profileId: string) {
  if (profileId === currentProfile.value.id) return;
  props.repo.switchProfile(profileId);
  currentProfile.value = props.repo.getCurrentProfile();
  editingProfileId.value = currentProfile.value.id;
  usernameInput.value = currentProfile.value.username;
  friendCodeInput.value = currentProfile.value.friendCode ?? "";
  // Every other page's data (Collection, Dex grid, Stats, Tags) reads
  // through the same repo instance's cache, which switchProfile just
  // repointed — those pages re-render correctly on their own next
  // interaction/mount, same as any other in-memory-cache mutation elsewhere
  // in this app. No extra reload needed here.
}

async function deleteProfileRow(profileId: string) {
  if (profiles.value.length <= 1) return; // delete button is hidden in this case anyway, this guard is defense-in-depth
  if (!confirm(`Delete this profile? All of its Dex progress, collection, and tags will be permanently removed.`)) return;
  await props.repo.deleteProfile(profileId);
  profiles.value = props.repo.listProfiles();
  currentProfile.value = props.repo.getCurrentProfile();
  editingProfileId.value = currentProfile.value.id;
  usernameInput.value = currentProfile.value.username;
  friendCodeInput.value = currentProfile.value.friendCode ?? "";
}
```

(`computed` needs to be imported alongside the existing `ref` import at the top of the `<script setup>` block — check the existing `import { computed, ref } from "vue";` line, it's already there.)

- [ ] **Step 2: Add the profile-list template section**

Add this new `<fieldset>` immediately before the existing `<fieldset><legend>Identity</legend>...` block:

```html
<fieldset>
  <legend>Profiles</legend>
  <ul class="profile-list">
    <li v-for="p in profiles" :key="p.id" class="profile-row">
      <span class="profile-row-name">
        {{ p.username }}
        <strong v-if="p.id === currentProfile.id">(current)</strong>
      </span>
      <div class="profile-row-actions">
        <button type="button" :disabled="p.id === currentProfile.id" @click="switchTo(p.id)">Switch to</button>
        <button type="button" @click="startEditing(p.id)">Rename</button>
        <button type="button" v-if="profiles.length > 1" @click="deleteProfileRow(p.id)">Delete</button>
      </div>
    </li>
  </ul>
  <div class="input-grid">
    <label class="field">
      New profile name
      <input type="text" maxlength="20" v-model="newProfileUsername" @keydown.enter="createNewProfile" />
    </label>
    <button type="button" @click="createNewProfile">+ New profile</button>
  </div>
</fieldset>
```

- [ ] **Step 3: Update the existing Identity fieldset's legend to show which profile is being edited**

Change:

```html
<fieldset>
  <legend>Identity</legend>
```

to:

```html
<fieldset>
  <legend>Identity — editing {{ editingProfile.username }}</legend>
```

(The rest of that fieldset's inputs stay exactly as they are — they already read/write `usernameInput`/`friendCodeInput` and call `saveProfile` on change, which now correctly targets `editingProfileId` instead of always "the" profile.)

- [ ] **Step 4: Add minimal CSS**

In `src/style.css`, add (matching this project's existing flat utility-class style — check `.medal-grid`/`.medal-tile` for the established pattern to match):

```css
.profile-list {
  list-style: none;
  padding: 0;
  margin: 0 0 1rem;
}
.profile-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border-color, #ddd);
}
.profile-row-actions {
  display: flex;
  gap: 0.5rem;
}
```

(If `var(--border-color, #ddd)` doesn't match an existing CSS custom property in this file, check `src/style.css` for whatever border/divider color convention is already used elsewhere and match it instead of inventing a new one.)

- [ ] **Step 5: Manual verification (no e2e coverage exists — Sub-project 6 retired Playwright)**

```bash
npm run dev
```

In the running app: open Trainer page, confirm one profile listed marked "(current)". Click "+ New profile", enter a name, confirm it appears in the list without switching current. Click "Switch to" on the new profile, confirm the Identity fieldset's legend updates and the Dex grid (navigate there) shows a blank/unregistered state (the new profile's own empty data, not the original profile's). Switch back, confirm original Dex data is intact. Rename a profile, confirm it saves. Attempt to delete while only one profile — confirm no Delete button shows. With 2+ profiles, delete a non-current one, confirm it disappears from the list. Delete the current profile, confirm it auto-switches to another remaining one first (no crash, another profile becomes "(current)").

- [ ] **Step 6: Add the header current-trainer indicator**

In `src/app-shell/header.ts`, change the `renderHeader` function's signature — find:

```ts
export function renderHeader(container: HTMLElement, mode: HeaderMode) {
  clear(container);

  if (mode.kind === "none") {
    if (mode.title) container.append(el("div", { class: "app-header-title" }, [mode.title]));
    return;
  }
```

to:

```ts
export function renderHeader(container: HTMLElement, mode: HeaderMode, currentTrainerName: string) {
  clear(container);

  const trainerBadge = el("span", { class: "header-trainer-badge" }, [currentTrainerName]);

  if (mode.kind === "none") {
    if (mode.title) container.append(el("div", { class: "app-header-title" }, [mode.title]));
    container.append(trainerBadge);
    return;
  }
```

At the very end of the function, immediately before its closing `container.append(searchWrap);` line, add the badge there too:

```ts
  container.append(searchWrap, trainerBadge);
```

- [ ] **Step 7: Update every `renderHeader` call site in `src/main.ts`**

There are 4 call sites (per this task's earlier grep: lines ~181, ~195, ~215, ~218). Add `repo.getCurrentProfile().username` as the third argument to each — e.g. change:

```ts
renderHeader(headerEl, { kind: "none", title: ROUTE_TITLES[route.name] });
```

to:

```ts
renderHeader(headerEl, { kind: "none", title: ROUTE_TITLES[route.name] }, repo.getCurrentProfile().username);
```

Apply the identical pattern (add `, repo.getCurrentProfile().username` as the third argument) to the other 3 call sites — confirm `repo` is in scope at each (it's the module-level repository instance `main.ts` already uses everywhere else).

- [ ] **Step 8: Add minimal CSS for the badge**

In `src/style.css`:

```css
.header-trainer-badge {
  font-size: 0.85rem;
  opacity: 0.7;
  white-space: nowrap;
}
```

- [ ] **Step 9: Manual verification**

```bash
npm run dev
```

Confirm the trainer's username appears in the header on every page (Dex grid, Collection, Stats, Settings, etc. — not just Trainer). Switch profiles on the Trainer page, navigate to another page, confirm the header badge updated to the new profile's username.

- [ ] **Step 10: Run the full suite**

```bash
npx tsc -b
npm test
npm run lint
```

Expected: all clean — this should be the point where every remaining `tsc -b` error from Tasks 3/4/5/8 is resolved.

- [ ] **Step 11: Commit**

```bash
git add src/features/trainer/TrainerPage.vue src/app-shell/header.ts src/main.ts src/style.css
git commit -m "Add profile management UI to Trainer page and a header trainer indicator"
```

---

### Task 11: Documentation + final verification

**Files:**
- Modify: `docs/data-model.md`
- Modify: `docs/roadmap.md`

**Interfaces:** none — this is the plan's closing task.

- [ ] **Step 1: Update `docs/data-model.md`**

Find wherever `profile`/`species_personal`/`form_personal` are documented and update: `profile.id` is now a UUID (`TEXT`), not an `INTEGER`; `species_personal`/`form_personal`/`mega_personal`/`form_background_personal`/`app_settings` now have composite PKs including `profile_id`; bump any "schema version currently N" reference to `10`.

- [ ] **Step 2: Update `docs/roadmap.md`**

In the "Carried forward from Sub-project 2" section (or wherever it currently lives), mark both items resolved: "Trainer-level FK fix needs live confirmation" and "Possible latent profile_id mismatch on existing rows" — both are now moot, since `profile_id` is rewritten to a real UUID unconditionally for every pre-existing row during this migration (Task 2), regardless of what integer value it held before.

Add a line noting Sub-project 7a is complete and Sub-project 7b (cross-device comparison/merge, stable `pokemon_instance`/`tag` identity) is next in sequence, per `docs/superpowers/specs/2026-07-23-v2-consolidation-roadmap.md`'s Sub-project 7 split.

- [ ] **Step 3: Full whole-app verification**

```bash
npx tsc -b
npm test
npm run lint
npm run build
```

Expected: all clean.

```bash
npm run build:dummy-db
```

Expected: succeeds (confirms Task 9's fix holds end-to-end after every other task's changes).

```bash
npm run dev
```

Manually re-verify the full flow one more time end-to-end: fresh profile boot, create a second profile, log a catch under profile A, switch to profile B, confirm profile B's Dex/Collection are empty, switch back to A, confirm the catch is still there, rename a profile, delete a non-current profile, delete the current profile (confirms auto-switch), confirm the header badge tracks every switch correctly.

- [ ] **Step 4: Commit**

```bash
git add docs/data-model.md docs/roadmap.md
git commit -m "Document Sub-project 7a's schema changes; close out Sub-project 2 carry-forward items"
```

## Self-Review Notes

- **Spec coverage:** every design-doc section maps to a task — schema changes (Task 1), UUID scheme (Task 2), repository/caching architecture (Tasks 3-8), UI (Task 10), deferred items logged not built (copy-on-create explicitly not implemented anywhere in this plan; quick-switch-elsewhere explicitly not implemented).
- **Type consistency:** `Profile.id: string` (Task 3) flows unchanged through every later task's code (`crypto.randomUUID()` return type, `profileId: string` parameters throughout Tasks 5/7/8). `PersonalState`'s shape (Task 4) is never restructured, only aliased — every task after Task 4 that touches `state.xxx` uses the exact same field names that existed before this plan.
- **Placeholder scan:** no TBD/TODO; the one literal placeholder string (`"__DEMO_PROFILE_ID__"` in Task 9) is a real, intentional sentinel value substituted by real code in the same task, not an unfinished spec.
