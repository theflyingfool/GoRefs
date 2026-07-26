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
