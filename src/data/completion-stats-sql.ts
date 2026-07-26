// Drizzle-backed implementation of the completion-stats feature (CLAUDE.md
// Feature 1) — one query per lens kind, parameterized by scope. Rewritten
// from hand-written parameterized SQL (see git history) onto Drizzle's
// query builder against src/db/schema/reference.ts + schema/personal.ts.
// src/data/in-memory-store.ts deliberately has no JS equivalent of this
// feature — this is the only implementation.

import { and, eq, exists, isNull, ne, notExists, notLike, or, sql } from "drizzle-orm";
import type { SQLiteDBConnection } from "../db/sqlite-connection";
import { getDrizzleDb } from "../db/drizzle-client";
import { form, megaVariant, species } from "../db/schema/reference";
import { formPersonal, megaPersonal, speciesPersonal } from "../db/schema/personal";
import { FORM_PERSONAL_BOOLEAN_FIELDS, FORM_PERSONAL_FIELD_COLUMNS, type FormPersonalBooleanField } from "../db/types";
import type { CompletionLens, CompletionLensResult, CompletionMissingSpecies, CompletionScope } from "./repository";

type DrizzleDb = ReturnType<typeof getDrizzleDb>;

function scopeCondition(scope: CompletionScope) {
  switch (scope.kind) {
    case "region":
      return eq(species.regionSlug, scope.regionSlug);
    case "species":
      return eq(species.slug, scope.speciesSlug);
    case "global":
      return sql`1 = 1`;
  }
}

// Mirrors field-groups.ts's isGigantamaxForm — can't call that JS predicate
// from a query builder, so this re-encodes the same "formName is always
// 'Gigantamax' or 'Gigantamax {style}'" rule. Keep the two in sync if that
// ingestion convention ever changes.
function notGigantamax(formNameColumn: typeof form.formName) {
  return and(ne(formNameColumn, "Gigantamax"), notLike(formNameColumn, "Gigantamax %"));
}

async function countSpecies(db: DrizzleDb, scopeCond: ReturnType<typeof scopeCondition>): Promise<number> {
  const rows = await db.select({ c: sql<number>`count(*)` }).from(species).where(scopeCond);
  return rows[0]?.c ?? 0;
}

function toMissing(rows: { slug: string; name: string; dexNumber: number }[]): CompletionMissingSpecies[] {
  return rows.map((r) => ({ slug: r.slug, name: r.name, dexNumber: r.dexNumber }));
}

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

async function formCompleteLens(db: DrizzleDb, profileId: string, scope: CompletionScope, excludeRegional: boolean): Promise<Omit<CompletionLensResult, "lens">> {
  const scopeCond = scopeCondition(scope);
  const total = await countSpecies(db, scopeCond);
  const innerConditions = [eq(form.speciesSlug, species.slug), isNull(form.costumeName), notGigantamax(form.formName)];
  if (excludeRegional) innerConditions.push(eq(form.regionalExclusive, false));
  innerConditions.push(or(isNull(formPersonal.caught), eq(formPersonal.caught, false))!);

  const missingRows = await db
    .select({ slug: species.slug, name: species.name, dexNumber: species.dexNumber })
    .from(species)
    .where(
      and(
        scopeCond,
        exists(
          db
            .select({ one: sql`1` })
            .from(form)
            .leftJoin(formPersonal, and(eq(formPersonal.formSlug, form.slug), eq(formPersonal.profileId, profileId)))
            .where(and(...innerConditions)),
        ),
      ),
    );
  const missingSpecies = toMissing(missingRows);
  return { total, complete: total - missingSpecies.length, missingSpecies };
}

async function gigantamaxCompleteLens(db: DrizzleDb, profileId: string, scope: CompletionScope): Promise<Omit<CompletionLensResult, "lens">> {
  const scopeCond = scopeCondition(scope);
  const totalRows = await db
    .select({ c: sql<number>`count(distinct ${species.slug})` })
    .from(species)
    .innerJoin(form, eq(form.speciesSlug, species.slug))
    .where(and(scopeCond, sql`not (${notGigantamax(form.formName)})`));
  const total = totalRows[0]?.c ?? 0;

  const missingRows = await db
    .selectDistinct({ slug: species.slug, name: species.name, dexNumber: species.dexNumber })
    .from(species)
    .innerJoin(form, eq(form.speciesSlug, species.slug))
    .where(
      and(
        scopeCond,
        sql`not (${notGigantamax(form.formName)})`,
        exists(
          db
            .select({ one: sql`1` })
            .from(form)
            .leftJoin(formPersonal, and(eq(formPersonal.formSlug, form.slug), eq(formPersonal.profileId, profileId)))
            .where(and(eq(form.speciesSlug, species.slug), sql`not (${notGigantamax(form.formName)})`, or(isNull(formPersonal.caught), eq(formPersonal.caught, false)))),
        ),
      ),
    );
  const missingSpecies = toMissing(missingRows);
  return { total, complete: total - missingSpecies.length, missingSpecies };
}

async function costumeCompleteLens(db: DrizzleDb, profileId: string, scope: CompletionScope): Promise<Omit<CompletionLensResult, "lens">> {
  const scopeCond = scopeCondition(scope);
  const totalRows = await db
    .select({ c: sql<number>`count(distinct ${species.slug})` })
    .from(species)
    .innerJoin(form, eq(form.speciesSlug, species.slug))
    .where(and(scopeCond, sql`${form.costumeName} is not null`));
  const total = totalRows[0]?.c ?? 0;

  const missingRows = await db
    .selectDistinct({ slug: species.slug, name: species.name, dexNumber: species.dexNumber })
    .from(species)
    .innerJoin(form, eq(form.speciesSlug, species.slug))
    .where(
      and(
        scopeCond,
        sql`${form.costumeName} is not null`,
        exists(
          db
            .select({ one: sql`1` })
            .from(form)
            .leftJoin(formPersonal, and(eq(formPersonal.formSlug, form.slug), eq(formPersonal.profileId, profileId)))
            .where(and(eq(form.speciesSlug, species.slug), sql`${form.costumeName} is not null`, or(isNull(formPersonal.caught), eq(formPersonal.caught, false)))),
        ),
      ),
    );
  const missingSpecies = toMissing(missingRows);
  return { total, complete: total - missingSpecies.length, missingSpecies };
}

async function megaCompleteLens(db: DrizzleDb, profileId: string, scope: CompletionScope, shiny: boolean): Promise<Omit<CompletionLensResult, "lens">> {
  const column = shiny ? megaPersonal.shinyEvolved : megaPersonal.evolved;
  const scopeCond = scopeCondition(scope);
  const totalRows = await db
    .select({ c: sql<number>`count(distinct ${species.slug})` })
    .from(species)
    .innerJoin(megaVariant, eq(megaVariant.speciesSlug, species.slug))
    .where(scopeCond);
  const total = totalRows[0]?.c ?? 0;

  const missingRows = await db
    .selectDistinct({ slug: species.slug, name: species.name, dexNumber: species.dexNumber })
    .from(species)
    .innerJoin(megaVariant, eq(megaVariant.speciesSlug, species.slug))
    .where(
      and(
        scopeCond,
        exists(
          db
            .select({ one: sql`1` })
            .from(megaVariant)
            .leftJoin(megaPersonal, and(eq(megaPersonal.megaVariantSlug, megaVariant.slug), eq(megaPersonal.profileId, profileId)))
            .where(and(eq(megaVariant.speciesSlug, species.slug), or(isNull(column), eq(column, false)))),
        ),
      ),
    );
  const missingSpecies = toMissing(missingRows);
  return { total, complete: total - missingSpecies.length, missingSpecies };
}

async function achievementLens(db: DrizzleDb, profileId: string, scope: CompletionScope, field: FormPersonalBooleanField): Promise<Omit<CompletionLensResult, "lens">> {
  if (!FORM_PERSONAL_BOOLEAN_FIELDS.includes(field)) throw new Error(`Unknown achievement field: ${field}`);
  const column = formPersonal[field as keyof typeof formPersonal] as typeof formPersonal.caught;
  void FORM_PERSONAL_FIELD_COLUMNS; // column resolved via the typed table object directly, not a snake_case string

  const scopeCond = scopeCondition(scope);
  const total = await countSpecies(db, scopeCond);
  const missingRows = await db
    .select({ slug: species.slug, name: species.name, dexNumber: species.dexNumber })
    .from(species)
    .where(
      and(
        scopeCond,
        notExists(
          db
            .select({ one: sql`1` })
            .from(form)
            .innerJoin(formPersonal, and(eq(formPersonal.formSlug, form.slug), eq(formPersonal.profileId, profileId)))
            .where(and(eq(form.speciesSlug, species.slug), eq(column, true))),
        ),
      ),
    );
  const missingSpecies = toMissing(missingRows);
  return { total, complete: total - missingSpecies.length, missingSpecies };
}

export async function getCompletionStatsSql(
  conn: SQLiteDBConnection,
  profileId: string,
  scope: CompletionScope,
  lenses: CompletionLens[],
  excludeRegionalFromFormComplete: boolean,
): Promise<CompletionLensResult[]> {
  const db = getDrizzleDb(conn);
  const results: CompletionLensResult[] = [];
  for (const lens of lenses) {
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
    results.push({ lens, ...partial });
  }
  return results;
}
