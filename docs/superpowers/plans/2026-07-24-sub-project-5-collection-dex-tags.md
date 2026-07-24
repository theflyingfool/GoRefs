# Sub-project 5: Collection/Dex/Tags Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three real-device gaps — no per-instance edit UI, catches not reflecting in the Dex grid, and no tags list — plus two new specimen flags (Dynamax catch-source, received-via-trade) surfaced while scoping the edit page.

**Architecture:** Two new `pokemon_instance` boolean columns via a plain Drizzle `ADD COLUMN` migration (schema v8→9). A new pure function (`resolveInstanceAchievementField`) picks the single most-specific `form_personal` field implied by a specimen's own attributes, reusing the app's existing tested cascade system (`resolveFormFieldCascade`/`applyFormPersonalField`) to fill in every implied prerequisite and the `species_personal.registered` cascade — no new derivation/cascade logic duplicated. `createPokemonInstances` calls this on every new catch; a one-time gated backfill applies it to every existing row. New repository methods (`updatePokemonInstance`, `listBackgrounds`, `getTagUsageCounts`, `renameTag`, `deleteTag`) back two new Vue pages (`EditInstancePage.vue`, `TagsPage.vue`) wired into the existing router/nav.

**Tech Stack:** TypeScript, Vue 3 `<script setup>` SFCs, Drizzle ORM (schema-only, SQL migrations hand-verified), `node:sqlite` for unit tests, Playwright for e2e.

## Global Constraints

- `CURRENT_PERSONAL_SCHEMA_VERSION` (`src/db/schema.ts`) must bump 8 → 9, with a comment explaining why (new `dynamax`/`received_via_trade` columns), per `docs/data-model.md`'s versioning policy.
- New boolean columns follow the existing `boolChecks("pokemon_instance", {...})` pattern — a named `CHECK (col IN (0,1))` constraint each, matching `shiny`/`lucky`/`shadow`/`purified`.
- `resolveInstanceAchievementField` must NOT duplicate `resolveFormFieldCascade`'s prerequisite logic — it only ever returns the single most-specific field; the existing cascade fills in the rest. Do not hand-write a derivation table that sets multiple fields directly.
- IV-floor fields (`floor`, `luckyFloor`, `shadowFloor`, `dynamaxFloor`, `luckyDynamaxFloor`) are explicitly OUT OF SCOPE — never auto-derived by this plan, stay manual Dex-grid toggles.
- Lucky+Shadow is confirmed not a real combination in Pokémon GO (owner, 2026-07-24) — `resolveInstanceAchievementField` does not need to special-case or guard against both being true simultaneously.
- All new repository methods go on the `Repository` interface in `src/data/repository.ts`, implemented in both `src/data/in-memory-store.ts` (dummy backend) and `src/data/sqlite-repository.ts` (real backend) unless a task says otherwise.
- Every new/changed repository method needs a `node:sqlite`-backed unit test in `test/`, following the existing pattern in `test/iv-generated-column.test.ts` (via `test/node-sqlite-connection.ts`'s `nodeSqliteConnection()` adapter and `runPersonalMigrations`).

---

### Task 1: Schema — `dynamax` and `received_via_trade` columns

**Files:**
- Modify: `src/db/schema/personal.ts:152-192` (the `pokemonInstance` table)
- Modify: `src/db/schema.ts:244` (`CURRENT_PERSONAL_SCHEMA_VERSION`)
- Modify: `src/db/types.ts:373-396` (`PokemonInstance` interface)
- Create: `src/db/migrations/0003_<drizzle-generated-name>.sql` (via `npm run db:generate`)
- Modify: `src/db/migrations-data.ts` (via `npm run db:generate-data`)
- Modify: `test/migrations.test.ts`, `test/drizzle-v6-bootstrap.test.ts` (migration-count assertions)

**Interfaces:**
- Produces: `PokemonInstance.dynamax: boolean`, `PokemonInstance.receivedViaTrade: boolean` — consumed by Tasks 2, 3, 4, 6, 7.

- [ ] **Step 1: Add the two columns to the Drizzle schema**

In `src/db/schema/personal.ts`, in the `pokemonInstance` table definition, add two lines after `purified` (line 179):

```ts
    purified: integer("purified", { mode: "boolean" }).notNull().default(false),
    dynamax: integer("dynamax", { mode: "boolean" }).notNull().default(false),
    receivedViaTrade: integer("received_via_trade", { mode: "boolean" }).notNull().default(false),
    heartsEarned: integer("hearts_earned"),
```

And extend the `boolChecks` call in the same table's constraints callback (line 186):

```ts
    ...boolChecks("pokemon_instance", {
      shiny: table.shiny,
      lucky: table.lucky,
      shadow: table.shadow,
      purified: table.purified,
      dynamax: table.dynamax,
      receivedViaTrade: table.receivedViaTrade,
    }),
```

- [ ] **Step 2: Bump the schema version**

In `src/db/schema.ts`, replace line 244 and the comment above it:

```ts
// Bumped 8 -> 9: pokemon_instance gains two new instance-level catch-source
// flags -- dynamax (this specimen came from a Max Battle, independent of
// form_personal.dynamax's "have I ever caught a Dynamaxed one of this form"
// achievement -- same relationship shiny already has to form_personal.shiny)
// and received_via_trade (this specimen's origin). See
// docs/superpowers/specs/2026-07-24-sub-project-5-collection-dex-tags-design.md.
export const CURRENT_PERSONAL_SCHEMA_VERSION = 9;
```

- [ ] **Step 3: Add the fields to the `PokemonInstance` type**

In `src/db/types.ts`, inside the `PokemonInstance` interface (around line 388-390), add after `purified: boolean;`:

```ts
  purified: boolean;
  dynamax: boolean;
  receivedViaTrade: boolean;
```

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`

This reads `src/db/schema/personal.ts` and writes a new file under `src/db/migrations/` (drizzle-kit names it automatically, e.g. `0003_<random-name>.sql`) plus updates `src/db/migrations/meta/_journal.json` and a snapshot file. Since this is a plain `ADD COLUMN` (not a type/shape change requiring a table rebuild, unlike migration `0002`), the generated SQL should be exactly two `ALTER TABLE pokemon_instance ADD COLUMN` statements plus two `CREATE ... CHECK` equivalents — drizzle-kit expresses new CHECK constraints on an existing table via a full rebuild in some versions; **read the generated file** before proceeding. If it generated a table rebuild (temp table + copy + drop + rename), verify by hand that:
1. Every existing column is preserved in the new table's column list (compare against `0002_messy_killraven.sql`'s rebuilt table for the full current column list).
2. The `INSERT INTO ... SELECT` statement lists every old column plus `0` (or `false`) for the two new ones — old rows have no source data for them.
3. `REFERENCES` clauses are restored by hand if drizzle-kit dropped them (same issue noted in `src/db/migrations/0000_baseline.sql`'s header comment and hit by migrations `0001`/`0002`) — check by grepping the generated file for `REFERENCES` and comparing count against the table's actual FK columns (`form_slug`, `profile_id`, `background_slug`).

- [ ] **Step 5: Regenerate the embedded migration data**

Run: `npm run db:generate-data`

This regenerates `src/db/migrations-data.ts`'s `MIGRATION_SQL_BY_TAG` map from the files on disk (see `scripts/generate-migrations-data.ts`) — required because the browser build can't read migration files off disk at runtime (see `src/db/migrations.ts`'s module comment).

- [ ] **Step 6: Update migration-count assertions**

In `test/migrations.test.ts` and `test/drizzle-v6-bootstrap.test.ts`, find every assertion of the form `assert.equal(appliedCount, 3)` (or similar "N migrations applied" checks) and bump the expected count to `4`. Run `grep -n "3" test/migrations.test.ts test/drizzle-v6-bootstrap.test.ts` first to find the exact lines — do not guess at line numbers, they may have shifted since Sub-project 4.

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: all existing tests pass with the updated migration count. If any test seeds a `pokemon_instance` row via raw SQL and lists explicit columns (not `INSERT ... (col1, col2) VALUES` style that tolerates new nullable-with-default columns), it should still pass since both new columns have `NOT NULL DEFAULT false` — no existing INSERT statement needs to change.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema/personal.ts src/db/schema.ts src/db/types.ts src/db/migrations/ src/db/migrations-data.ts test/migrations.test.ts test/drizzle-v6-bootstrap.test.ts
git commit -m "Add pokemon_instance.dynamax and received_via_trade columns (schema v9)"
```

---

### Task 2: `resolveInstanceAchievementField` pure function

**Files:**
- Modify: `src/db/cascades.ts`
- Test: `test/instance-achievement-field.test.ts` (new)

**Interfaces:**
- Consumes: `FormPersonalBooleanField` type (`src/db/types.ts`, already exists).
- Produces: `resolveInstanceAchievementField(instance: InstanceAchievementSource): FormPersonalBooleanField` and the `InstanceAchievementSource` interface — consumed by Tasks 3 and 5.

- [ ] **Step 1: Write the failing tests**

Create `test/instance-achievement-field.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInstanceAchievementField } from "../src/db/cascades";

function instance(overrides: Partial<{ shiny: boolean; lucky: boolean; shadow: boolean; dynamax: boolean; ivPercent: number | null }> = {}) {
  return { shiny: false, lucky: false, shadow: false, dynamax: false, ivPercent: null, ...overrides };
}

test("plain catch with no flags resolves to caught", () => {
  assert.equal(resolveInstanceAchievementField(instance()), "caught");
});

test("shiny (no other flags) resolves to shiny", () => {
  assert.equal(resolveInstanceAchievementField(instance({ shiny: true })), "shiny");
});

test("100% IV (no shiny) resolves to fourStar", () => {
  assert.equal(resolveInstanceAchievementField(instance({ ivPercent: 100 })), "fourStar");
});

test("shiny + 100% IV resolves to shundo", () => {
  assert.equal(resolveInstanceAchievementField(instance({ shiny: true, ivPercent: 100 })), "shundo");
});

test("99% IV (not exactly 100) does not resolve to fourStar", () => {
  assert.equal(resolveInstanceAchievementField(instance({ ivPercent: 99 })), "caught");
});

test("lucky resolves to lucky-group fields", () => {
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true })), "lucky");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, shiny: true })), "luckyShiny");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, ivPercent: 100 })), "luckyFourStar");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, shiny: true, ivPercent: 100 })), "luckyShundo");
});

test("shadow resolves to shadow-group fields", () => {
  assert.equal(resolveInstanceAchievementField(instance({ shadow: true })), "shadow");
  assert.equal(resolveInstanceAchievementField(instance({ shadow: true, shiny: true })), "shadowShiny");
  assert.equal(resolveInstanceAchievementField(instance({ shadow: true, ivPercent: 100 })), "shadowFourStar");
  assert.equal(resolveInstanceAchievementField(instance({ shadow: true, shiny: true, ivPercent: 100 })), "shadowShundo");
});

test("dynamax resolves to dynamax-group fields", () => {
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true })), "dynamax");
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true, shiny: true })), "dynamaxShiny");
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true, ivPercent: 100 })), "dynamaxFourStar");
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true, shiny: true, ivPercent: 100 })), "dynamaxShundo");
});

test("lucky + dynamax resolves to lucky-dynamax-group fields", () => {
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, dynamax: true })), "luckyDynamax");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, dynamax: true, shiny: true })), "luckyDynamaxShiny");
  assert.equal(resolveInstanceAchievementField(instance({ lucky: true, dynamax: true, ivPercent: 100 })), "luckyDynamaxFourStar");
  assert.equal(
    resolveInstanceAchievementField(instance({ lucky: true, dynamax: true, shiny: true, ivPercent: 100 })),
    "luckyDynamaxShundo",
  );
});

test("dynamax takes priority over shadow when both are true", () => {
  // Not a realistic combination in practice, but the function must resolve
  // to exactly one field rather than throwing — dynamax is checked first.
  assert.equal(resolveInstanceAchievementField(instance({ dynamax: true, shadow: true })), "dynamax");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test test/instance-achievement-field.test.ts`
Expected: FAIL — `resolveInstanceAchievementField` is not exported from `../src/db/cascades`.

- [ ] **Step 3: Implement the function**

In `src/db/cascades.ts`, add after the existing `resolveFormFieldCascade` function (end of file):

```ts
export interface InstanceAchievementSource {
  shiny: boolean;
  lucky: boolean;
  shadow: boolean;
  dynamax: boolean;
  ivPercent: number | null;
}

/**
 * The single most-specific form_personal field implied by one logged
 * specimen's own recorded attributes. Feed the result into
 * setFormPersonalField/applyFormPersonalField -- resolveFormFieldCascade
 * (above) fills in every less-specific implied field (shiny/fourStar/base)
 * plus the species_personal.registered cascade, so callers only ever need
 * to set this one field per specimen, not a whole derivation table.
 *
 * Lucky+Shadow is not a real combination in Pokemon GO (owner-confirmed,
 * 2026-07-24) -- dynamax/shadow/lucky are checked in this order only as a
 * tie-break for callers that pass an invalid combination; it never matters
 * for a real specimen since the two flags can't both be true.
 */
export function resolveInstanceAchievementField(instance: InstanceAchievementSource): FormPersonalBooleanField {
  const fourStar = instance.ivPercent === 100;

  let base: FormPersonalBooleanField;
  let shinyField: FormPersonalBooleanField;
  let fourStarField: FormPersonalBooleanField;
  let shundoField: FormPersonalBooleanField;

  if (instance.lucky && instance.dynamax) {
    base = "luckyDynamax";
    shinyField = "luckyDynamaxShiny";
    fourStarField = "luckyDynamaxFourStar";
    shundoField = "luckyDynamaxShundo";
  } else if (instance.dynamax) {
    base = "dynamax";
    shinyField = "dynamaxShiny";
    fourStarField = "dynamaxFourStar";
    shundoField = "dynamaxShundo";
  } else if (instance.shadow) {
    base = "shadow";
    shinyField = "shadowShiny";
    fourStarField = "shadowFourStar";
    shundoField = "shadowShundo";
  } else if (instance.lucky) {
    base = "lucky";
    shinyField = "luckyShiny";
    fourStarField = "luckyFourStar";
    shundoField = "luckyShundo";
  } else {
    base = "caught";
    shinyField = "shiny";
    fourStarField = "fourStar";
    shundoField = "shundo";
  }

  if (instance.shiny && fourStar) return shundoField;
  if (instance.shiny) return shinyField;
  if (fourStar) return fourStarField;
  return base;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test test/instance-achievement-field.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/db/cascades.ts test/instance-achievement-field.test.ts
git commit -m "Add resolveInstanceAchievementField, deriving the Dex flag a catch implies"
```

---

### Task 3: Wire the cascade into `createPokemonInstances`

**Files:**
- Modify: `src/data/repository.ts` (`NewPokemonInstanceBatch`)
- Modify: `src/data/sqlite-repository.ts` (`createPokemonInstances`)
- Modify: `src/data/in-memory-store.ts` (`createPokemonInstances` — dummy backend)
- Test: `test/create-pokemon-instances-dex-sync.test.ts` (new)

**Interfaces:**
- Consumes: `resolveInstanceAchievementField` (Task 2), `PokemonInstance.dynamax`/`.receivedViaTrade` (Task 1).
- Produces: `NewPokemonInstanceBatch.dynamax?: boolean`, `.receivedViaTrade?: boolean` — consumed by Task 6 (Log-a-catch UI).

- [ ] **Step 1: Add the two fields to `NewPokemonInstanceBatch`**

In `src/data/repository.ts`, in the `NewPokemonInstanceBatch` interface (around line 340-353), add after `purified?: boolean;`:

```ts
export interface NewPokemonInstanceBatch {
  formSlug: string;
  count: number;
  shiny?: boolean;
  lucky?: boolean;
  shadow?: boolean;
  purified?: boolean;
  dynamax?: boolean;
  receivedViaTrade?: boolean;
  cp?: number | null;
```

- [ ] **Step 2: Write the failing test**

Create `test/create-pokemon-instances-dex-sync.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runPersonalMigrations } from "../src/db/migrations";
import { nodeSqliteConnection } from "./node-sqlite-connection";

// Minimal harness: exercises the real INSERT + cascade SQL sqlite-repository.ts
// runs, without needing the full createSqliteRepository (which requires a
// live getDb()/persistDb() pair this test doesn't have). Mirrors the raw-SQL
// setup style already used by test/iv-generated-column.test.ts.
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF"); // form_slug/profile_id reference tables this test doesn't create
  return db;
}

test("logging a shiny catch flips form_personal.shiny and species_personal.registered", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));

  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at, shiny) VALUES ('bulbasaur-standard', 1, 0, 0, 1)",
  ).run();

  // Simulates what Task 3's createPokemonInstances change does after insert:
  // resolve the field, then apply the same UPSERT shape sqlite-repository.ts's
  // onFormPersonalChanged hook writes (see upsertFormPersonalSql()).
  db.prepare(
    `INSERT INTO form_personal (form_slug, shiny, updated_at) VALUES ('bulbasaur-standard', 1, 1)
     ON CONFLICT(form_slug) DO UPDATE SET shiny = 1, caught = 1, updated_at = 1`,
  ).run();
  db.prepare(
    `INSERT INTO form_personal (form_slug, caught, updated_at) VALUES ('bulbasaur-standard', 1, 1)
     ON CONFLICT(form_slug) DO UPDATE SET caught = 1, updated_at = 1`,
  ).run();
  db.prepare(
    `INSERT INTO species_personal (species_slug, registered, updated_at) VALUES ('bulbasaur', 1, 1)
     ON CONFLICT(species_slug) DO UPDATE SET registered = 1, updated_at = 1`,
  ).run();

  const form = db.prepare("SELECT shiny, caught FROM form_personal WHERE form_slug = 'bulbasaur-standard'").get() as {
    shiny: number;
    caught: number;
  };
  assert.equal(form.shiny, 1);
  assert.equal(form.caught, 1);

  const species = db.prepare("SELECT registered FROM species_personal WHERE species_slug = 'bulbasaur'").get() as {
    registered: number;
  };
  assert.equal(species.registered, 1);
});
```

Note: this test documents the *expected end state* the real `createPokemonInstances` change (Step 3 below) must produce — it doesn't call `createPokemonInstances` directly, since that requires the full `createSqliteRepository` bootstrap (live `getDb()`). Task 3's Step 5 adds the integration-level test that does exercise the real function via the in-memory backend.

- [ ] **Step 2b: Run it to confirm the harness itself is sound**

Run: `npx tsx --test test/create-pokemon-instances-dex-sync.test.ts`
Expected: PASS (this test only exercises hand-written SQL matching the target behavior, not the real code path yet — it's here to pin the exact SQL shape before Step 3 wires it up for real).

- [ ] **Step 3: Wire the cascade into `sqlite-repository.ts`'s `createPokemonInstances`**

In `src/data/sqlite-repository.ts`, update the INSERT statement (around line 435) to include the two new columns:

```ts
          await db.run(
            `INSERT INTO pokemon_instance (form_slug, profile_id, status, recorded_at, caught_at, updated_at, cp, iv_attack, iv_defense, iv_stamina, shiny, lucky, shadow, purified, dynamax, received_via_trade, nickname, background_slug)
             VALUES (?, ?, 'kept', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            ],
            false,
          );
```

And the in-memory `created.push({...})` object (around line 458) to include the two new fields:

```ts
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
          });
```

Then, right after `state.pokemonInstances.push(...created); state.pokemonInstanceTags.push(...tagLinks);` (around line 493-494), add the cascade call:

```ts
      state.pokemonInstances.push(...created);
      state.pokemonInstanceTags.push(...tagLinks);
      for (const instance of created) {
        repo.setFormPersonalField(instance.formSlug, resolveInstanceAchievementField(instance), true);
      }
      return created;
```

Add the import at the top of the file:

```ts
import { resolveInstanceAchievementField } from "../db/cascades";
```

- [ ] **Step 4: Mirror the same change in `in-memory-store.ts`'s dummy-backend `createPokemonInstances`**

Find `createPokemonInstances` in `src/data/in-memory-store.ts` (dummy backend, used when no real DB connection is available — check `grep -n "createPokemonInstances" src/data/in-memory-store.ts` for the exact line since it wasn't quoted above). Apply the same three changes: accept `dynamax`/`receivedViaTrade` from the batch onto the created `PokemonInstance` objects, and after pushing to `state.pokemonInstances`, call `setFormPersonalField(instance.formSlug, resolveInstanceAchievementField(instance), true)` for each (using this file's own local `setFormPersonalField`, not `repo.setFormPersonalField` — this file defines the functions directly, not through a `repo` wrapper).

- [ ] **Step 5: Write the integration-level test against the in-memory backend**

Add to `test/create-pokemon-instances-dex-sync.test.ts`:

```ts
import { createInMemoryRepository } from "../src/data/in-memory-store";
import type { PersonalState } from "../src/data/in-memory-store";

function emptyPersonalState(): PersonalState {
  return {
    profile: { id: 1, username: "Trainer", friendCode: null, createdAt: 0 },
    appSettings: {},
    speciesPersonal: {},
    formPersonal: {},
    megaPersonal: {},
    formBackgroundPersonal: [],
    pokemonInstances: [],
    pokemonInstanceTags: [],
    pokemonInstanceMaxMoves: [],
    tags: [],
    playerProgress: undefined,
    playerProgressLog: [],
    medalProgress: {},
  };
}

test("createPokemonInstances (in-memory backend) flips form_personal.shiny and species_personal.registered", async () => {
  const referenceData = {
    species: [{ slug: "bulbasaur", dexNumber: 1, name: "Bulbasaur", familySlug: "bulbasaur", gen: 1, rarity: "standard" as const }],
    forms: [{ slug: "bulbasaur-standard", speciesSlug: "bulbasaur", formName: "Standard", costumeName: null, gender: "male" as const, shadowAvailable: false, dynamaxAvailable: false, regionalExclusive: false, imageRef: "" }],
    // ... other reference collections default to empty arrays; check
    // createInMemoryRepository's first parameter type (ReferenceData) for
    // the full required shape before running this.
  };
  const state = emptyPersonalState();
  const repo = createInMemoryRepository(referenceData as never, state, {
    onSpeciesPersonalChanged() {},
    onFormPersonalChanged() {},
    onAppSettingChanged() {},
    onFormBackgroundPersonalAdded() {},
    onMegaPersonalChanged() {},
    onMedalProgressChanged() {},
  } as never);

  await repo.createPokemonInstances({ formSlug: "bulbasaur-standard", count: 1, shiny: true });

  assert.equal(state.formPersonal["bulbasaur-standard"]?.shiny, true);
  assert.equal(state.formPersonal["bulbasaur-standard"]?.caught, true);
  assert.equal(state.speciesPersonal["bulbasaur"]?.registered, true);
});
```

Before finalizing this step, run `grep -n "interface ReferenceData\|interface PersonalState" src/data/in-memory-store.ts src/data/repository.ts` to get the exact required shape of both types — the sketch above is illustrative; fill in every required field the actual interfaces demand (the implementer must read these two interfaces directly rather than guess at what's optional).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test test/create-pokemon-instances-dex-sync.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/data/repository.ts src/data/sqlite-repository.ts src/data/in-memory-store.ts test/create-pokemon-instances-dex-sync.test.ts
git commit -m "Sync Dex achievement flags when a catch is logged (fixes Sub-project 5b)"
```

---

### Task 4: One-time backfill for existing rows

**Files:**
- Modify: `src/data/sqlite-repository.ts` (`createSqliteRepository`)
- Test: `test/dex-achievement-backfill.test.ts` (new)

**Interfaces:**
- Consumes: `resolveInstanceAchievementField` (Task 2), `repo.setFormPersonalField`, `repo.setAppSetting`, `runBulk` (all already exist in `sqlite-repository.ts`).

- [ ] **Step 1: Write the failing test**

Create `test/dex-achievement-backfill.test.ts`. This test seeds a device with pre-fix data (a `pokemon_instance` row with no corresponding `form_personal`/`species_personal` flags set) and verifies a backfill pass corrects it without touching already-true flags on an unrelated form:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveInstanceAchievementField } from "../src/db/cascades";

// Unit-level test of the backfill LOOP itself (not the full createSqliteRepository
// bootstrap, which needs a live getDb()) -- proves the loop only ever sets
// flags true and never clobbers an already-true flag on a different form.
test("backfill loop never unsets an already-true flag on an unrelated form", () => {
  const setCalls: { formSlug: string; field: string; value: boolean }[] = [];
  const instances = [
    { formSlug: "bulbasaur-standard", shiny: true, lucky: false, shadow: false, dynamax: false, ivPercent: null },
    { formSlug: "charmander-standard", shiny: false, lucky: false, shadow: false, dynamax: false, ivPercent: 100 },
  ];

  for (const instance of instances) {
    const field = resolveInstanceAchievementField(instance);
    setCalls.push({ formSlug: instance.formSlug, field, value: true });
  }

  assert.deepEqual(setCalls, [
    { formSlug: "bulbasaur-standard", field: "shiny", value: true },
    { formSlug: "charmander-standard", field: "fourStar", value: true },
  ]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test test/dex-achievement-backfill.test.ts`
Expected: FAIL if `resolveInstanceAchievementField` doesn't exist yet (it does, from Task 2) — this step should actually PASS immediately since Task 2 already implemented it. Run it anyway to confirm the test itself is correct before moving on; if it's green already, that's expected (this test only exercises Task 2's function, this task's real new code is Step 3 below).

- [ ] **Step 3: Add the gated backfill to `createSqliteRepository`**

In `src/data/sqlite-repository.ts`, after the `const repo = createInMemoryRepository(...)` block closes (its closing `);` — find it via `grep -n "^  const repo = createInMemoryRepository" src/data/sqlite-repository.ts` and locate the matching close-paren, which is right before the `async function runBulk` definition), add:

```ts
  const DEX_ACHIEVEMENT_BACKFILL_KEY = "dexAchievementBackfillV9Complete";
  if (state.appSettings[DEX_ACHIEVEMENT_BACKFILL_KEY] !== "1") {
    await runBulk(async () => {
      for (const instance of state.pokemonInstances) {
        repo.setFormPersonalField(instance.formSlug, resolveInstanceAchievementField(instance), true);
      }
      repo.setAppSetting(DEX_ACHIEVEMENT_BACKFILL_KEY, "1");
    });
  }
```

This must go after `runBulk` is defined but the function itself is hoisted (declared with `async function runBulk`), so placement relative to `runBulk`'s own definition doesn't matter as long as it's after `repo` exists and before the final `return { ...repo, ... }` statement. Place it immediately before that final `return` statement for clarity.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including any existing test that boots a fresh `createSqliteRepository` and checks its initial state (the backfill is a no-op on a fresh install with zero `pokemon_instance` rows, but still sets the `dexAchievementBackfillV9Complete` app-setting key — check whether any existing test asserts an exact `appSettings` snapshot that this would now break; if so, update that assertion to expect the new key).

- [ ] **Step 5: Commit**

```bash
git add src/data/sqlite-repository.ts test/dex-achievement-backfill.test.ts
git commit -m "Backfill Dex achievement flags for pokemon_instance rows logged before the sync fix"
```

---

### Task 5: `updatePokemonInstance` + `listBackgrounds`

**Files:**
- Modify: `src/data/repository.ts` (interface + `UpdatePokemonInstanceFields`)
- Modify: `src/data/sqlite-repository.ts`
- Modify: `src/data/in-memory-store.ts`
- Test: `test/update-pokemon-instance.test.ts` (new)

**Interfaces:**
- Produces: `UpdatePokemonInstanceFields` interface, `repo.updatePokemonInstance(id, fields): Promise<void>`, `repo.listBackgrounds(): { slug: string; name: string }[]` — consumed by Task 7 (`EditInstancePage.vue`).

- [ ] **Step 1: Add the interface and method signatures to `repository.ts`**

In `src/data/repository.ts`, add near `NewPokemonInstanceBatch`:

```ts
export interface UpdatePokemonInstanceFields {
  nickname?: string | null;
  cp?: number | null;
  ivAttack?: number | null;
  ivDefense?: number | null;
  ivStamina?: number | null;
  shiny?: boolean;
  lucky?: boolean;
  shadow?: boolean;
  purified?: boolean;
  dynamax?: boolean;
  receivedViaTrade?: boolean;
  heartsEarned?: number | null;
  currentMegaLevel?: number | null;
  backgroundSlug?: string | null;
  /** Full replacement of this instance's tag set -- diffed against current
   * pokemon_instance_tag rows (insert new links, delete removed ones). */
  tagIds?: number[];
}
```

And on the `Repository` interface, near `setPokemonInstanceStatus` (line 280):

```ts
  updatePokemonInstance(id: number, fields: UpdatePokemonInstanceFields): Promise<void>;
  listBackgrounds(): { slug: string; name: string }[];
```

- [ ] **Step 2: Write the failing tests**

Create `test/update-pokemon-instance.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runPersonalMigrations } from "../src/db/migrations";
import { nodeSqliteConnection } from "./node-sqlite-connection";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

test("updating an instance's nickname and IVs persists via raw SQL", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at) VALUES ('bulbasaur-standard', 1, 0, 0)",
  ).run();
  const id = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;

  db.prepare("UPDATE pokemon_instance SET nickname = ?, iv_attack = ?, iv_defense = ?, iv_stamina = ? WHERE id = ?").run(
    "Bulby",
    10,
    8,
    4,
    id,
  );

  const row = db.prepare("SELECT nickname, iv_percent FROM pokemon_instance WHERE id = ?").get(id) as {
    nickname: string;
    iv_percent: number;
  };
  assert.equal(row.nickname, "Bulby");
  assert.equal(row.iv_percent, 48.9);
});

test("replacing an instance's tag set adds new links and removes old ones", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'shiny-hunt')").run();
  const tag1 = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'raid')").run();
  const tag2 = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at) VALUES ('bulbasaur-standard', 1, 0, 0)",
  ).run();
  const instanceId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tag1);

  // Simulates updatePokemonInstance's tag-diff: remove links not in the new
  // set, insert links not already present.
  const newTagIds = [tag2];
  db.prepare("DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ? AND tag_id NOT IN (?)").run(instanceId, newTagIds[0]);
  db.prepare("INSERT OR IGNORE INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tag2);

  const links = db.prepare("SELECT tag_id FROM pokemon_instance_tag WHERE pokemon_instance_id = ?").all(instanceId) as {
    tag_id: number;
  }[];
  assert.deepEqual(
    links.map((l) => l.tag_id),
    [tag2],
  );
});
```

- [ ] **Step 3: Run the tests to verify they fail or pass on the raw-SQL harness**

Run: `npx tsx --test test/update-pokemon-instance.test.ts`
Expected: PASS (these pin the exact SQL shape `updatePokemonInstance`'s real implementation, Step 4, must match) — same "harness proves the SQL, then wire the real function" approach as Task 3.

- [ ] **Step 4: Implement `updatePokemonInstance` and `listBackgrounds` in `sqlite-repository.ts`**

Add near `createPokemonInstances` in the final returned object (after the `...repo` spread, alongside the other overrides):

```ts
    async updatePokemonInstance(id: number, fields: UpdatePokemonInstanceFields): Promise<void> {
      const sets: string[] = [];
      const values: unknown[] = [];
      const columnByField: Record<string, string> = {
        nickname: "nickname",
        cp: "cp",
        ivAttack: "iv_attack",
        ivDefense: "iv_defense",
        ivStamina: "iv_stamina",
        shiny: "shiny",
        lucky: "lucky",
        shadow: "shadow",
        purified: "purified",
        dynamax: "dynamax",
        receivedViaTrade: "received_via_trade",
        heartsEarned: "hearts_earned",
        currentMegaLevel: "current_mega_level",
        backgroundSlug: "background_slug",
      };
      for (const [field, column] of Object.entries(columnByField)) {
        if (!(field in fields)) continue;
        const raw = (fields as Record<string, unknown>)[field];
        sets.push(`${column} = ?`);
        values.push(typeof raw === "boolean" ? (raw ? 1 : 0) : raw);
      }

      await enqueueWrite(async () => {
        await db.beginTransaction();
        if (sets.length > 0) {
          await db.run(`UPDATE pokemon_instance SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...values, Date.now(), id], false);
        }
        if (fields.tagIds !== undefined) {
          const placeholders = fields.tagIds.length > 0 ? fields.tagIds.map(() => "?").join(",") : "NULL";
          await db.run(
            `DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ? AND tag_id NOT IN (${placeholders})`,
            [id, ...fields.tagIds],
            false,
          );
          for (const tagId of fields.tagIds) {
            await db.run("INSERT OR IGNORE INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)", [id, tagId], false);
          }
        }
        await db.commitTransaction();
        await persistDb();
      });
      await writeQueue;

      const idx = state.pokemonInstances.findIndex((i) => i.id === id);
      if (idx !== -1) {
        state.pokemonInstances[idx] = { ...state.pokemonInstances[idx], ...fields, updatedAt: Date.now() } as PokemonInstance;
      }
      if (fields.tagIds !== undefined) {
        state.pokemonInstanceTags = state.pokemonInstanceTags.filter((t) => t.pokemonInstanceId !== id);
        state.pokemonInstanceTags.push(...fields.tagIds.map((tagId) => ({ pokemonInstanceId: id, tagId })));
      }
    },
    listBackgrounds() {
      return referenceData.backgrounds.map((b) => ({ slug: b.slug, name: b.name }));
    },
```

Check `grep -n "backgrounds" src/data/repository.ts` (the `ReferenceData` type passed into `createInMemoryRepository`/available in `sqlite-repository.ts`'s closure) to confirm the exact property name and shape for backgrounds reference data before finalizing `listBackgrounds`'s body — it should already be loaded as part of `referenceData` (the module-level `reference.json` import), matching how `species`/`forms` are accessed elsewhere in this file.

Note: `fields.tagIds` with an empty array hits the `placeholders = "NULL"` branch, producing `tag_id NOT IN (NULL)` — SQLite evaluates this as never-true for any row (correct: `NOT IN (NULL)` is unknown/false for every comparison), which would fail to delete existing links when clearing all tags. Fix: when `fields.tagIds.length === 0`, use a plain `DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ?` with no `NOT IN` clause instead:

```ts
        if (fields.tagIds !== undefined) {
          if (fields.tagIds.length === 0) {
            await db.run("DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ?", [id], false);
          } else {
            const placeholders = fields.tagIds.map(() => "?").join(",");
            await db.run(
              `DELETE FROM pokemon_instance_tag WHERE pokemon_instance_id = ? AND tag_id NOT IN (${placeholders})`,
              [id, ...fields.tagIds],
              false,
            );
            for (const tagId of fields.tagIds) {
              await db.run("INSERT OR IGNORE INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)", [id, tagId], false);
            }
          }
        }
```

- [ ] **Step 5: Implement the same two methods in `in-memory-store.ts`**

Add `updatePokemonInstance` and `listBackgrounds` to the object returned by `createInMemoryRepository` (find the object literal's other methods like `setPokemonInstanceStatus` for the right location). `updatePokemonInstance` mutates `state.pokemonInstances`/`state.pokemonInstanceTags` directly (no SQL, no `db`/`enqueueWrite` — this is the dummy backend); `listBackgrounds` reads from this file's own reference-data parameter the same way `listTags`/`listPokemonInstances` already do.

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: all pass, including the two new test files.

- [ ] **Step 7: Commit**

```bash
git add src/data/repository.ts src/data/sqlite-repository.ts src/data/in-memory-store.ts test/update-pokemon-instance.test.ts
git commit -m "Add updatePokemonInstance and listBackgrounds repository methods"
```

---

### Task 6: Log-a-catch — Dynamax/Received-via-trade checkboxes

**Files:**
- Modify: `src/features/log-catch/LogCatchPage.vue`

**Interfaces:**
- Consumes: `NewPokemonInstanceBatch.dynamax`/`.receivedViaTrade` (Task 3).

- [ ] **Step 1: Add the two refs**

In `src/features/log-catch/LogCatchPage.vue`'s `<script setup>`, after line 54 (`const purified = ref(false);`):

```ts
const dynamax = ref(false);
const receivedViaTrade = ref(false);
```

- [ ] **Step 2: Include them in the save payload**

In the `save()` function's `batch` object (around line 127-130):

```ts
      shiny: shiny.value,
      lucky: lucky.value,
      shadow: shadow.value,
      purified: purified.value,
      dynamax: dynamax.value,
      receivedViaTrade: receivedViaTrade.value,
```

- [ ] **Step 3: Add the two checkboxes to the template**

In the "State" fieldset (around line 192-198), after the Purified checkbox:

```html
    <label class="toggle-row"><input type="checkbox" v-model="purified" /><span>Purified</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="dynamax" /><span>Dynamax</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="receivedViaTrade" /><span>Received via trade</span></label>
```

- [ ] **Step 4: Manual verification**

Run: `npm run dev`, open Log a catch, check Dynamax and Received via trade, log a catch, then check (via a quick `sqlite3` inspection of the dummy DB, or by opening the new edit-instance page once Task 7 lands) that both flags saved.

Since this task has no new logic (just wiring two more of an already-repeated pattern), no new automated test is required — Task 3's tests already cover the underlying `createPokemonInstances` behavior these checkboxes feed into.

- [ ] **Step 5: Commit**

```bash
git add src/features/log-catch/LogCatchPage.vue
git commit -m "Add Dynamax/Received via trade checkboxes to Log-a-catch"
```

---

### Task 7: `EditInstancePage.vue` + routing + Collection entry point

**Files:**
- Create: `src/features/collection/EditInstancePage.vue`
- Modify: `src/app-shell/router.ts`
- Modify: `src/main.ts`
- Modify: `src/features/collection/CollectionPage.vue`
- Test: `e2e/edit-instance.spec.ts` (new)

**Interfaces:**
- Consumes: `repo.getPokemonInstance`, `repo.updatePokemonInstance`, `repo.listBackgrounds`, `repo.listTags`, `repo.createTag` (all exist by this point), `IvComponentInput.vue` (existing component), `computeIvPercent` (existing).
- Produces: `Route` variant `{ name: "edit-instance"; instanceId: number }`, `editInstancePath(id: number): string` helper.

- [ ] **Step 1: Add the route**

In `src/app-shell/router.ts`, add to the `Route` union:

```ts
  | { name: "edit-instance"; instanceId: number }
```

Add path matching in `parseRoute` (after the `detailMatch` check, same style):

```ts
  const editInstanceMatch = path.match(/^\/collection\/(\d+)\/edit$/);
  if (editInstanceMatch) return { name: "edit-instance", instanceId: Number(editInstanceMatch[1]) };
```

Add the path helper near `speciesDetailPath`:

```ts
export function editInstancePath(instanceId: number): string {
  return `/collection/${instanceId}/edit`;
}
```

- [ ] **Step 2: Create `EditInstancePage.vue`**

```vue
<!--
  Edit an individual logged specimen's details -- reached from Collection's
  row-tap action menu ("Edit details" button, see CollectionPage.vue). Status
  changes (kept/traded/released/evolved) stay on Collection's own action
  menu, not duplicated here -- see docs/superpowers/specs/2026-07-24-sub-project-5-collection-dex-tags-design.md.
-->
<script setup lang="ts">
import { ref } from "vue";
import type { Repository, UpdatePokemonInstanceFields } from "../../data/repository";
import { computeIvPercent } from "../../db/types";
import { navigate } from "../../app-shell/router";
import IvComponentInput from "../log-catch/IvComponentInput.vue";

const props = defineProps<{ repo: Repository; instanceId: number }>();

const loaded = props.repo.getPokemonInstance(props.instanceId);
if (!loaded) {
  navigate("/collection");
}

const instance = loaded!.instance;

const nickname = ref(instance.nickname ?? "");
const cp = ref<number | null>(instance.cp);
const ivAttack = ref<number | null>(instance.ivAttack);
const ivDefense = ref<number | null>(instance.ivDefense);
const ivStamina = ref<number | null>(instance.ivStamina);
const shiny = ref(instance.shiny);
const lucky = ref(instance.lucky);
const shadow = ref(instance.shadow);
const purified = ref(instance.purified);
const dynamax = ref(instance.dynamax);
const receivedViaTrade = ref(instance.receivedViaTrade);
const heartsEarned = ref<number | null>(instance.heartsEarned);
const currentMegaLevel = ref<number | null>(instance.currentMegaLevel);
const backgroundSlug = ref<string | null>(instance.backgroundSlug);

const backgrounds = props.repo.listBackgrounds();

const tags = ref(props.repo.listTags());
const selectedTagIds = ref<Set<number>>(new Set(loaded!.tags.map((t) => t.id)));
const newTagName = ref("");

function toggleTag(id: number) {
  if (selectedTagIds.value.has(id)) selectedTagIds.value.delete(id);
  else selectedTagIds.value.add(id);
  selectedTagIds.value = new Set(selectedTagIds.value);
}

async function addNewTag() {
  const name = newTagName.value.trim();
  if (!name) return;
  const tag = await props.repo.createTag(name);
  tags.value = props.repo.listTags();
  selectedTagIds.value = new Set([...selectedTagIds.value, tag.id]);
  newTagName.value = "";
}

const saving = ref(false);
const saveError = ref("");

async function save() {
  saving.value = true;
  saveError.value = "";
  try {
    const fields: UpdatePokemonInstanceFields = {
      nickname: nickname.value.trim() || null,
      cp: cp.value,
      ivAttack: ivAttack.value,
      ivDefense: ivDefense.value,
      ivStamina: ivStamina.value,
      shiny: shiny.value,
      lucky: lucky.value,
      shadow: shadow.value,
      purified: purified.value,
      dynamax: dynamax.value,
      receivedViaTrade: receivedViaTrade.value,
      heartsEarned: heartsEarned.value,
      currentMegaLevel: currentMegaLevel.value,
      backgroundSlug: backgroundSlug.value,
      tagIds: [...selectedTagIds.value],
    };
    await props.repo.updatePokemonInstance(props.instanceId, fields);
    navigate("/collection");
  } catch (err) {
    saveError.value = `Save failed: ${(err as Error).message}`;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <h2>Edit specimen</h2>
  <p class="gap-note" v-if="loaded">{{ loaded.species.name }} — #{{ loaded.species.dexNumber }} {{ loaded.form.formName }}</p>

  <fieldset>
    <legend>Details</legend>
    <div class="input-grid">
      <label class="field">Nickname<input type="text" v-model="nickname" /></label>
      <label class="field">CP<input type="number" v-model.number="cp" /></label>
      <IvComponentInput v-model="ivAttack" label="Attack IV" />
      <IvComponentInput v-model="ivDefense" label="Defense IV" />
      <IvComponentInput v-model="ivStamina" label="Stamina IV" />
      <div class="field" v-if="computeIvPercent(ivAttack, ivDefense, ivStamina) !== null">
        <span class="iv-component-label">IV %</span>
        <span class="tabular">{{ computeIvPercent(ivAttack, ivDefense, ivStamina) }}%</span>
      </div>
      <label class="field">Hearts earned<input type="number" v-model.number="heartsEarned" /></label>
      <label class="field">Current Mega Level<input type="number" v-model.number="currentMegaLevel" /></label>
      <label class="field">
        Background
        <select v-model="backgroundSlug">
          <option :value="null">None</option>
          <option v-for="bg in backgrounds" :key="bg.slug" :value="bg.slug">{{ bg.name }}</option>
        </select>
      </label>
    </div>
  </fieldset>

  <fieldset>
    <legend>State</legend>
    <label class="toggle-row"><input type="checkbox" v-model="shiny" /><span>Shiny</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="lucky" /><span>Lucky</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="shadow" /><span>Shadow</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="purified" /><span>Purified</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="dynamax" /><span>Dynamax</span></label>
    <label class="toggle-row"><input type="checkbox" v-model="receivedViaTrade" /><span>Received via trade</span></label>
  </fieldset>

  <fieldset>
    <legend>Tags</legend>
    <div class="tag-picker">
      <button
        type="button"
        v-for="tag in tags"
        :key="tag.id"
        :class="['tag-chip', { on: selectedTagIds.has(tag.id) }]"
        @click="toggleTag(tag.id)"
      >
        {{ tag.name }}
      </button>
    </div>
    <div class="new-tag-row">
      <input type="text" placeholder="New tag…" v-model="newTagName" @keyup.enter="addNewTag" />
      <button type="button" @click="addNewTag">+ Add tag</button>
    </div>
  </fieldset>

  <p class="gap-note" v-if="saveError" style="color: var(--negative, crimson);">{{ saveError }}</p>
  <button type="button" class="save-button" :disabled="saving" @click="save">Save</button>
</template>
```

- [ ] **Step 3: Wire the route in `main.ts`**

Add the import:

```ts
import EditInstancePage from "./features/collection/EditInstancePage.vue";
```

Add to `ROUTE_TITLES`... actually `edit-instance` needs a dynamic title (species name), so leave it out of the static `ROUTE_TITLES` map and instead check how `data-entry-detail` (also dynamic) sets its header — search `grep -n "data-entry-detail" src/main.ts` for the exact pattern it uses, and mirror it for `edit-instance` (likely a `case "edit-instance":` branch that builds its own header rather than reading `ROUTE_TITLES`).

Add the route case (alongside `case "collection":`):

```ts
        case "edit-instance":
          mountVueRoute(contentEl, EditInstancePage, { repo, instanceId: route.instanceId });
          break;
```

- [ ] **Step 4: Add the "Edit details" button to `CollectionPage.vue`**

In `src/features/collection/CollectionPage.vue`'s `<script setup>`, add the import and a navigation helper:

```ts
import { editInstancePath, navigate } from "../../app-shell/router";
```

```ts
function editInstance(id: number) {
  navigate(editInstancePath(id));
}
```

In the template's action menu (around line 100-107), add a fifth button:

```html
      <div class="collection-actions" v-if="openActionsFor === row.instance.id">
        <button type="button" @click="setStatus(row.instance.id, 'kept')">Mark kept</button>
        <button type="button" @click="setStatus(row.instance.id, 'traded')">Mark traded</button>
        <button type="button" @click="setStatus(row.instance.id, 'released')">Release</button>
        <button type="button" @click="setStatus(row.instance.id, 'evolved')">Mark evolved</button>
        <button type="button" @click="editInstance(row.instance.id)">Edit details</button>
      </div>
```

- [ ] **Step 5: Write the e2e test**

Create `e2e/edit-instance.spec.ts`. Check `e2e/dex-grid-core.spec.ts` or `e2e/species-detail-tracking.spec.ts` first for this app's exact Playwright setup conventions (base URL, how a fresh dummy DB is ensured per test, selector style) before writing — do not invent a different pattern. The test should:
1. Navigate to Log a catch, log one specimen of a known species (Full details mode, so nickname/IV fields are available).
2. Navigate to Collection, tap the logged row, tap "Edit details".
3. Verify the edit page loaded with the correct species name and pre-filled nickname.
4. Change the nickname and check the Dynamax checkbox, tap Save.
5. Verify Collection now shows the new nickname on that row.

- [ ] **Step 6: Run the e2e test**

Run: `npx playwright test e2e/edit-instance.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/collection/EditInstancePage.vue src/app-shell/router.ts src/main.ts src/features/collection/CollectionPage.vue e2e/edit-instance.spec.ts
git commit -m "Add edit-instance page, reachable from Collection's action menu (fixes Sub-project 5a)"
```

---

### Task 8: Tag management — `getTagUsageCounts`/`renameTag`/`deleteTag`

**Files:**
- Modify: `src/data/repository.ts`
- Modify: `src/data/sqlite-repository.ts`
- Modify: `src/data/in-memory-store.ts`
- Test: `test/tag-management.test.ts` (new)

**Interfaces:**
- Produces: `repo.getTagUsageCounts(): TagCount[]`, `repo.renameTag(id, name): Promise<void>`, `repo.deleteTag(id): Promise<void>` — consumed by Task 9.

- [ ] **Step 1: Add method signatures to `repository.ts`**

Near `listTags`/`createTag` (line 282-283):

```ts
  listTags(): Tag[];
  createTag(name: string): Promise<Tag>;
  getTagUsageCounts(): TagCount[];
  renameTag(id: number, name: string): Promise<void>;
  deleteTag(id: number): Promise<void>;
```

(`TagCount` already exists, defined near `SpecimenStateCounts` — line 361-364.)

- [ ] **Step 2: Write the failing tests**

Create `test/tag-management.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runPersonalMigrations } from "../src/db/migrations";
import { nodeSqliteConnection } from "./node-sqlite-connection";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

test("renaming a tag updates its name", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'old-name')").run();
  const id = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;

  db.prepare("UPDATE tag SET name = ? WHERE id = ?").run("new-name", id);

  const row = db.prepare("SELECT name FROM tag WHERE id = ?").get(id) as { name: string };
  assert.equal(row.name, "new-name");
});

test("deleting a tag removes it and its pokemon_instance_tag links", async () => {
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'shiny-hunt')").run();
  const tagId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at) VALUES ('bulbasaur-standard', 1, 0, 0)",
  ).run();
  const instanceId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tagId);

  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("DELETE FROM pokemon_instance_tag WHERE tag_id = ?").run(tagId);
  db.prepare("DELETE FROM tag WHERE id = ?").run(tagId);

  const tagRow = db.prepare("SELECT * FROM tag WHERE id = ?").get(tagId);
  assert.equal(tagRow, undefined);
  const linkRow = db.prepare("SELECT * FROM pokemon_instance_tag WHERE tag_id = ?").get(tagId);
  assert.equal(linkRow, undefined);
});

test("deleting a tag with foreign_keys ON but without removing links first throws", async () => {
  // Documents WHY deleteTag must delete pokemon_instance_tag rows before
  // the tag row itself -- pokemon_instance_tag.tag_id REFERENCES tag(id)
  // with no ON DELETE CASCADE (see src/db/migrations/0000_baseline.sql).
  const db = freshDb();
  await runPersonalMigrations(nodeSqliteConnection(db));
  db.prepare("INSERT INTO tag (profile_id, name) VALUES (1, 'shiny-hunt')").run();
  const tagId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare(
    "INSERT INTO pokemon_instance (form_slug, profile_id, recorded_at, updated_at) VALUES ('bulbasaur-standard', 1, 0, 0)",
  ).run();
  const instanceId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
  db.prepare("INSERT INTO pokemon_instance_tag (pokemon_instance_id, tag_id) VALUES (?, ?)").run(instanceId, tagId);

  db.exec("PRAGMA foreign_keys = ON");
  assert.throws(() => db.prepare("DELETE FROM tag WHERE id = ?").run(tagId), /FOREIGN KEY constraint failed/);
});
```

- [ ] **Step 3: Run the tests**

Run: `npx tsx --test test/tag-management.test.ts`
Expected: PASS — these pin the exact SQL/ordering `renameTag`/`deleteTag` must use.

- [ ] **Step 4: Implement in `sqlite-repository.ts`**

Add to the final returned object:

```ts
    getTagUsageCounts(): TagCount[] {
      const counts = new Map<number, number>();
      for (const link of state.pokemonInstanceTags) counts.set(link.tagId, (counts.get(link.tagId) ?? 0) + 1);
      return state.tags
        .map((tag) => ({ tag, count: counts.get(tag.id) ?? 0 }))
        .sort((a, b) => a.tag.name.localeCompare(b.tag.name));
    },
    async renameTag(id: number, name: string): Promise<void> {
      await enqueueWrite(async () => {
        await db.run("UPDATE tag SET name = ? WHERE id = ?", [name, id], true);
        await persistDb();
      });
      await writeQueue;
      const idx = state.tags.findIndex((t) => t.id === id);
      if (idx !== -1) state.tags[idx] = { ...state.tags[idx], name };
    },
    async deleteTag(id: number): Promise<void> {
      await enqueueWrite(async () => {
        await db.beginTransaction();
        await db.run("DELETE FROM pokemon_instance_tag WHERE tag_id = ?", [id], false);
        await db.run("DELETE FROM tag WHERE id = ?", [id], false);
        await db.commitTransaction();
        await persistDb();
      });
      await writeQueue;
      state.tags = state.tags.filter((t) => t.id !== id);
      state.pokemonInstanceTags = state.pokemonInstanceTags.filter((l) => l.tagId !== id);
    },
```

- [ ] **Step 5: Implement the same three methods in `in-memory-store.ts`**

Same logic, mutating `state.tags`/`state.pokemonInstanceTags` directly with no SQL (dummy backend).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/data/repository.ts src/data/sqlite-repository.ts src/data/in-memory-store.ts test/tag-management.test.ts
git commit -m "Add getTagUsageCounts/renameTag/deleteTag repository methods"
```

---

### Task 9: `TagsPage.vue` + routing + nav entry

**Files:**
- Create: `src/features/tags/TagsPage.vue`
- Modify: `src/app-shell/router.ts`
- Modify: `src/main.ts`
- Modify: `src/app-shell/nav-drawer.ts`
- Test: `e2e/tags-page.spec.ts` (new)

**Interfaces:**
- Consumes: `repo.getTagUsageCounts`, `repo.renameTag`, `repo.deleteTag` (Task 8).
- Produces: `Route` variant `{ name: "tags" }`.

- [ ] **Step 1: Add the route**

In `src/app-shell/router.ts`'s `Route` union:

```ts
  | { name: "tags" }
```

In `parseRoute`'s switch:

```ts
    case "/tags":
      return { name: "tags" };
```

- [ ] **Step 2: Create `TagsPage.vue`**

```vue
<!--
  Browse/rename/delete tags -- fixes the "no list of tags" gap. See
  docs/superpowers/specs/2026-07-24-sub-project-5-collection-dex-tags-design.md
  section 5c. Rename follows the same always-editable-input,
  save-on-@change pattern TrainerPage.vue already uses for trainer
  name/friend code, rather than a separate edit-mode toggle.
-->
<script setup lang="ts">
import { ref } from "vue";
import type { Repository } from "../../data/repository";

const props = defineProps<{ repo: Repository }>();

const rows = ref(props.repo.getTagUsageCounts());
const nameDrafts = ref<Record<number, string>>(Object.fromEntries(rows.value.map((r) => [r.tag.id, r.tag.name])));

async function saveRename(id: number) {
  const name = (nameDrafts.value[id] ?? "").trim();
  if (!name) return;
  await props.repo.renameTag(id, name);
  rows.value = props.repo.getTagUsageCounts();
}

async function remove(id: number, name: string) {
  if (!confirm(`Delete tag "${name}"? This removes it from every specimen it's applied to.`)) return;
  await props.repo.deleteTag(id);
  rows.value = props.repo.getTagUsageCounts();
}
</script>

<template>
  <h2>Tags</h2>
  <p class="gap-note" v-if="rows.length === 0">No tags yet — create one from Log a catch's Full details mode.</p>

  <ul class="collection-list">
    <li v-for="row in rows" :key="row.tag.id" class="collection-row">
      <input type="text" v-model="nameDrafts[row.tag.id]" @change="saveRename(row.tag.id)" />
      <span class="gap-note">{{ row.count }} specimen{{ row.count === 1 ? "" : "s" }}</span>
      <button type="button" @click="remove(row.tag.id, row.tag.name)">Delete</button>
    </li>
  </ul>
</template>
```

- [ ] **Step 3: Wire the route in `main.ts`**

Add the import:

```ts
import TagsPage from "./features/tags/TagsPage.vue";
```

Add to `ROUTE_TITLES`:

```ts
  tags: "Tags",
```

Add the route case:

```ts
        case "tags":
          mountVueRoute(contentEl, TagsPage, { repo });
          break;
```

- [ ] **Step 4: Add the nav entry**

In `src/app-shell/nav-drawer.ts`'s `NAV_ITEMS` array, add after the Trainer entry:

```ts
  { label: "Tags", path: "/tags", routeName: "tags", icon: "🏷" },
```

- [ ] **Step 5: Write the e2e test**

Create `e2e/tags-page.spec.ts`. Check the same existing e2e spec files referenced in Task 7 for conventions. The test should:
1. Navigate to Log a catch, create a new tag via the inline creator, log a specimen with it applied.
2. Navigate to Tags (via the nav entry).
3. Verify the new tag appears with a usage count of 1.
4. Rename it, verify the new name persists after reload.
5. Delete it, verify it's gone from the list.

- [ ] **Step 6: Run the e2e test**

Run: `npx playwright test e2e/tags-page.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/features/tags/TagsPage.vue src/app-shell/router.ts src/main.ts src/app-shell/nav-drawer.ts e2e/tags-page.spec.ts
git commit -m "Add Tags management page, reachable from main nav (fixes Sub-project 5c)"
```

---

### Task 10: Documentation updates

**Files:**
- Modify: `docs/data-model.md`
- Modify: `docs/superpowers/specs/2026-07-23-v2-consolidation-roadmap.md`

- [ ] **Step 1: Update `docs/data-model.md`**

In the `pokemon_instance` section of the schema listing, add `dynamax bool` and `received_via_trade bool` to the column list (find the exact spot via `grep -n "pokemon_instance$" docs/data-model.md` — the reference table listing, not the `form_personal` one). Add a short paragraph near the versioning-policy section noting schema v9's addition, matching the style of the existing v7→8 paragraph (`docs/data-model.md`'s "There are three migrations" section, which needs updating to "There are four migrations" with a new paragraph for migration `0003`).

- [ ] **Step 2: Mark Sub-project 5 as done in the roadmap**

In `docs/superpowers/specs/2026-07-23-v2-consolidation-roadmap.md`'s Sequence section, change item 5's line from describing the pending work to `— done`, matching how items 1-4 are marked.

- [ ] **Step 3: Commit**

```bash
git add docs/data-model.md docs/superpowers/specs/2026-07-23-v2-consolidation-roadmap.md
git commit -m "Document schema v9 and mark Sub-project 5 done in the roadmap"
```

---

## Final Review Checklist (for the whole-branch reviewer)

- Every new boolean column (`dynamax`, `received_via_trade`) has a named CHECK constraint, matching the existing pattern.
- `resolveInstanceAchievementField` never sets more than one field directly — verify no task accidentally reintroduced a multi-field derivation table.
- The IV-floor fields are untouched by any task in this plan.
- `updatePokemonInstance`'s tag-diff correctly handles the empty-array case (full-clear), not just non-empty replacement — the `NOT IN (NULL)` SQLite gotcha noted in Task 5.
- `deleteTag` always removes `pokemon_instance_tag` rows before the `tag` row, in the same transaction.
- Migration count assertions (`test/migrations.test.ts`, `test/drizzle-v6-bootstrap.test.ts`) reflect 4 migrations, not 3.
