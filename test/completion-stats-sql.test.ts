import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { getCompletionStatsSql } from "../src/data/completion-stats-sql";
import { nodeSqliteConnection } from "./node-sqlite-connection";

const PROFILE_A = "profile-a";
const PROFILE_B = "profile-b";

function seededDb(profileId: string = PROFILE_A): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE species (slug TEXT PRIMARY KEY, dex_number INTEGER, name TEXT, region_slug TEXT);
    CREATE TABLE form (slug TEXT PRIMARY KEY, species_slug TEXT, form_name TEXT, costume_name TEXT, regional_exclusive INTEGER);
    CREATE TABLE mega_variant (slug TEXT PRIMARY KEY, species_slug TEXT, variant TEXT);
    CREATE TABLE species_personal (species_slug TEXT NOT NULL, profile_id TEXT NOT NULL, registered INTEGER, PRIMARY KEY (profile_id, species_slug));
    CREATE TABLE form_personal (form_slug TEXT NOT NULL, profile_id TEXT NOT NULL, caught INTEGER, shiny INTEGER, PRIMARY KEY (profile_id, form_slug));
    CREATE TABLE mega_personal (mega_variant_slug TEXT NOT NULL, profile_id TEXT NOT NULL, evolved INTEGER, shiny_evolved INTEGER, PRIMARY KEY (profile_id, mega_variant_slug));

    INSERT INTO species VALUES ('bulbasaur', 1, 'Bulbasaur', 'kanto');
    INSERT INTO species VALUES ('ivysaur', 2, 'Ivysaur', 'kanto');
    INSERT INTO form VALUES ('bulbasaur-standard-male', 'bulbasaur', 'Standard', NULL, 0);
    INSERT INTO form VALUES ('bulbasaur-santa-hat-male', 'bulbasaur', 'Standard', 'Santa Hat', 0);
    -- Bulbasaur deliberately has BOTH a non-Gigantamax and a Gigantamax form
    -- at once — the case that exercises gigantamaxCompleteLens's EXISTS
    -- subquery correlating against the SAME "form" table reference used by
    -- the outer join, not a distinct alias like the original hand-written
    -- SQL's f/f2 split. Without this, a translation bug where the inner
    -- EXISTS accidentally bound to the outer row instead of its own
    -- correlated set would not be caught by this fixture.
    INSERT INTO form VALUES ('bulbasaur-gigantamax-male', 'bulbasaur', 'Gigantamax', NULL, 0);
    INSERT INTO form VALUES ('ivysaur-standard-male', 'ivysaur', 'Standard', NULL, 0);
    INSERT INTO mega_variant VALUES ('bulbasaur-mega', 'bulbasaur', NULL);

    INSERT INTO species_personal VALUES ('bulbasaur', '${profileId}', 1);
    INSERT INTO form_personal VALUES ('bulbasaur-standard-male', '${profileId}', 1, 1);
    INSERT INTO mega_personal VALUES ('bulbasaur-mega', '${profileId}', 0, 0);
  `);
  return db;
}

test("registered lens: global scope", async () => {
  const db = nodeSqliteConnection(seededDb());
  const [result] = await getCompletionStatsSql(db, PROFILE_A, { kind: "global" }, [{ kind: "registered" }], false);
  assert.equal(result.total, 2);
  assert.equal(result.complete, 1);
  assert.deepEqual(result.missingSpecies, [{ slug: "ivysaur", name: "Ivysaur", dexNumber: 2 }]);
});

test("formComplete lens: costumes excluded from the denominator", async () => {
  const db = nodeSqliteConnection(seededDb());
  const [result] = await getCompletionStatsSql(db, PROFILE_A, { kind: "global" }, [{ kind: "formComplete" }], false);
  assert.equal(result.total, 2);
  assert.equal(result.complete, 1); // bulbasaur's standard form is caught; ivysaur's isn't
});

test("costumeComplete lens: denominator is species with a costume only", async () => {
  const db = nodeSqliteConnection(seededDb());
  const [result] = await getCompletionStatsSql(db, PROFILE_A, { kind: "global" }, [{ kind: "costumeComplete" }], false);
  assert.equal(result.total, 1); // only bulbasaur has a costume form
  assert.equal(result.complete, 0); // santa-hat form was never caught
});

test("megaComplete lens: not-evolved species reported missing", async () => {
  const db = nodeSqliteConnection(seededDb());
  const [result] = await getCompletionStatsSql(db, PROFILE_A, { kind: "global" }, [{ kind: "megaComplete" }], false);
  assert.equal(result.total, 1);
  assert.equal(result.complete, 0);
});

test("achievement lens: caught field", async () => {
  const db = nodeSqliteConnection(seededDb());
  const [result] = await getCompletionStatsSql(db, PROFILE_A, { kind: "global" }, [{ kind: "achievement", field: "caught" }], false);
  assert.equal(result.total, 2);
  assert.equal(result.complete, 1);
});

test("region scope filters species", async () => {
  const db = nodeSqliteConnection(seededDb());
  const [result] = await getCompletionStatsSql(db, PROFILE_A, { kind: "region", regionSlug: "kanto" }, [{ kind: "registered" }], false);
  assert.equal(result.total, 2);
});

test("gigantamaxComplete lens: denominator is species with a Gigantamax form only, EXISTS correlates correctly against its own form row not the outer join's", async () => {
  const db = nodeSqliteConnection(seededDb());
  const [result] = await getCompletionStatsSql(db, PROFILE_A, { kind: "global" }, [{ kind: "gigantamaxComplete" }], false);
  // Only bulbasaur has a Gigantamax form (alongside its non-Gigantamax
  // forms) — ivysaur has none, so it's excluded from the denominator, not
  // counted as either complete or missing.
  assert.equal(result.total, 1);
  assert.equal(result.complete, 0); // the Gigantamax form itself was never caught
  assert.deepEqual(result.missingSpecies, [{ slug: "bulbasaur", name: "Bulbasaur", dexNumber: 1 }]);
});

test("megaShinyComplete lens: not-shiny-evolved species reported missing", async () => {
  const db = nodeSqliteConnection(seededDb());
  const [result] = await getCompletionStatsSql(db, PROFILE_A, { kind: "global" }, [{ kind: "megaShinyComplete" }], false);
  assert.equal(result.total, 1);
  assert.equal(result.complete, 0);
});

test("species scope narrows every lens to a single species", async () => {
  const db = nodeSqliteConnection(seededDb());
  const [registered, gigantamax, megaShiny] = await getCompletionStatsSql(
    db,
    PROFILE_A,
    { kind: "species", speciesSlug: "bulbasaur" },
    [{ kind: "registered" }, { kind: "gigantamaxComplete" }, { kind: "megaShinyComplete" }],
    false,
  );
  assert.equal(registered.total, 1);
  assert.equal(registered.complete, 1);
  assert.equal(gigantamax.total, 1);
  assert.equal(gigantamax.complete, 0);
  assert.equal(megaShiny.total, 1);
  assert.equal(megaShiny.complete, 0);
});

test("registered lens is isolated per profile: an unfiltered leftJoin would fan out and double-count across profiles", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE species (slug TEXT PRIMARY KEY, dex_number INTEGER, name TEXT, region_slug TEXT);
    CREATE TABLE form (slug TEXT PRIMARY KEY, species_slug TEXT, form_name TEXT, costume_name TEXT, regional_exclusive INTEGER);
    CREATE TABLE mega_variant (slug TEXT PRIMARY KEY, species_slug TEXT, variant TEXT);
    CREATE TABLE species_personal (species_slug TEXT NOT NULL, profile_id TEXT NOT NULL, registered INTEGER, PRIMARY KEY (profile_id, species_slug));
    CREATE TABLE form_personal (form_slug TEXT NOT NULL, profile_id TEXT NOT NULL, caught INTEGER, shiny INTEGER, PRIMARY KEY (profile_id, form_slug));
    CREATE TABLE mega_personal (mega_variant_slug TEXT NOT NULL, profile_id TEXT NOT NULL, evolved INTEGER, shiny_evolved INTEGER, PRIMARY KEY (profile_id, mega_variant_slug));

    INSERT INTO species VALUES ('bulbasaur', 1, 'Bulbasaur', 'kanto');
    INSERT INTO species VALUES ('ivysaur', 2, 'Ivysaur', 'kanto');

    -- Same species_slug ('bulbasaur'), two different profiles, DIFFERENT
    -- registered values. An unfiltered leftJoin (pre-fix) would match BOTH
    -- rows for every query regardless of which profile is asked about,
    -- fanning the single 'bulbasaur' species row out into two joined rows
    -- (one registered=1, one registered=0) and corrupting the count.
    INSERT INTO species_personal VALUES ('bulbasaur', '${PROFILE_A}', 1);
    INSERT INTO species_personal VALUES ('bulbasaur', '${PROFILE_B}', 0);
  `);
  const conn = nodeSqliteConnection(db);

  const [forA] = await getCompletionStatsSql(conn, PROFILE_A, { kind: "global" }, [{ kind: "registered" }], false);
  const [forB] = await getCompletionStatsSql(conn, PROFILE_B, { kind: "global" }, [{ kind: "registered" }], false);

  // Profile A registered bulbasaur; profile B did not. Each profile's view
  // must reflect only its own row for the shared species slug.
  assert.equal(forA.total, 2);
  assert.equal(forA.complete, 1);
  assert.deepEqual(forA.missingSpecies, [{ slug: "ivysaur", name: "Ivysaur", dexNumber: 2 }]);

  assert.equal(forB.total, 2);
  assert.equal(forB.complete, 0);
  assert.deepEqual(
    forB.missingSpecies.map((s) => s.slug).sort(),
    ["bulbasaur", "ivysaur"],
  );

  // The two profiles' results must differ — this is what actually proves
  // the join's profile filter isolates them, not merely that the query runs.
  assert.notDeepEqual(forA, forB);
});

test("formComplete and megaComplete lenses are isolated per profile too (guards the formPersonal/megaPersonal joins, not just speciesPersonal)", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE species (slug TEXT PRIMARY KEY, dex_number INTEGER, name TEXT, region_slug TEXT);
    CREATE TABLE form (slug TEXT PRIMARY KEY, species_slug TEXT, form_name TEXT, costume_name TEXT, regional_exclusive INTEGER);
    CREATE TABLE mega_variant (slug TEXT PRIMARY KEY, species_slug TEXT, variant TEXT);
    CREATE TABLE species_personal (species_slug TEXT NOT NULL, profile_id TEXT NOT NULL, registered INTEGER, PRIMARY KEY (profile_id, species_slug));
    CREATE TABLE form_personal (form_slug TEXT NOT NULL, profile_id TEXT NOT NULL, caught INTEGER, shiny INTEGER, PRIMARY KEY (profile_id, form_slug));
    CREATE TABLE mega_personal (mega_variant_slug TEXT NOT NULL, profile_id TEXT NOT NULL, evolved INTEGER, shiny_evolved INTEGER, PRIMARY KEY (profile_id, mega_variant_slug));

    INSERT INTO species VALUES ('bulbasaur', 1, 'Bulbasaur', 'kanto');
    INSERT INTO form VALUES ('bulbasaur-standard-male', 'bulbasaur', 'Standard', NULL, 0);
    INSERT INTO mega_variant VALUES ('bulbasaur-mega', 'bulbasaur', NULL);

    -- Profile A caught the standard form and evolved the mega; profile B did
    -- neither, for the SAME form_slug/mega_variant_slug rows.
    INSERT INTO form_personal VALUES ('bulbasaur-standard-male', '${PROFILE_A}', 1, 0);
    INSERT INTO form_personal VALUES ('bulbasaur-standard-male', '${PROFILE_B}', 0, 0);
    INSERT INTO mega_personal VALUES ('bulbasaur-mega', '${PROFILE_A}', 1, 0);
    INSERT INTO mega_personal VALUES ('bulbasaur-mega', '${PROFILE_B}', 0, 0);
  `);
  const conn = nodeSqliteConnection(db);

  const [formForA, megaForA] = await getCompletionStatsSql(conn, PROFILE_A, { kind: "global" }, [{ kind: "formComplete" }, { kind: "megaComplete" }], false);
  const [formForB, megaForB] = await getCompletionStatsSql(conn, PROFILE_B, { kind: "global" }, [{ kind: "formComplete" }, { kind: "megaComplete" }], false);

  assert.equal(formForA.complete, 1);
  assert.equal(formForB.complete, 0);
  assert.equal(megaForA.complete, 1);
  assert.equal(megaForB.complete, 0);
});
