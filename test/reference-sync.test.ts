import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { runPersonalMigrations } from "../src/db/migrations";
import { syncReferenceData } from "../src/db/reference-sync";
import type { ReferenceData } from "../src/db/reference-data";
import { nodeSqliteConnection } from "./node-sqlite-connection";

function fixture(speciesSlugs: string[]): ReferenceData {
  return {
    regions: [{ slug: "kanto", name: "Kanto" }],
    types: [{ slug: "grass", name: "Grass" }],
    backgrounds: [],
    species: speciesSlugs.map((slug, i) => ({
      slug,
      dexNumber: i + 1,
      name: slug,
      familySlug: slug,
      gen: 1,
      rarity: "standard",
      regionSlug: "kanto",
      hasMale: true,
      hasFemale: false,
      canMegaEvolve: false,
      canGigantamax: false,
    })),
    forms: speciesSlugs.map((slug) => ({
      slug: `${slug}-standard`,
      speciesSlug: slug,
      formName: "Standard",
      costumeName: null,
      gender: "male",
      evolves: false,
      shinyAvailable: true,
      shinyReleasedAt: "2018-03-25",
      shadowAvailable: false,
      dynamaxAvailable: false,
      regionalExclusive: false,
      imageRef: null,
    })),
    formTypes: [],
    megaVariants: [],
    moves: [],
    formMoves: [],
    speciesEvolutions: [],
    typeEffectiveness: [],
    weatherBoosts: [],
    playerLevels: [],
    playerLevelRewards: [],
    medals: [],
    medalTiers: [],
    friendshipLevels: [],
    pvpRankRewards: [],
    pvpRankRequirements: [],
    raidBosses: [],
    raidBossWeatherBoosts: [],
    communityDays: [],
    communityDayBonuses: [],
    communityDaySpecies: [],
    communityDayEventMoves: [],
  };
}

async function freshlyMigratedDb(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  await runPersonalMigrations(nodeSqliteConnection(db));
  return db;
}

test("syncReferenceData populates reference tables from scratch", async () => {
  const db = await freshlyMigratedDb();
  await syncReferenceData(nodeSqliteConnection(db), fixture(["bulbasaur", "charmander"]));

  const species = db.prepare("SELECT slug FROM species ORDER BY slug").all() as { slug: string }[];
  assert.deepEqual(
    species.map((s) => s.slug),
    ["bulbasaur", "charmander"],
  );
  const forms = db.prepare("SELECT slug FROM form ORDER BY slug").all() as { slug: string }[];
  assert.deepEqual(
    forms.map((f) => f.slug),
    ["bulbasaur-standard", "charmander-standard"],
  );
});

test("syncReferenceData round-trips shinyReleasedAt, including the null (never released) case", async () => {
  const db = await freshlyMigratedDb();
  const data = fixture(["bulbasaur"]);
  // A second form on the same species with no shiny-sheet debut match —
  // must persist as SQL NULL, not crash or coerce to a string.
  data.forms.push({
    slug: "bulbasaur-costume-unreleased",
    speciesSlug: "bulbasaur",
    formName: "Costume",
    costumeName: "unreleased-test",
    gender: "male",
    evolves: false,
    shinyAvailable: false,
    shinyReleasedAt: null,
    shadowAvailable: false,
    dynamaxAvailable: false,
    regionalExclusive: false,
    imageRef: null,
  });

  await syncReferenceData(nodeSqliteConnection(db), data);

  const rows = (
    db.prepare("SELECT slug, shiny_released_at FROM form ORDER BY slug").all() as {
      slug: string;
      shiny_released_at: string | null;
    }[]
  ).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { slug: "bulbasaur-costume-unreleased", shiny_released_at: null },
    { slug: "bulbasaur-standard", shiny_released_at: "2018-03-25" },
  ]);
});

test("syncReferenceData treats a missing shinyReleasedAt key (pre-this-field reference.json shape) as null, not a crash", async () => {
  const db = await freshlyMigratedDb();
  const data = fixture(["bulbasaur"]);
  // Simulate the real committed src/data/reference.json, which predates this
  // field entirely and so has no shinyReleasedAt key at all (not even
  // `null`) — `as unknown as ReferenceData` in sqlite-repository.ts means
  // nothing catches this at the type level either.
  const legacyForm = { ...data.forms[0] } as Partial<{ shinyReleasedAt: string | null }> & Record<string, unknown>;
  delete legacyForm.shinyReleasedAt;
  data.forms = [legacyForm as unknown as (typeof data.forms)[number]];

  await syncReferenceData(nodeSqliteConnection(db), data);

  const row = db.prepare("SELECT shiny_released_at FROM form WHERE slug = 'bulbasaur-standard'").get() as {
    shiny_released_at: string | null;
  };
  assert.equal(row.shiny_released_at, null);
});

test("syncReferenceData is a no-op when reference.json content hasn't changed", async () => {
  const db = await freshlyMigratedDb();
  const data = fixture(["bulbasaur"]);
  await syncReferenceData(nodeSqliteConnection(db), data, "v1");

  // Mark a personal fact so we can prove a no-op sync doesn't touch it.
  db.prepare(
    "INSERT INTO species_personal (species_slug, profile_id, registered, xxl, xxs, purified) VALUES ('bulbasaur', (SELECT id FROM profile LIMIT 1), 1, 0, 0, 0)",
  ).run();

  await syncReferenceData(nodeSqliteConnection(db), data, "v1");

  const row = db.prepare("SELECT registered FROM species_personal WHERE species_slug = 'bulbasaur'").get() as { registered: number };
  assert.equal(row.registered, 1, "unchanged content shouldn't re-sync (and definitely shouldn't touch personal data)");
});

test("syncReferenceData quarantines personal rows whose slug no longer exists in the new reference data", async () => {
  const db = await freshlyMigratedDb();
  await syncReferenceData(nodeSqliteConnection(db), fixture(["bulbasaur", "charmander"]), "v1");
  db.prepare(
    "INSERT INTO species_personal (species_slug, profile_id, registered, xxl, xxs, purified) VALUES ('charmander', (SELECT id FROM profile LIMIT 1), 1, 0, 0, 0)",
  ).run();
  db.prepare(
    "INSERT INTO form_personal (form_slug, profile_id, caught) VALUES ('charmander-standard', (SELECT id FROM profile LIMIT 1), 1)",
  ).run();

  // A new reference.json content that drops charmander entirely (e.g. a
  // slug correction gone wrong, or a real removal) — content differs from
  // before, so this triggers a real re-sync.
  await syncReferenceData(nodeSqliteConnection(db), fixture(["bulbasaur"]), "v2");

  const remaining = db.prepare("SELECT species_slug FROM species_personal").all() as { species_slug: string }[];
  assert.deepEqual(remaining, [], "orphaned species_personal row should have been quarantined, not left dangling");

  const quarantined = (
    db.prepare("SELECT source_table, slug FROM personal_data_quarantine ORDER BY source_table").all() as {
      source_table: string;
      slug: string;
    }[]
  ).map((row) => ({ ...row }));
  assert.deepEqual(quarantined, [
    { source_table: "form_personal", slug: "charmander-standard" },
    { source_table: "species_personal", slug: "charmander" },
  ]);
});
