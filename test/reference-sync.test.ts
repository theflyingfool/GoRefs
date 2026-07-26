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
