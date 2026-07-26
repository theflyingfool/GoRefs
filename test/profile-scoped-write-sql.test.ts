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
import { FORM_PERSONAL_BOOLEAN_FIELDS, FORM_PERSONAL_FIELD_COLUMNS, type FormPersonal } from "../src/db/types";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const formPersonalBooleanColumns = FORM_PERSONAL_BOOLEAN_FIELDS.map((f) => `${FORM_PERSONAL_FIELD_COLUMNS[f]} INTEGER NOT NULL DEFAULT 0`).join(", ");
  db.exec(`
    CREATE TABLE species_personal (species_slug TEXT NOT NULL, profile_id TEXT NOT NULL, registered INTEGER NOT NULL DEFAULT 0, xxl INTEGER NOT NULL DEFAULT 0, xxs INTEGER NOT NULL DEFAULT 0, purified INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, species_slug));
    CREATE TABLE app_settings (key TEXT NOT NULL, profile_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (profile_id, key));
    CREATE TABLE mega_personal (mega_variant_slug TEXT NOT NULL, profile_id TEXT NOT NULL, evolved INTEGER NOT NULL DEFAULT 0, shiny_evolved INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, mega_variant_slug));
    CREATE TABLE form_background_personal (form_slug TEXT NOT NULL, profile_id TEXT NOT NULL, achievement_field TEXT NOT NULL, background_slug TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, form_slug, achievement_field, background_slug));
    CREATE TABLE form_personal (form_slug TEXT NOT NULL, profile_id TEXT NOT NULL, ${formPersonalBooleanColumns}, best_shiny TEXT, best_non_shiny TEXT, best_lucky TEXT, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, form_slug));
  `);
  return db;
}

function makeFormPersonal(overrides: Partial<FormPersonal> = {}): FormPersonal {
  const base = { formSlug: "pikachu-standard", bestShiny: null, bestNonShiny: null, bestLucky: null, updatedAt: 1 } as FormPersonal;
  for (const field of FORM_PERSONAL_BOOLEAN_FIELDS) base[field] = false;
  return { ...base, ...overrides };
}

test("buildSpeciesPersonalUpsert scopes two profiles' rows for the same species independently", () => {
  const db = freshDb();
  const first = buildSpeciesPersonalUpsert("profile-a", "bulbasaur", { registered: true, xxl: false, xxs: false, purified: false, updatedAt: 1 });
  const second = buildSpeciesPersonalUpsert("profile-b", "bulbasaur", { registered: false, xxl: false, xxs: false, purified: false, updatedAt: 2 });
  db.prepare(first.sql).run(...(first.params as never[]));
  db.prepare(second.sql).run(...(second.params as never[]));

  const rows = (db.prepare("SELECT profile_id, registered FROM species_personal ORDER BY profile_id").all() as { profile_id: string; registered: number }[]).map((row) => ({ ...row }));
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
  const rows = (db.prepare("SELECT profile_id, value FROM app_settings ORDER BY profile_id").all() as { profile_id: string; value: string }[]).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { profile_id: "profile-a", value: "dark" },
    { profile_id: "profile-b", value: "light" },
  ]);
});

test("buildFormPersonalUpsert scopes the same form_slug independently per profile", () => {
  const db = freshDb();
  const first = buildFormPersonalUpsert("profile-a", makeFormPersonal({ caught: true, shiny: true, updatedAt: 1 }));
  const second = buildFormPersonalUpsert("profile-b", makeFormPersonal({ caught: false, updatedAt: 2 }));
  db.prepare(first.sql).run(...(first.params as never[]));
  db.prepare(second.sql).run(...(second.params as never[]));

  const rows = (db.prepare("SELECT profile_id, caught, shiny FROM form_personal ORDER BY profile_id").all() as { profile_id: string; caught: number; shiny: number }[]).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { profile_id: "profile-a", caught: 1, shiny: 1 },
    { profile_id: "profile-b", caught: 0, shiny: 0 },
  ]);

  // Re-upserting the same profile+form_slug updates in place, doesn't duplicate.
  const update = buildFormPersonalUpsert("profile-a", makeFormPersonal({ caught: false, updatedAt: 3 }));
  db.prepare(update.sql).run(...(update.params as never[]));
  const afterUpdate = db.prepare("SELECT COUNT(*) as c FROM form_personal WHERE profile_id = 'profile-a'").get() as { c: number };
  assert.equal(afterUpdate.c, 1);
});

test("buildMegaPersonalUpsert scopes the same mega_variant_slug independently per profile", () => {
  const db = freshDb();
  const first = buildMegaPersonalUpsert("profile-a", "charizard-x", { evolved: true, shinyEvolved: false, updatedAt: 1 });
  const second = buildMegaPersonalUpsert("profile-b", "charizard-x", { evolved: false, shinyEvolved: false, updatedAt: 2 });
  db.prepare(first.sql).run(...(first.params as never[]));
  db.prepare(second.sql).run(...(second.params as never[]));

  const rows = (db.prepare("SELECT profile_id, evolved FROM mega_personal ORDER BY profile_id").all() as { profile_id: string; evolved: number }[]).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { profile_id: "profile-a", evolved: 1 },
    { profile_id: "profile-b", evolved: 0 },
  ]);

  // Re-upserting the same profile+slug updates in place, doesn't duplicate.
  const update = buildMegaPersonalUpsert("profile-a", "charizard-x", { evolved: false, shinyEvolved: false, updatedAt: 3 });
  db.prepare(update.sql).run(...(update.params as never[]));
  const afterUpdate = db.prepare("SELECT COUNT(*) as c FROM mega_personal WHERE profile_id = 'profile-a'").get() as { c: number };
  assert.equal(afterUpdate.c, 1);
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
